/**
 * run-inspection-stats.ts — manual one-off run of the stats engine.
 *
 * Mirrors the Inngest function's compute+persist steps. Useful for local runs,
 * backfills, and verifying real numbers without the Inngest dev server.
 *
 * Usage:
 *   npx tsx src/scripts/run-inspection-stats.ts            # compute + print + persist snapshot
 *   npx tsx src/scripts/run-inspection-stats.ts --dry      # compute + print only (no write)
 */

import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { inspectionStatsSnapshots } from "../schema";
import { computeInspectionStats } from "../lib/compute-inspection-stats";

async function main() {
  const dry = process.argv.includes("--dry");

  console.log("Computing inspection stats (this scans the inspections table)…\n");
  const t0 = Date.now();
  const artifact = await computeInspectionStats();
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`Done in ${secs}s. Period ${artifact.period.start} .. ${artifact.period.end}\n`);
  console.log("  slug                       tier  sample    pass%   fail%   excl(non-dec)  published");
  console.log("  " + "-".repeat(92));
  for (const t of artifact.types) {
    const pass = t.first_time_pass_rate === null ? "  n/a" : (t.first_time_pass_rate * 100).toFixed(2).padStart(6);
    const fail = t.first_time_fail_rate === null ? "  n/a" : (t.first_time_fail_rate * 100).toFixed(2).padStart(6);
    console.log(
      `  ${t.slug.padEnd(26)} ${String(t.tier).padStart(2)}  ${String(t.sample_size).padStart(7)}  ` +
      `${pass}  ${fail}   ${String(t.excluded_nondecisive).padStart(10)}     ${t.published ? "yes" : "no"}`
    );
  }

  if (dry) {
    console.log("\n--dry: snapshot NOT persisted.");
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ WRITE`);
    await tx.insert(inspectionStatsSnapshots).values({
      snapshotDate:    artifact.snapshot_date,
      periodStart:     artifact.period.start,
      periodEnd:       artifact.period.end,
      sampleThreshold: artifact.sample_threshold,
      payload:         artifact,
    });
  });
  console.log(`\n✅ Snapshot persisted for ${artifact.snapshot_date}.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("run failed:", err);
  process.exit(1);
});
