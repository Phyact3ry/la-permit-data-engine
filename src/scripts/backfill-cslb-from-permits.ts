import "dotenv/config";
import { db } from "../lib/db";
import { contractorsEnriched } from "../schema";
import { sql, inArray } from "drizzle-orm";
import { fetchCslbBatch } from "../lib/cslb-fetcher";
import {
  ensureD1Table,
  syncContractorsToD1,
  buildD1Address,
  type D1SyncRecord,
} from "../lib/d1-sync";

const BATCH_SIZE = 50;
const DELAY_MS   = 800;

async function main() {
  // Fetch all unique licenses in permits not yet in contractors_enriched.
  // Natural resume: already-scraped licenses are IN contractors_enriched → filtered out.
  const rows = await db.execute<{ license: string }>(sql`
    SELECT DISTINCT raw_socrata->>'license' AS license
    FROM permits
    WHERE raw_socrata->>'license' IS NOT NULL
      AND raw_socrata->>'license' != ''
      AND raw_socrata->>'license' NOT IN (
        SELECT cslb_license FROM contractors_enriched
      )
    ORDER BY 1
  `);

  const licenses = rows.rows.map((r) => r.license).filter(Boolean);

  if (licenses.length === 0) {
    console.log("[backfill-cslb] Nothing to do — all permit licenses already in DB.");
    process.exit(0);
  }

  const totalBatches = Math.ceil(licenses.length / BATCH_SIZE);
  const estHours     = ((licenses.length * (DELAY_MS + 1200)) / 3_600_000).toFixed(1);
  console.log(`[backfill-cslb] ${licenses.length} missing licenses — ${totalBatches} batches — est. ~${estHours}h`);

  if (process.env.CF_API_TOKEN) {
    await ensureD1Table();
  } else {
    console.warn("[backfill-cslb] CF_API_TOKEN not set — D1 sync will be skipped");
  }

  let totalFetched  = 0;
  let totalNotFound = 0;
  let totalErrors   = 0;
  let totalD1Synced = 0;

  for (let i = 0; i < licenses.length; i += BATCH_SIZE) {
    const batch    = licenses.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`[backfill-cslb] Batch ${batchNum}/${totalBatches} — fetching ${batch.length} licenses...`);

    const result = await fetchCslbBatch(batch, { delayMs: DELAY_MS });

    totalFetched  += result.results.length;
    totalNotFound += result.notFound;
    totalErrors   += result.errors;

    if (result.results.length > 0) {
      // Upsert to contractors_enriched
      for (const c of result.results) {
        await db
          .insert(contractorsEnriched)
          .values({
            cslbLicense:        c.cslbLicense,
            businessName:       c.businessName ?? "Unknown",
            ownerName:          c.ownerName,
            phone:              c.phone,
            addressStreet:      c.addressStreet,
            addressCity:        c.addressCity,
            addressState:       c.addressState,
            addressZip:         c.addressZip,
            licenseClass:       c.licenseClass,
            licenseStatus:      c.licenseStatus as any,
            licenseExpiry:      c.licenseExpiry,
            bondAmount:         c.bondAmount,
            workerCompInsurer:  c.workerCompInsurer,
            workerCompExpiry:   c.workerCompExpiry,
            hasActiveLicense:   c.hasActiveLicense,
            disciplinaryActions: c.disciplinaryActions,
            personnelOnLicense: c.personnelOnLicense,
            secondaryLicenses:  c.secondaryLicenses,
            lastEnrichedAt:     new Date(),
          })
          .onConflictDoUpdate({
            target: contractorsEnriched.cslbLicense,
            set: {
              licenseStatus:      c.licenseStatus as any,
              licenseExpiry:      c.licenseExpiry,
              bondAmount:         c.bondAmount,
              workerCompInsurer:  c.workerCompInsurer,
              workerCompExpiry:   c.workerCompExpiry,
              hasActiveLicense:   c.hasActiveLicense,
              disciplinaryActions: c.disciplinaryActions,
              personnelOnLicense: c.personnelOnLicense,
              lastEnrichedAt:     new Date(),
              updatedAt:          new Date(),
            },
          });
      }

      // Sync new addresses to D1
      if (process.env.CF_API_TOKEN) {
        const newLicenses = result.results.map((c) => c.cslbLicense);
        const dbRows = await db
          .select({
            id:            contractorsEnriched.id,
            cslbLicense:   contractorsEnriched.cslbLicense,
            addressStreet: contractorsEnriched.addressStreet,
            addressCity:   contractorsEnriched.addressCity,
          })
          .from(contractorsEnriched)
          .where(inArray(contractorsEnriched.cslbLicense, newLicenses));

        const d1Records: D1SyncRecord[] = dbRows
          .map((r) => {
            const address = buildD1Address(r.addressStreet, r.addressCity);
            if (!address) return null;
            return { address, contractorId: r.id, cslbLicense: r.cslbLicense };
          })
          .filter((r): r is D1SyncRecord => r !== null);

        if (d1Records.length > 0) {
          totalD1Synced += await syncContractorsToD1(d1Records);
        }
      }
    }

    const pct = ((batchNum / totalBatches) * 100).toFixed(1);
    console.log(
      `[backfill-cslb] ${pct}% — batch ${batchNum}/${totalBatches}: ` +
      `+${result.results.length} scraped, ${result.notFound} not found, ${result.errors} errors | ` +
      `running total: ${totalFetched} fetched / ${totalNotFound} not found`
    );
  }

  console.log("\n[backfill-cslb] Done!");
  console.log(`  New contractors scraped : ${totalFetched}`);
  console.log(`  Not found (invalid lic) : ${totalNotFound}`);
  console.log(`  Errors                  : ${totalErrors}`);
  console.log(`  D1 addresses synced     : ${totalD1Synced}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill-cslb] Fatal:", err);
  process.exit(1);
});
