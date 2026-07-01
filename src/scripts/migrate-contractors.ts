/**
 * migrate-contractors.ts
 *
 * Migrates contractors from contractors_data.json (old SQLite export, 23,400 records)
 * into the new Supabase contractors_enriched table.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-contractors.ts            # full migration
 *   npx tsx src/scripts/migrate-contractors.ts --test     # 1 record: license 929941
 *   npx tsx src/scripts/migrate-contractors.ts --dry-run  # count + preview, no writes
 *
 * Field mapping summary (old → new):
 *   cslb_license_number    → cslb_license        (REQUIRED — skip if missing)
 *   company_name           → business_name       (REQUIRED — skip if missing)
 *   owner_name             → owner_name
 *   phone                  → phone               (coerced to string)
 *   email / contact_email  → email               (email preferred, contact_email as fallback)
 *   website                → website
 *   address (street part)  → address_street      (first segment before comma)
 *   city                   → address_city
 *   zip                    → address_zip         (coerced to string)
 *   hardcoded              → address_state = "CA"
 *   license_class          → license_class
 *   license_status         → license_status      (ACTIVE→active, etc.)
 *   license_expiration     → license_expiry      (MM/DD/YYYY → YYYY-MM-DD)
 *   derived                → has_active_license  (license_status === "ACTIVE")
 *   google_rating          → google_rating
 *   google_review_count    → review_count
 *   social_links (JSON str)→ social_links        (parsed to JSONB)
 *   company_size_ai        → company_size_ai
 *   years_in_business      → years_in_business
 *   specializations(JSON)  → specializations_ai  (parsed to JSONB)
 *   permit_count           → permit_count_total
 *   permit_total_valuation → total_project_valuation (rounded to integer USD)
 *   permit_avg_valuation   → avg_project_valuation   (rounded to integer USD)
 *   icp_score              → icp_score
 *   derived                → icp_tier            (A≥75, B≥50, C≥25, D<25)
 *   first_seen_at          → created_at
 *   updated_at             → updated_at
 *   max(website_scraped_at, permits_enriched_at, updated_at) → last_enriched_at
 *
 * Fields NOT migrated (not present in new schema):
 *   dba_name, phone_verified, email_verified, county, lat, lng, google_place_id,
 *   google_categories, does_adu, does_residential, does_commercial,
 *   estimated_company_size, estimated_active_permits, outreach_status,
 *   last_called_at, call_notes, vapi_call_id, data_quality_score, is_active,
 *   services_description, website_phones, website_emails, website_people,
 *   website_address, website_license, selling_points, has_adu_mention,
 *   content_maturity, scrape_status, permit_latest_date, permit_types,
 *   permit_principal_name, permit_recent_projects, permit_zones, permit_address
 */

import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql, isNotNull } from "drizzle-orm";
import { contractorsEnriched } from "../schema";
import {
  ensureD1Table,
  syncContractorsToD1,
  buildD1Address,
  type D1SyncRecord,
} from "../lib/d1-sync";

// ─── CONNECTION ────────────────────────────────────────────────────────────────

if (!process.env.DATABASE_URL) {
  console.error("[migrate] ERROR: DATABASE_URL not set — check .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: { rejectUnauthorized: false },
});

const db = drizzle(pool, { schema: { contractorsEnriched } });

// ─── OLD SCHEMA TYPE ──────────────────────────────────────────────────────────

interface OldContractor {
  id: number;
  company_name: string;
  dba_name: string | null;
  cslb_license_number: string | number | null;
  license_class: string | null;
  license_status: string | null;
  license_expiration: string | null;
  phone: string | number | null;
  phone_verified: number;
  phone_verified_at: string | null;
  email: string | null;
  email_verified: number;
  email_source: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  zip: string | number | null;
  county: string | null;
  lat: number | null;
  lng: number | null;
  google_place_id: string | null;
  google_rating: number | null;
  google_review_count: number | null;
  google_categories: string | null;
  icp_score: number | null;
  does_adu: number;
  does_residential: number;
  does_commercial: number;
  estimated_company_size: string | null;
  estimated_active_permits: number | null;
  outreach_status: string | null;
  last_called_at: string | null;
  call_notes: string | null;
  vapi_call_id: string | null;
  data_quality_score: number | null;
  first_seen_at: string | null;
  updated_at: string | null;
  next_refresh_at: string | null;
  is_active: number;
  owner_name: string | null;
  contact_email: string | null;
  services_description: string | null;
  social_links: string | null;
  website_scraped_at: string | null;
  website_phones: string | null;
  website_emails: string | null;
  website_people: string | null;
  website_address: string | null;
  website_license: string | null;
  specializations: string | null;
  selling_points: string | null;
  has_adu_mention: number;
  years_in_business: number | null;
  content_maturity: string | null;
  company_size_ai: string | null;
  scrape_status: string | null;
  permit_count: number | null;
  permit_total_valuation: number | null;
  permit_latest_date: string | null;
  permit_avg_valuation: number | null;
  permit_types: string | null;
  permits_enriched_at: string | null;
  permit_principal_name: string | null;
  permit_recent_projects: string | null;
  permit_zones: string | null;
  permit_address: string | null;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function normalizeLicenseStatus(
  s: string | null
): "active" | "inactive" | "suspended" | "expired" | null {
  if (!s) return null;
  switch (s.toUpperCase().trim()) {
    case "ACTIVE":           return "active";
    case "INACTIVE":
    case "CANCELLED":
    case "NOT RENEWED":      return "inactive";
    case "SUSPENDED":        return "suspended";
    case "EXPIRED":          return "expired";
    default:                 return "inactive";
  }
}

function deriveIcpTier(score: number | null): "A" | "B" | "C" | "D" | null {
  if (score == null) return null;
  if (score >= 75)   return "A";
  if (score >= 50)   return "B";
  if (score >= 25)   return "C";
  return "D";
}

function tryParseJson(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

// "2511 Beverly Blvd, Los Angeles, CA 90057, USA" → "2511 Beverly Blvd"
function extractStreet(fullAddress: string | null): string | null {
  if (!fullAddress) return null;
  const first = fullAddress.split(",")[0].trim();
  return first || fullAddress;
}

// "03/31/2027" → "2027-03-31"; ISO strings passed through unchanged
function convertMmDdYyyy(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return dateStr;
}

function toDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function latestDate(...strs: (string | null)[]): Date | null {
  const valid = strs
    .map(toDate)
    .filter((d): d is Date => d !== null);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (a > b ? a : b));
}

// ─── FIELD TRANSFORM ─────────────────────────────────────────────────────────

type NewRow = typeof contractorsEnriched.$inferInsert;

function transform(old: OldContractor): NewRow | null {
  const license = old.cslb_license_number != null
    ? String(old.cslb_license_number).trim()
    : null;
  if (!license) return null;

  const name = old.company_name?.trim();
  if (!name) return null;

  return {
    cslbLicense:  license,
    businessName: name,
    ownerName:    old.owner_name ?? null,

    phone:   old.phone != null ? String(old.phone) : null,
    email:   old.email ?? old.contact_email ?? null,
    website: old.website ?? null,

    addressStreet: extractStreet(old.address),
    addressCity:   old.city ?? null,
    addressState:  "CA",
    addressZip:    old.zip != null ? String(old.zip) : null,

    licenseClass:    old.license_class ?? null,
    licenseStatus:   normalizeLicenseStatus(old.license_status),
    licenseExpiry:   convertMmDdYyyy(old.license_expiration),
    hasActiveLicense: old.license_status?.toUpperCase().trim() === "ACTIVE",

    // CSLB extended — not in old DB; populated by future fetch_cslb pipeline
    bondAmount:          null,
    workerCompInsurer:   null,
    workerCompExpiry:    null,
    disciplinaryActions: null,
    personnelOnLicense:  null,
    secondaryLicenses:   null,

    // CA Secretary of State — not in old DB
    entityType:        null,
    entityStatus:      null,
    incorporationDate: null,
    agentForService:   null,

    googleRating: old.google_rating ?? null,
    reviewCount:  old.google_review_count ?? null,
    yelpRating:   null,
    bbbRating:    null,
    photos:       null,
    socialLinks:  tryParseJson(old.social_links) ?? null,

    companySizeAi:     old.company_size_ai ?? null,
    yearsInBusiness:   old.years_in_business ?? null,
    specializationsAi: tryParseJson(old.specializations) ?? null,

    permitCountTotal:      old.permit_count ?? 0,
    permitCountActive:     null,
    permitCountByCity:     null,
    totalProjectValuation: old.permit_total_valuation != null
      ? Math.round(old.permit_total_valuation) : 0,
    avgProjectValuation:   old.permit_avg_valuation != null
      ? Math.round(old.permit_avg_valuation) : 0,

    inspectionPassRate:        null,
    avgDaysBetweenInspections: null,
    correctionRateByTrade:     null,

    icpScore:           old.icp_score ?? 0,
    icpScoreDimensions: null,
    icpTier:            deriveIcpTier(old.icp_score),

    enrichmentVersion: 1,
    lastEnrichedAt:    latestDate(
      old.website_scraped_at,
      old.permits_enriched_at,
      old.updated_at
    ),
    enrichmentErrors: null,

    createdAt: toDate(old.first_seen_at) ?? new Date(),
    updatedAt: toDate(old.updated_at)    ?? new Date(),
  };
}

// ─── UPSERT ───────────────────────────────────────────────────────────────────

async function upsertBatch(rows: NewRow[]): Promise<{ ok: number; err: number }> {
  try {
    await db.insert(contractorsEnriched)
      .values(rows)
      .onConflictDoUpdate({
        target: contractorsEnriched.cslbLicense,
        set: {
          businessName:          sql`excluded.business_name`,
          ownerName:             sql`excluded.owner_name`,
          phone:                 sql`excluded.phone`,
          email:                 sql`excluded.email`,
          website:               sql`excluded.website`,
          addressStreet:         sql`excluded.address_street`,
          addressCity:           sql`excluded.address_city`,
          addressState:          sql`excluded.address_state`,
          addressZip:            sql`excluded.address_zip`,
          licenseClass:          sql`excluded.license_class`,
          licenseStatus:         sql`excluded.license_status`,
          licenseExpiry:         sql`excluded.license_expiry`,
          hasActiveLicense:      sql`excluded.has_active_license`,
          googleRating:          sql`excluded.google_rating`,
          reviewCount:           sql`excluded.review_count`,
          socialLinks:           sql`excluded.social_links`,
          companySizeAi:         sql`excluded.company_size_ai`,
          yearsInBusiness:       sql`excluded.years_in_business`,
          specializationsAi:     sql`excluded.specializations_ai`,
          permitCountTotal:      sql`excluded.permit_count_total`,
          totalProjectValuation: sql`excluded.total_project_valuation`,
          avgProjectValuation:   sql`excluded.avg_project_valuation`,
          icpScore:              sql`excluded.icp_score`,
          icpTier:               sql`excluded.icp_tier`,
          enrichmentVersion:     sql`excluded.enrichment_version`,
          lastEnrichedAt:        sql`excluded.last_enriched_at`,
          updatedAt:             sql`excluded.updated_at`,
        },
      });
    return { ok: rows.length, err: 0 };
  } catch {
    // batch failed — retry one-by-one to isolate bad rows
    let ok = 0, err = 0;
    for (const row of rows) {
      try {
        await db.insert(contractorsEnriched)
          .values(row)
          .onConflictDoUpdate({
            target: contractorsEnriched.cslbLicense,
            set: { updatedAt: sql`excluded.updated_at` },
          });
        ok++;
      } catch (e: unknown) {
        err++;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  [skip] license=${row.cslbLicense} — ${msg}`);
      }
    }
    return { ok, err };
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const testMode = args.includes("--test");
  const dryRun   = args.includes("--dry-run");
  const BATCH    = 200;

  const dataPath = path.resolve(process.cwd(), "contractors_data.json");

  if (!fs.existsSync(dataPath)) {
    console.error(`[migrate] ERROR: File not found: ${dataPath}`);
    process.exit(1);
  }

  console.log(`[migrate] Reading ${dataPath} ...`);
  const parsed = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  // Handle wrapped export format: [{ results: OldContractor[] }] or flat OldContractor[]
  const raw: OldContractor[] = Array.isArray(parsed) && parsed.length === 1 && Array.isArray(parsed[0]?.results)
    ? parsed[0].results
    : parsed;
  console.log(`[migrate] Loaded ${raw.length.toLocaleString()} records from old database`);

  let source: OldContractor[];
  if (testMode) {
    const testLicense = "929941";
    const rec = raw.find(
      r => r.cslb_license_number != null && String(r.cslb_license_number).trim() === testLicense
    );
    if (!rec) {
      console.error(`[migrate] TEST RECORD (license ${testLicense}) NOT FOUND in contractors_data.json`);
      process.exit(1);
    }
    source = [rec];
    console.log(`[migrate] TEST MODE — 1 record (${rec.company_name}, license ${testLicense})\n`);
    console.log("Raw source record:");
    console.log(JSON.stringify(rec, null, 2));
    console.log("\nTransformed row:");
    console.log(JSON.stringify(transform(rec), null, 2));
    console.log();
  } else {
    source = raw;
    console.log(`[migrate] FULL MODE — processing ${source.length.toLocaleString()} records`);
    if (dryRun) console.log("[migrate] DRY RUN — no writes to database");
  }

  let totalIn = 0, totalOk = 0, totalSkip = 0, totalErr = 0;
  const batch: NewRow[] = [];

  const flush = async () => {
    if (!batch.length) return;
    if (dryRun) {
      totalOk += batch.length;
    } else {
      const { ok, err } = await upsertBatch([...batch]);
      totalOk  += ok;
      totalErr += err;
    }
    batch.length = 0;
    process.stdout.write(
      `\r[migrate] ${totalOk.toLocaleString()} ok  ${totalSkip} skipped  ${totalErr} errors   `
    );
  };

  for (const old of source) {
    totalIn++;
    const row = transform(old);
    if (!row) { totalSkip++; continue; }
    batch.push(row);
    if (batch.length >= BATCH) await flush();
  }
  await flush();

  console.log(`\n\n[migrate] ── DONE ──────────────────────────────────────────────`);
  console.log(`  Source records : ${totalIn.toLocaleString()}`);
  console.log(`  Upserted       : ${totalOk.toLocaleString()}`);
  console.log(`  Skipped        : ${totalSkip}  (missing cslb_license_number or company_name)`);
  console.log(`  Errors         : ${totalErr}`);
  if (dryRun) console.log("  (DRY RUN — nothing was written)");

  // ── D1 sync (task 2.6) ─────────────────────────────────────────────────────
  // Query all upserted contractors with a business address and write
  // address → contractor_id to the Cloudflare D1 edge cache.
  // Skip silently when CF_API_TOKEN is absent — doesn't block data migration.
  if (!dryRun && process.env.CF_API_TOKEN) {
    console.log("\n[migrate] Syncing contractor addresses to Cloudflare D1...");
    try {
      await ensureD1Table();

      const D1_PAGE = 1_000;
      let d1Offset  = 0;
      let d1Total   = 0;

      while (true) {
        const rows = await db
          .select({
            id:            contractorsEnriched.id,
            cslbLicense:   contractorsEnriched.cslbLicense,
            addressStreet: contractorsEnriched.addressStreet,
            addressCity:   contractorsEnriched.addressCity,
          })
          .from(contractorsEnriched)
          .where(isNotNull(contractorsEnriched.addressStreet))
          .limit(D1_PAGE)
          .offset(d1Offset);

        if (rows.length === 0) break;

        const d1Records: D1SyncRecord[] = rows
          .map((r) => {
            const address = buildD1Address(r.addressStreet, r.addressCity);
            if (!address) return null;
            return { address, contractorId: r.id, cslbLicense: r.cslbLicense };
          })
          .filter((r): r is D1SyncRecord => r !== null);

        d1Total += await syncContractorsToD1(d1Records);
        process.stdout.write(`\r[migrate] D1: ${d1Total.toLocaleString()} addresses synced   `);

        if (rows.length < D1_PAGE) break;
        d1Offset += D1_PAGE;
      }

      console.log(`\n[migrate] D1 sync complete — ${d1Total.toLocaleString()} addresses cached`);
    } catch (err) {
      console.error("\n[migrate] D1 sync failed:", (err as Error).message);
      console.log("[migrate] Data migration is complete — D1 sync can be retried separately.");
    }
  } else if (!dryRun && !process.env.CF_API_TOKEN) {
    console.log("\n[migrate] CF_API_TOKEN not set — skipping D1 sync (run again after adding it)");
  }

  await pool.end();
}

main().catch(err => {
  console.error("[migrate] FATAL:", err instanceof Error ? err.message : err);
  pool.end();
  process.exit(1);
});
