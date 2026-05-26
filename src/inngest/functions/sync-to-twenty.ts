import { inngest } from "../client";
import { db } from "../../lib/db";
import { pipelineState } from "../../schema";
import { eq, sql } from "drizzle-orm";

const PIPELINE_NAME = "sync-to-twenty";
const TWENTY_BATCH = 200;

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const url = process.env.TWENTY_API_URL + "/graphql";
  const token = process.env.TWENTY_API_TOKEN;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await resp.json()) as any;
  if (json.errors) throw new Error(JSON.stringify(json.errors, null, 2));
  return json.data as T;
}

async function personId(contractorId: string): Promise<string> {
  const data = new TextEncoder().encode("person:" + contractorId);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const b = new Uint8Array(hash);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].slice(0, 16).map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function parseOwnerName(name: string | null): { firstName: string; lastName: string } {
  const parts = (name ?? "").trim().split(/\s+/);
  return { firstName: parts[0] ?? "Unknown", lastName: parts.slice(1).join(" ") || "" };
}

async function syncCompanies(contractors: any[]): Promise<number> {
  const seenWebsites = new Set<string>();
  const data = contractors.map((ce) => {
    const input: any = {
      id: ce.id,
      name: ce.business_name,
      address: {
        addressStreet1: ce.address_street ?? "",
        addressCity: ce.address_city ?? "",
        addressState: ce.address_state ?? "CA",
        addressPostcode: ce.address_zip ?? "",
      },
      idealCustomerProfile: ce.icp_tier === "A" || ce.icp_tier === "B",
    };
    if (ce.website && !seenWebsites.has(ce.website)) {
      seenWebsites.add(ce.website);
      input.domainName = {
        primaryLinkUrl: ce.website,
        primaryLinkLabel: ce.business_name,
      };
    }
    return input;
  });

  const result = await gql<any>(
    `mutation CreateCompanies($data: [CompanyCreateInput!]!) {
      createCompanies(data: $data, upsert: true) { id name }
    }`,
    { data }
  );
  return result.createCompanies.length;
}

async function syncPersons(contractors: any[]): Promise<{ ok: number; err: number }> {
  let ok = 0;
  let err = 0;
  for (const ce of contractors) {
    try {
      const pid = await personId(ce.id);
      const input: any = {
        id: pid,
        companyId: ce.id,
        name: parseOwnerName(ce.owner_name),
        jobTitle: ce.license_class ? `CSLB ${ce.license_class} Contractor` : "Licensed Contractor",
      };
      if (ce.email) input.emails = { primaryEmail: ce.email };
      if (ce.phone) {
        input.phones = {
          primaryPhoneNumber: ce.phone,
          primaryPhoneCountryCode: "US",
          primaryPhoneCallingCode: "+1",
        };
      }
      await gql<any>(
        `mutation CreatePerson($data: PersonCreateInput!) {
          createPerson(data: $data, upsert: true) { id }
        }`,
        { data: input }
      );
      ok++;
    } catch (e: any) {
      console.error(`  [person] ${ce.id} (${ce.business_name}): ${e.message}`);
      err++;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok, err };
}

async function syncNotes(hypotheses: any[]): Promise<number> {
  if (hypotheses.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < hypotheses.length; i += TWENTY_BATCH) {
    const chunk = hypotheses.slice(i, i + TWENTY_BATCH);
    const data = chunk.map((hyp) => ({
      id: hyp.id,
      title: hyp.hook_line,
      bodyV2: {
        markdown: hyp.body_text,
        blocknote: JSON.stringify([{
          type: "paragraph",
          content: [{ type: "text", text: hyp.body_text }],
        }]),
      },
    }));
    const result = await gql<any>(
      `mutation CreateNotes($data: [NoteCreateInput!]!) {
        createNotes(data: $data, upsert: true) { id title }
      }`,
      { data }
    );
    total += result.createNotes.length;
  }
  return total;
}

async function syncNoteTargets(hypotheses: any[]): Promise<number> {
  if (hypotheses.length === 0) return 0;

  const existingSet = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    const result: any = await gql<any>(`
      query($after: String) {
        noteTargets(first: 200, after: $after) {
          edges { node { noteId companyId } cursor }
          pageInfo { hasNextPage endCursor }
        }
      }
    `, { after: cursor });
    for (const e of result.noteTargets.edges) {
      existingSet.add(`${e.node.noteId}:${e.node.companyId}`);
    }
    if (!result.noteTargets.pageInfo.hasNextPage) break;
    cursor = result.noteTargets.pageInfo.endCursor;
  }

  const missing = hypotheses.filter((hyp) => !existingSet.has(`${hyp.id}:${hyp.contractor_id}`));
  if (missing.length === 0) return 0;

  let total = 0;
  for (let i = 0; i < missing.length; i += TWENTY_BATCH) {
    const chunk = missing.slice(i, i + TWENTY_BATCH);
    const data = chunk.map((hyp) => ({ noteId: hyp.id, companyId: hyp.contractor_id }));
    const result = await gql<any>(
      `mutation CreateNoteTargets($data: [NoteTargetCreateInput!]!) {
        createNoteTargets(data: $data, upsert: true) { id }
      }`,
      { data }
    );
    total += result.createNoteTargets.length;
  }
  return total;
}

export const syncToTwenty = inngest.createFunction(
  {
    id: "sync-to-twenty",
    name: "Sync to Twenty CRM",
    retries: 3,
    triggers: [
      { cron: "0 8 * * 2" },
      { event: "twenty/sync" },
    ],
  },
  async ({ step, logger }) => {
    await step.run("mark-running", async () => {
      await db
        .insert(pipelineState)
        .values({ pipelineName: PIPELINE_NAME, status: "running", recordsProcessed: 0, error: null })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: { status: "running", recordsProcessed: 0, error: null },
        });
      logger.info("[sync-to-twenty] Pipeline started");
    });

    const contractors = await step.run("sync-companies", async () => {
      const result = await db.execute(sql`
        SELECT id, business_name, owner_name, email, phone,
               address_street, address_city, address_state, address_zip,
               website, license_class, icp_score, icp_tier
        FROM contractors_enriched
        WHERE icp_tier IN ('A', 'B')
        ORDER BY icp_score DESC
        LIMIT 100
      `);
      const rows = result.rows as any[];
      const count = await syncCompanies(rows);
      logger.info(`[sync-to-twenty] Companies: ${count} upserted`);
      return rows;
    });

    await step.run("sync-persons", async () => {
      const result = await syncPersons(contractors);
      logger.info(`[sync-to-twenty] Persons: ${result.ok} ok, ${result.err} errors`);
      return result;
    });

    const hypotheses = await step.run("sync-notes", async () => {
      const ids = contractors.map((c: any) => c.id);
      const hypResult = await db.execute(sql`
        SELECT id, contractor_id, hook_line, body_text, rank
        FROM hypotheses
        WHERE contractor_id = ANY(ARRAY[${sql.join(ids.map((id: string) => sql`${id}`), sql`, `)}])
        ORDER BY contractor_id, rank
      `);
      const rows = hypResult.rows as any[];
      const count = await syncNotes(rows);
      logger.info(`[sync-to-twenty] Notes: ${count} upserted`);
      return rows;
    });

    await step.run("sync-note-targets", async () => {
      const count = await syncNoteTargets(hypotheses);
      logger.info(`[sync-to-twenty] NoteTargets: ${count} created`);
      return count;
    });

    await step.run("update-state-done", async () => {
      await db
        .update(pipelineState)
        .set({
          status: "done",
          lastRunAt: new Date(),
          recordsProcessed: contractors.length,
          error: null,
        })
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      logger.info(`[sync-to-twenty] Done — ${contractors.length} contractors synced`);
    });

    return { processed: contractors.length };
  }
);
