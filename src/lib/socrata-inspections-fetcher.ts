/**
 * socrata-inspections-fetcher.ts — Socrata SODA API inspections fetcher
 *
 * Dataset: data.lacity.org/resource/9w5z-rg2h.json
 *          (LA City Building and Safety Inspections)
 *
 * Real fields verified 2026-04-23 against metadata endpoint:
 *   permit           — permit number string (e.g. "14044 10000 02293")
 *   address          — site address
 *   permit_status    — permit status at inspection time
 *   inspection_date  — date of inspection (ISO 8601 timestamp)
 *   inspection       — inspection type description
 *   inspection_result— result string (Approved / Disapproved / Partial Approval / etc.)
 *   lat_lon          — {latitude, longitude} nested object
 *   :updated_at      — Socrata system field (always present, used for delta mode)
 *
 * NOTE: No inspector_name, no correction comments, no inspection_number in this dataset.
 * Dedup key: (permit_ref, inspection_date, inspection_type) composite unique.
 *
 * Public API:
 *   fetchInspectionsPage(opts)   — fetch one page of raw Socrata records
 *   fetchAllInspections(opts)    — paginate until done, calls onPage per batch
 *   upsertInspections(records)   — drizzle upsert into inspections table
 */

import { db } from "./db";
import { inspections, type NewInspection } from "../schema";
import { sql } from "drizzle-orm";

// ─── CONFIGURATION ────────────────────────────────────────────────────────────

const SOCRATA_BASE_URL = "https://data.lacity.org/resource/9w5z-rg2h.json";
const PAGE_SIZE = 5_000;

/**
 * Socrata field names as they appear in the real API response.
 * Verified 2026-04-23 against:
 *   https://data.lacity.org/api/views/9w5z-rg2h.json  (column metadata)
 *
 * Common gotcha: the inspection type field is literally "inspection" (not "inspection_type").
 * The permit field is "permit" (not "permit_nbr" like in the permits dataset).
 */
const FIELD_NAMES = {
  permit:           "permit",            // permit number string
  address:          "address",
  permit_status:    "permit_status",
  inspection_date:  "inspection_date",   // ISO 8601 timestamp
  inspection_type:  "inspection",        // NOTE: field is called "inspection", not "inspection_type"
  inspection_result: "inspection_result",
  lat_lon:          "lat_lon",           // nested {latitude, longitude} object
  updated_at:       ":updated_at",       // Socrata system field (always present)
} as const;

// ─── TYPES ────────────────────────────────────────────────────────────────────

/** Raw record as returned by the Socrata SODA API */
export interface SocrataInspectionRaw {
  [key: string]: string | { latitude?: string; longitude?: string } | undefined;
}

export interface FetchInspectionsPageOptions {
  offset: number;
  /** ISO timestamp — only fetch records updated after this date (delta mode) */
  lastRunAt?: string | null;
  pageSize?: number;
  /** Socrata App Token for higher rate limits */
  appToken?: string;
}

export interface FetchAllInspectionsOptions
  extends Omit<FetchInspectionsPageOptions, "offset"> {
  startOffset?: number;
  /** Called for each page of raw records, before upsert */
  onPage?: (
    page: SocrataInspectionRaw[],
    pageNum: number
  ) => Promise<void> | void;
  maxPages?: number; // safety cap for first run / tests
}

// ─── FETCH LAYER ──────────────────────────────────────────────────────────────

/**
 * Fetch a single page of inspection records from the Socrata SODA API.
 *
 * Delta mode: when lastRunAt is provided, adds $where on :updated_at so we
 * only pull records changed since the last run.
 *
 * Docs: https://dev.socrata.com/docs/queries/
 */
const FETCH_MAX_RETRIES = 4;
const FETCH_RETRY_BASE_MS = 5_000; // 5s, 10s, 20s, 40s

export async function fetchInspectionsPage({
  offset,
  lastRunAt,
  pageSize = PAGE_SIZE,
  appToken,
}: FetchInspectionsPageOptions): Promise<SocrataInspectionRaw[]> {
  const params = new URLSearchParams({
    $limit:  String(pageSize),
    $offset: String(offset),
    // inspection_date is better indexed on 9w5z-rg2h than :id for deep offsets
    $order:  "inspection_date",
  });

  if (lastRunAt) {
    // SODA $where uses ISO 8601 — e.g. "2025-04-01T00:00:00.000"
    params.set(
      "$where",
      `${FIELD_NAMES.updated_at} > '${lastRunAt}'`
    );
  }

  const url = `${SOCRATA_BASE_URL}?${params}`;

  const headers: HeadersInit = { Accept: "application/json" };
  if (appToken) {
    headers["X-App-Token"] = appToken;
  }

  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(
        `[socrata-inspections] Retry ${attempt}/${FETCH_MAX_RETRIES} after ${delay}ms (offset=${offset})`
      );
      await new Promise((r) => setTimeout(r, delay));
    }

    const res = await fetch(url, { headers });

    if (res.ok) {
      return res.json() as Promise<SocrataInspectionRaw[]>;
    }

    const body = await res.text().catch(() => "");
    lastErr = new Error(
      `Socrata inspections fetch failed [${res.status}]: ${res.statusText}\n${body}`
    );

    // Only retry on 5xx (server errors); 4xx are our fault, no point retrying
    if (res.status < 500) throw lastErr;
  }

  throw lastErr!;
}

/**
 * Paginate through ALL matching inspections, calling onPage for each batch.
 * Returns total count of records fetched.
 */
export async function fetchAllInspections({
  lastRunAt,
  startOffset = 0,
  pageSize = PAGE_SIZE,
  appToken,
  onPage,
  maxPages,
}: FetchAllInspectionsOptions): Promise<number> {
  let offset = startOffset;
  let pageNum = 0;
  let totalFetched = 0;

  while (true) {
    if (maxPages !== undefined && pageNum >= maxPages) {
      console.info(
        `[socrata-inspections] Reached maxPages=${maxPages} cap, stopping.`
      );
      break;
    }

    const page = await fetchInspectionsPage({
      offset,
      lastRunAt,
      pageSize,
      appToken,
    });

    if (page.length === 0) break;

    totalFetched += page.length;
    pageNum++;

    if (onPage) {
      await onPage(page, pageNum);
    }

    if (page.length < pageSize) break; // last partial page

    offset += pageSize;
  }

  return totalFetched;
}

// ─── MAPPING ──────────────────────────────────────────────────────────────────

/** Convert Socrata date strings to "YYYY-MM-DD" or null */
function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  // Socrata returns "2016-07-20T00:00:00.000" — take the date part
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.slice(0, 10);
  }
  // MM/DD/YYYY fallback
  if (/^\d{2}\/\d{2}\/\d{4}/.test(raw)) {
    const [m, d, y] = raw.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  return raw;
}

/** Parse lat or lng from a string coordinate */
function parseCoord(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

/**
 * Map a raw Socrata inspection record → NewInspection (Drizzle insert shape).
 *
 * Returns null if the record is missing both permitRef and inspectionDate
 * (can't form a dedup key).
 */
export function mapSocrataInspection(
  raw: SocrataInspectionRaw
): NewInspection | null {
  const permitRefRaw = raw[FIELD_NAMES.permit];
  const inspectionDateRaw = raw[FIELD_NAMES.inspection_date];

  // These two are required to form the unique composite key
  if (
    typeof permitRefRaw !== "string" ||
    !permitRefRaw.trim() ||
    typeof inspectionDateRaw !== "string" ||
    !inspectionDateRaw.trim()
  ) {
    return null;
  }

  const permitRef = permitRefRaw.trim();
  const inspectionDate = parseDate(inspectionDateRaw);
  if (!inspectionDate) return null;

  // inspection_type — fall back to "Unknown" so the composite unique key works
  const inspectionTypeRaw = raw[FIELD_NAMES.inspection_type];
  const inspectionType =
    typeof inspectionTypeRaw === "string" && inspectionTypeRaw.trim()
      ? inspectionTypeRaw.trim()
      : "Unknown";

  // lat/lon — stored as nested {latitude, longitude} object in Socrata
  const latLon = raw[FIELD_NAMES.lat_lon];
  let lat: number | null = null;
  let lng: number | null = null;
  if (latLon && typeof latLon === "object") {
    lat = parseCoord(latLon.latitude);
    lng = parseCoord(latLon.longitude);
  }

  const updatedAt = raw[FIELD_NAMES.updated_at];

  return {
    permitRef,
    permitId:       null, // resolved via D1 cache (task 2.6)
    address:
      typeof raw[FIELD_NAMES.address] === "string"
        ? (raw[FIELD_NAMES.address] as string).trim()
        : null,
    permitStatus:
      typeof raw[FIELD_NAMES.permit_status] === "string"
        ? (raw[FIELD_NAMES.permit_status] as string).trim()
        : null,
    inspectionDate,
    inspectionType,
    inspectionResult:
      typeof raw[FIELD_NAMES.inspection_result] === "string"
        ? (raw[FIELD_NAMES.inspection_result] as string).trim()
        : null,
    lat,
    lng,
    // Computed fields — null until populated by later pipelines
    tradeCategoryAi:     null,
    correctionItemsAi:   null,
    isFinal:             null,
    wasFirstAttemptPass: null,
    retryCount:          null,
    sequencePosition:    null,
    daysSincePrevious:   null,
    // rawSocrata intentionally null for inspections: all fields are mapped above,
    // and storing 2M raw JSON blobs (~800MB) would exhaust Supabase storage/IO.
    rawSocrata:          null,
    socrataUpdatedAt:
      typeof updatedAt === "string" ? updatedAt.trim() : null,
  };
}

// ─── UPSERT ───────────────────────────────────────────────────────────────────

const UPSERT_CHUNK = 100;

/**
 * Upsert an array of mapped inspections into Supabase.
 * Conflict target: (permit_ref, inspection_date, inspection_type) composite unique.
 *
 * On conflict: update mutable fields, preserve computed analytics fields so
 * re-ingest doesn't reset trade_category_ai / correction_items_ai / etc.
 *
 * Returns count of records written.
 */
export async function upsertInspections(
  records: NewInspection[]
): Promise<number> {
  if (records.length === 0) return 0;

  // SET TRANSACTION READ WRITE overrides stale session-level read-only flag
  // that pgBouncer (Supabase Transaction Pooler) can carry on recycled connections.
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ WRITE`);

    for (let i = 0; i < records.length; i += UPSERT_CHUNK) {
      const raw = records.slice(i, i + UPSERT_CHUNK);
      // Deduplicate within chunk by composite key — same Socrata duplicate issue as permits.
      const chunk = [...new Map(raw.map((r) => [
        `${r.permitRef}|${r.inspectionDate}|${r.inspectionType}`, r
      ])).values()];
      await tx
        .insert(inspections)
        .values(chunk)
        .onConflictDoUpdate({
          target: [
            inspections.permitRef,
            inspections.inspectionDate,
            inspections.inspectionType,
          ],
          set: {
            address:          sql`excluded.address`,
            permitStatus:     sql`excluded.permit_status`,
            inspectionResult: sql`excluded.inspection_result`,
            lat:              sql`excluded.lat`,
            lng:              sql`excluded.lng`,
            rawSocrata:       sql`excluded.raw_socrata`,
            socrataUpdatedAt: sql`excluded.socrata_updated_at`,
            updatedAt:        sql`now()`,
            // Computed analytics fields are NOT overwritten here — they are set by
            // future computation pipelines and must survive re-ingest.
            // Fields NOT in this set: tradeCategoryAi, correctionItemsAi, isFinal,
            // wasFirstAttemptPass, retryCount, sequencePosition, daysSincePrevious
          },
        });
    }
  });

  return records.length;
}
