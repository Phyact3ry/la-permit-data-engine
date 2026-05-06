/**
 * socrata-permits-fetcher.ts — Socrata SODA API permits fetcher
 *
 * Dataset: data.lacity.org/resource/vdg9-hy7c.json
 *          (LA City Building and Safety Permit Information — detailed)
 *
 * Field names verified 2026-04-28 against live API.
 *
 * Why vdg9-hy7c (not pi9x-tg5x):
 *   vdg9-hy7c has contractor_address, contractor_city, contractors_business_name,
 *   and license (CSLB number) — all required for A3 D1 lookup.
 *   pi9x-tg5x has zero contractor fields.
 *
 * Fields NOT in vdg9-hy7c: adu_changed, junior_adu, ev, solar, cofo_date,
 *   expiry_date, plan_check_*  → stored as null/false.
 *   ADU classification is handled by Claude Haiku (step 4) via work_description.
 *
 * Public API:
 *   fetchPermitsPage(opts)          — fetch one page, returns raw Socrata records
 *   fetchAllPermits(opts)           — paginate until done, yields batches
 *   mapSocrataPermit(raw)           — raw record → NewPermit
 *   upsertPermits(permits)          — drizzle upsert to permits table
 *   classifyUnclassifiedPermits()   — Claude Haiku: work_description → project_category_ai
 */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "./db";
import { permits, type NewPermit, type ProjectCategory } from "../schema";
import { eq, sql } from "drizzle-orm";

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const SOCRATA_BASE_URL = "https://data.lacity.org/resource/vdg9-hy7c.json";
const PAGE_SIZE = 1_000;
const CLASSIFY_BATCH_SIZE = 50;

// vdg9-hy7c Socrata field names (verified 2026-04-28)
const F = {
  permit_number:    "pcis_permit",
  // Permit site address is split; combine in buildFullPermitAddress()
  address_start:    "address_start",    // house number
  street_direction: "street_direction", // N | S | E | W (optional)
  street_name:      "street_name",
  street_suffix:    "street_suffix",    // AVE | ST | BLVD | etc.
  zip:              "zip_code",
  work_description: "work_description",
  permit_type:      "permit_type",
  permit_sub_type:  "permit_sub_type",
  status:           "latest_status",
  status_date:      "status_date",
  valuation:        "valuation",
  sqft:             "floor_area_l_a_zoning_code_definition",
  stories:          "of_stories",
  issued_date:      "issue_date",
  contractor_name:  "contractors_business_name",
  contractor_addr:  "contractor_address",
  contractor_city:  "contractor_city",  // stored in rawSocrata; used by A3 for D1 key
  applicant_first:  "applicant_first_name",
  applicant_last:   "applicant_last_name",
  updated_at:       ":updated_at",      // Socrata system field — delta cursor
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface SocrataPermitRaw {
  [key: string]: string | undefined;
}

export interface FetchPermitsPageOptions {
  offset: number;
  lastRunAt?: string | null;
  pageSize?: number;
  appToken?: string;
}

export interface FetchAllPermitsOptions extends Omit<FetchPermitsPageOptions, "offset"> {
  startOffset?: number;
  onPage?: (page: SocrataPermitRaw[], pageNum: number) => Promise<void> | void;
  maxPages?: number;
}

// ─── FETCH LAYER ──────────────────────────────────────────────────────────────

export async function fetchPermitsPage({
  offset,
  lastRunAt,
  pageSize = PAGE_SIZE,
  appToken,
}: FetchPermitsPageOptions): Promise<SocrataPermitRaw[]> {
  const params = new URLSearchParams({
    $limit:  String(pageSize),
    $offset: String(offset),
    $order:  ":id",
  });

  if (lastRunAt) {
    params.set("$where", `${F.updated_at} > '${lastRunAt}'`);
  }

  const url = `${SOCRATA_BASE_URL}?${params}`;

  const headers: HeadersInit = { Accept: "application/json" };
  if (appToken) headers["X-App-Token"] = appToken;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Socrata permits fetch failed [${res.status}]: ${res.statusText}\n${body}`
    );
  }

  return res.json() as Promise<SocrataPermitRaw[]>;
}

export async function fetchAllPermits({
  lastRunAt,
  startOffset = 0,
  pageSize = PAGE_SIZE,
  appToken,
  onPage,
  maxPages,
}: FetchAllPermitsOptions): Promise<number> {
  let offset = startOffset;
  let pageNum = 0;
  let totalFetched = 0;

  while (true) {
    if (maxPages !== undefined && pageNum >= maxPages) {
      console.info(`[socrata-permits] Reached maxPages=${maxPages} cap, stopping.`);
      break;
    }

    const page = await fetchPermitsPage({ offset, lastRunAt, pageSize, appToken });
    if (page.length === 0) break;

    totalFetched += page.length;
    pageNum++;

    if (onPage) await onPage(page, pageNum);
    if (page.length < pageSize) break;

    offset += pageSize;
  }

  return totalFetched;
}

// ─── MAPPING ──────────────────────────────────────────────────────────────────

function parseBoolean(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["y", "yes", "1", "true"].includes(raw.trim().toLowerCase());
}

function parseDollars(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/[$,\s]/g, ""));
  return isNaN(n) ? null : Math.round(n);
}

function parseIntField(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw.replace(/,/g, ""), 10);
  return isNaN(n) ? null : n;
}

function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  if (/^\d{2}\/\d{2}\/\d{4}/.test(raw)) {
    const [m, d, y] = raw.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

/**
 * Build full permit site address from vdg9-hy7c split fields.
 * Example: address_start="1663" + street_direction="S" + street_name="FAIRFAX" + street_suffix="AVE"
 * → "1663 S FAIRFAX AVE"
 */
function buildFullPermitAddress(raw: SocrataPermitRaw): string | null {
  const parts = [
    raw[F.address_start]?.trim(),
    raw[F.street_direction]?.trim(),
    raw[F.street_name]?.trim(),
    raw[F.street_suffix]?.trim(),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Map a raw vdg9-hy7c record → NewPermit (Drizzle insert shape).
 *
 * Note: rawSocrata.contractor_city and rawSocrata.license (CSLB number)
 * are preserved in rawSocrata for A3 use (D1 key building + exact license match).
 */
export function mapSocrataPermit(raw: SocrataPermitRaw): NewPermit | null {
  const permitNumber = raw[F.permit_number]?.trim();
  if (!permitNumber) return null;

  const applicantFirst = raw[F.applicant_first]?.trim() ?? "";
  const applicantLast  = raw[F.applicant_last]?.trim() ?? "";
  const applicantName  = [applicantFirst, applicantLast].filter(Boolean).join(" ") || null;

  return {
    permitNumber,
    city:               "LA City",
    address:            buildFullPermitAddress(raw),
    addressZip:         raw[F.zip]?.trim() ?? null,
    permitType:         raw[F.permit_type]?.trim() ?? null,
    permitSubType:      raw[F.permit_sub_type]?.trim() ?? null,
    status:             raw[F.status]?.trim() ?? null,
    statusDate:         parseDate(raw[F.status_date]),
    workDescription:    raw[F.work_description]?.trim() ?? null,
    projectCategoryAi:  null,   // populated by Claude Haiku step
    valuationUsd:       parseDollars(raw[F.valuation]),
    totalSqft:          parseIntField(raw[F.sqft]),
    numberOfStories:    parseIntField(raw[F.stories]),
    occupancyType:      raw[F.permit_sub_type]?.trim() ?? null,
    issuedDate:         parseDate(raw[F.issued_date]),
    expirationDate:     null,   // not in vdg9-hy7c
    finaledDate:        null,   // not in vdg9-hy7c
    planCheckDate:      null,   // not in vdg9-hy7c
    planCheckCorrections: null, // not in vdg9-hy7c
    contractorName:     raw[F.contractor_name]?.trim() ?? null,
    contractorAddress:  raw[F.contractor_addr]?.trim() ?? null,  // street only; city in rawSocrata
    contractorId:       null,   // resolved by A3 (link-permits-to-contractors)
    applicantName,
    // vdg9-hy7c has no ADU/EV/solar boolean flags.
    // Claude Haiku classifies ADU via work_description in step 4.
    aduFlag:            false,
    juniAdUFlag:        false,
    ownerBuilderFlag:   false,
    evCharger:          false,
    solar:              false,
    socrataUpdatedAt:   raw[F.updated_at]?.trim() ?? null,
    rawSocrata:         raw,    // rawSocrata.license = CSLB, rawSocrata.contractor_city for A3
  };
}

// ─── UPSERT ───────────────────────────────────────────────────────────────────

// Supabase Transaction Pooler rejects very large statements.
// rawSocrata JSONB ~1KB/record → 1000 records = ~1MB per query → too large.
// 100 records × ~1KB = ~100KB per statement — safely within limits.
const UPSERT_CHUNK = 100;

export async function upsertPermits(records: NewPermit[]): Promise<number> {
  if (records.length === 0) return 0;

  // SET TRANSACTION READ WRITE as first statement overrides the session-level
  // default_transaction_read_only that pgBouncer (Supabase Transaction Pooler)
  // can carry over from a previously recycled server connection.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ WRITE`);

    for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
      const raw = records.slice(i, i + UPSERT_CHUNK);
      // Deduplicate within chunk — Socrata sometimes returns the same permit_number
      // twice on one page; PostgreSQL rejects ON CONFLICT DO UPDATE on the same row twice.
      const chunk = [...new Map(raw.map((p) => [p.permitNumber, p])).values()];
      await tx
        .insert(permits)
        .values(chunk)
        .onConflictDoUpdate({
          target: permits.permitNumber,
          set: {
            city:                 sql`excluded.city`,
            address:              sql`excluded.address`,
            addressZip:           sql`excluded.address_zip`,
            permitType:           sql`excluded.permit_type`,
            permitSubType:        sql`excluded.permit_sub_type`,
            status:               sql`excluded.status`,
            statusDate:           sql`excluded.status_date`,
            workDescription:      sql`excluded.work_description`,
            valuationUsd:         sql`excluded.valuation_usd`,
            totalSqft:            sql`excluded.total_sqft`,
            numberOfStories:      sql`excluded.number_of_stories`,
            occupancyType:        sql`excluded.occupancy_type`,
            issuedDate:           sql`excluded.issued_date`,
            expirationDate:       sql`excluded.expiration_date`,
            finaledDate:          sql`excluded.finaled_date`,
            planCheckDate:        sql`excluded.plan_check_date`,
            planCheckCorrections: sql`excluded.plan_check_corrections`,
            contractorName:       sql`excluded.contractor_name`,
            contractorAddress:    sql`excluded.contractor_address`,
            applicantName:        sql`excluded.applicant_name`,
            aduFlag:              sql`excluded.adu_flag`,
            juniAdUFlag:          sql`excluded.jadu_flag`,
            ownerBuilderFlag:     sql`excluded.owner_builder_flag`,
            evCharger:            sql`excluded.ev_charger`,
            solar:                sql`excluded.solar`,
            socrataUpdatedAt:     sql`excluded.socrata_updated_at`,
            rawSocrata:           sql`excluded.raw_socrata`,
            updatedAt:            sql`now()`,
            // project_category_ai and classified_at are NOT overwritten here —
            // set independently by LLM step, must not regress on re-ingest.
          },
        });
    }
  });

  return records.length;
}

// ─── LLM CLASSIFICATION ───────────────────────────────────────────────────────

const VALID_CATEGORIES: ProjectCategory[] = [
  "ADU", "JADU", "Kitchen", "Bathroom", "Addition", "Ground-Up",
  "Remodel", "Tenant-Improvement", "Solar", "EV-Charger",
  "Pool-Spa", "Demolition", "Grading", "Mechanical", "Electrical",
  "Plumbing", "Re-Roof", "Fire-Sprinkler", "Other",
];

const CATEGORY_LIST = VALID_CATEGORIES.join(" | ");

const CLASSIFY_SYSTEM_PROMPT = `You are a construction permit classification assistant for LA City building permits.
Classify each work description into exactly one of these categories:
${CATEGORY_LIST}

Rules:
- ADU: Accessory Dwelling Unit construction (new separate unit)
- JADU: Junior ADU (≤500 sqft, within existing structure)
- Kitchen: Kitchen remodel/addition only (no new units)
- Bathroom: Bathroom remodel/addition only
- Addition: Adding square footage to existing structure (not ADU)
- Ground-Up: New construction from scratch
- Remodel: General interior remodel (no room-specific or sqft additions)
- Tenant-Improvement: Commercial/mixed-use tenant build-out
- Solar: Solar panel installation
- EV-Charger: EV charging station installation
- Pool-Spa: Swimming pool or spa
- Demolition: Demolish structure
- Grading: Site grading / earthwork
- Mechanical: HVAC only (no other work)
- Electrical: Electrical panel/wiring only
- Plumbing: Plumbing only
- Re-Roof: Roofing only
- Fire-Sprinkler: Fire suppression systems
- Other: Anything that doesn't clearly fit above

Respond ONLY with a JSON array, one entry per input, in the same order.
Each entry: { "index": <number>, "category": "<Category>" }
No markdown, no explanation, just the JSON array.`;

async function classifyBatchWithLLM(
  batch: Array<{ index: number; permitNumber: string; workDescription: string }>,
  client: Anthropic
): Promise<Map<string, ProjectCategory>> {
  const result = new Map<string, ProjectCategory>();
  if (batch.length === 0) return result;

  const userContent = batch
    .map((b) => `${b.index}. ${b.workDescription || "(no description)"}`)
    .join("\n");

  let text: string;
  try {
    const msg = await client.messages.create({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      system:     CLASSIFY_SYSTEM_PROMPT,
      messages:   [{ role: "user", content: userContent }],
    });
    text = msg.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("");
  } catch (err) {
    console.error("[classify] Claude API error:", (err as Error).message);
    return result;
  }

  try {
    const json = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
    const parsed = JSON.parse(json) as Array<{ index: number; category: string }>;

    for (const entry of parsed) {
      const item = batch.find((b) => b.index === entry.index);
      if (!item) continue;
      const cat = entry.category as ProjectCategory;
      result.set(item.permitNumber, VALID_CATEGORIES.includes(cat) ? cat : "Other");
    }
  } catch {
    console.error("[classify] Failed to parse LLM response:", text.slice(0, 200));
  }

  return result;
}

export async function classifyUnclassifiedPermits(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set — cannot classify permits");
  }

  const client = new Anthropic({ apiKey });
  let totalClassified = 0;
  let globalIndex = 0;

  while (true) {
    const batch = await db
      .select({
        permitNumber:    permits.permitNumber,
        workDescription: permits.workDescription,
      })
      .from(permits)
      .where(
        sql`${permits.projectCategoryAi} IS NULL AND ${permits.workDescription} IS NOT NULL`
      )
      .limit(CLASSIFY_BATCH_SIZE)
      .offset(globalIndex); // advance past previously-attempted records to avoid infinite loop

    if (batch.length === 0) break;

    const llmInput = batch.map((p, i) => ({
      index:           i, // local 0-based index for LLM response matching
      permitNumber:    p.permitNumber,
      workDescription: p.workDescription ?? "",
    }));

    const categories = await classifyBatchWithLLM(llmInput, client);

    if (categories.size > 0) {
      const entries = [...categories.entries()];
      const valuesSql = sql.join(
        entries.map(([pn, cat]) => sql`(${pn}, ${cat})`),
        sql`, `
      );
      await db.execute(sql`
        UPDATE permits
        SET project_category_ai = v.category::project_category,
            adu_flag            = v.category IN ('ADU', 'JADU'),
            classified_at       = now()
        FROM (VALUES ${valuesSql}) AS v(permit_number, category)
        WHERE permits.permit_number = v.permit_number
      `);
    }

    totalClassified += categories.size;
    globalIndex += batch.length;

    console.info(
      `[classify] Batch done — ${categories.size}/${batch.length} classified, total: ${totalClassified}`
    );

    if (batch.length < CLASSIFY_BATCH_SIZE) break;
  }

  return totalClassified;
}
