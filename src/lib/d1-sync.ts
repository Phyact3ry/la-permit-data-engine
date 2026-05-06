/**
 * d1-sync.ts — Cloudflare D1 address → contractor_id cache sync (task 2.6)
 *
 * D1 database: la-permit-leads
 * Account:     <your-cloudflare-account-id>
 * DB ID:       <your-d1-database-id>
 *
 * Table: address_contractor_cache
 *   address TEXT PRIMARY KEY  — normalized "street, city" (lowercase)
 *   contractor_id TEXT        — UUID from contractors_enriched.id
 *   cslb_license TEXT         — for dedup / debugging
 *   updated_at TEXT           — ISO timestamp of last write
 *
 * Why D1 and not Supabase directly:
 *   The Cloudflare Worker runs on the edge and needs a fast lookup
 *   (address → contractor_id) without a round-trip to Supabase on every permit
 *   ingest or signup auto-match. D1 is co-located with the Worker, sub-ms reads.
 *
 * Access from Node.js (Inngest pipelines) uses the Cloudflare REST API.
 * Workers use the D1 binding from wrangler.toml — no change needed there.
 *
 * Required env:
 *   CF_API_TOKEN  — Cloudflare API token with D1:Edit permission on the account.
 *                   Create at: dash.cloudflare.com → My Profile → API Tokens
 *                   Template: "Create custom token" → D1:Edit → Account resource
 *   CF_ACCOUNT_ID — Cloudflare account id
 *   CF_D1_DB_ID   — D1 database id
 */

const CF_ACCOUNT_ID  = process.env.CF_ACCOUNT_ID ?? "";
const CF_D1_DB_ID    = process.env.CF_D1_DB_ID ?? "";
const D1_QUERY_URL   = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DB_ID}/query`;

// 25 rows × 4 params = 100 positional params — within Cloudflare D1's REST API limit
const INSERT_CHUNK = 25;

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface D1SyncRecord {
  address:      string; // normalized street + city (lookup key)
  contractorId: string; // UUID from contractors_enriched.id
  cslbLicense:  string; // for debugging / dedup verification
}

interface D1ApiResponse {
  success: boolean;
  errors:  Array<{ code: number; message: string }>;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Normalize a contractor business address into the D1 cache key.
 * Combines street + city, lowercased. Returns null if street is empty.
 *
 * Example: ("2511 Beverly Blvd", "Los Angeles") → "2511 beverly blvd, los angeles"
 */
export function buildD1Address(
  street: string | null,
  city:   string | null
): string | null {
  const s = street?.trim();
  if (!s) return null;
  const parts = [s, city?.trim()].filter(Boolean);
  return parts.join(", ").toLowerCase();
}

async function d1Query(
  sql:    string,
  params: (string | null)[]
): Promise<void> {
  const token = process.env.CF_API_TOKEN;
  if (!token) throw new Error("CF_API_TOKEN is not set — add to .env");

  const res = await fetch(D1_QUERY_URL, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`D1 API [${res.status}]: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as D1ApiResponse;
  if (!json.success) {
    const msgs = json.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`D1 query failed — ${msgs}`);
  }
}

// ─── INTERNAL SELECT HELPER ──────────────────────────────────────────────────

// 100 addresses × 1 param = 100 positional params — within D1's REST API limit
const SELECT_CHUNK = 100;

interface D1SelectResponse<T> {
  success: boolean;
  errors:  Array<{ code: number; message: string }>;
  result:  Array<{ results: T[]; success: boolean }>;
}

async function d1QuerySelect<T extends Record<string, unknown>>(
  query:  string,
  params: (string | null)[]
): Promise<T[]> {
  const token = process.env.CF_API_TOKEN;
  if (!token) throw new Error("CF_API_TOKEN is not set — add to .env");

  const res = await fetch(D1_QUERY_URL, {
    method:  "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql: query, params }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`D1 API [${res.status}]: ${text.slice(0, 400)}`);
  }

  const json = (await res.json()) as D1SelectResponse<T>;
  if (!json.success) {
    const msgs = json.errors.map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`D1 query failed — ${msgs}`);
  }

  return json.result[0]?.results ?? [];
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Ensure the address_contractor_cache table exists in D1.
 * Safe to call on every pipeline run — CREATE TABLE IF NOT EXISTS is idempotent.
 */
export async function ensureD1Table(): Promise<void> {
  await d1Query(
    `CREATE TABLE IF NOT EXISTS address_contractor_cache (
       address       TEXT PRIMARY KEY,
       contractor_id TEXT NOT NULL,
       cslb_license  TEXT NOT NULL,
       updated_at    TEXT NOT NULL
     )`,
    []
  );
}

/**
 * Batch-upsert address → contractor_id records into D1.
 * Uses multi-row INSERT OR REPLACE (100 rows per HTTP request).
 *
 * Returns count of records synced.
 */
export async function syncContractorsToD1(
  records: D1SyncRecord[]
): Promise<number> {
  if (records.length === 0) return 0;

  let synced = 0;
  const now  = new Date().toISOString();

  for (let i = 0; i < records.length; i += INSERT_CHUNK) {
    const chunk = records.slice(i, i + INSERT_CHUNK);

    // Multi-row INSERT OR REPLACE — one HTTP call per chunk
    const placeholders = chunk.map(() => "(?, ?, ?, ?)").join(", ");
    const sql = `INSERT OR REPLACE INTO address_contractor_cache
      (address, contractor_id, cslb_license, updated_at)
      VALUES ${placeholders}`;

    const params: string[] = [];
    for (const r of chunk) {
      params.push(r.address, r.contractorId, r.cslbLicense, now);
    }

    await d1Query(sql, params);
    synced += chunk.length;
  }

  return synced;
}

/**
 * Batch-lookup contractor IDs from D1 address cache.
 * Returns Map<normalizedAddress → contractorId> for matched addresses only.
 * Caller must check CF_API_TOKEN before calling.
 */
export async function lookupContractorsByAddress(
  addresses: string[]
): Promise<Map<string, string>> {
  if (addresses.length === 0) return new Map();

  const result = new Map<string, string>();

  for (let i = 0; i < addresses.length; i += SELECT_CHUNK) {
    const chunk       = addresses.slice(i, i + SELECT_CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await d1QuerySelect<{ address: string; contractor_id: string }>(
      `SELECT address, contractor_id FROM address_contractor_cache WHERE address IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      result.set(row.address, row.contractor_id);
    }
  }

  return result;
}
