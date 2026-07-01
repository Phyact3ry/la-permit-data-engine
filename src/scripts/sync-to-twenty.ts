import * as dotenv from "dotenv";
dotenv.config();
import { db } from "../lib/db";
import { sql } from "drizzle-orm";

const TWENTY_URL = process.env.TWENTY_API_URL + "/graphql";
const TWENTY_TOKEN = process.env.TWENTY_API_TOKEN;

if (!process.env.TWENTY_API_URL || !TWENTY_TOKEN) {
  console.error("TWENTY_API_URL and TWENTY_API_TOKEN must be set in .env");
  process.exit(1);
}

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const resp = await fetch(TWENTY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TWENTY_TOKEN}`,
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

const TWENTY_BATCH = 200;

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

  // Fetch existing NoteTargets to avoid duplicates (Twenty has no natural-key upsert for NoteTargets)
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

async function main() {
  console.log("[B2] sync-to-twenty start");

  const contractorsResult = await db.execute(sql`
    SELECT id, business_name, owner_name, email, phone,
           address_street, address_city, address_state, address_zip,
           website, license_class, icp_score, icp_tier
    FROM contractors_enriched
    WHERE icp_tier IN ('A', 'B')
    ORDER BY icp_score DESC
    LIMIT 100
  `);
  const contractors = contractorsResult.rows as any[];
  console.log(`  fetched ${contractors.length} contractors`);

  const ids = contractors.map((c) => c.id);
  const hypothesesResult = await db.execute(sql`
    SELECT id, contractor_id, hook_line, body_text, rank
    FROM hypotheses
    WHERE contractor_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}])
    ORDER BY contractor_id, rank
  `);
  const hypotheses = hypothesesResult.rows as any[];
  console.log(`  fetched ${hypotheses.length} hypotheses`);

  console.log("\n  [1/4] createCompanies...");
  const companiesCount = await syncCompanies(contractors);
  console.log(`  → ${companiesCount} companies upserted`);

  console.log("\n  [2/4] createPersons (sequential)...");
  const personsResult = await syncPersons(contractors);
  console.log(`  → ${personsResult.ok} ok, ${personsResult.err} errors`);

  console.log("\n  [3/4] createNotes...");
  const notesCount = await syncNotes(hypotheses);
  console.log(`  → ${notesCount} notes upserted`);

  console.log("\n  [4/4] createNoteTargets...");
  const targetsCount = await syncNoteTargets(hypotheses);
  console.log(`  → ${targetsCount} note targets upserted`);

  console.log("\n[B2] done");
  console.log(`  companies: ${companiesCount}`);
  console.log(`  persons:   ${personsResult.ok}/${contractors.length}`);
  console.log(`  notes:     ${notesCount}`);
  console.log(`  targets:   ${targetsCount}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[B2] FATAL:", e.message);
    process.exit(1);
  });
