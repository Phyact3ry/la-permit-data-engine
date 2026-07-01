import { db } from "../lib/db";
import { pipelineState } from "../schema";
import { sql } from "drizzle-orm";

async function main() {
  const rows = await db.select().from(pipelineState).orderBy(pipelineState.pipelineName);

  console.log("\n=== PIPELINE HEALTH CHECK ===\n");

  const now = new Date();

  for (const row of rows) {
    const age = row.lastRunAt
      ? Math.round((now.getTime() - row.lastRunAt.getTime()) / 1000 / 60 / 60)
      : null;

    const statusIcon =
      row.status === "done" ? "✅" :
      row.status === "running" ? "🔄" :
      row.status === "error" ? "❌" : "⏸";

    console.log(`${statusIcon} ${row.pipelineName}`);
    console.log(`   status:     ${row.status}`);
    console.log(`   lastRunAt:  ${row.lastRunAt ? row.lastRunAt.toISOString() : "never"} ${age !== null ? `(${age}h ago)` : ""}`);
    console.log(`   processed:  ${row.recordsProcessed ?? 0} records`);
    console.log(`   offset:     ${row.lastOffset ?? 0}`);
    if (row.lastCursor) console.log(`   cursor:     ${row.lastCursor}`);
    if (row.error)      console.log(`   ⚠ error:    ${row.error}`);
    console.log();
  }

  // Таблицы с данными
  const counts = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM contractors_enriched)  AS contractors,
      (SELECT COUNT(*) FROM permits)                AS permits,
      (SELECT COUNT(*) FROM inspections)            AS inspections,
      (SELECT COUNT(*) FROM enrichment_signals)     AS signals,
      (SELECT COUNT(*) FROM hypotheses)             AS hypotheses,
      (SELECT COUNT(*) FROM outreach_touches)       AS touches
  `);

  console.log("=== TABLE COUNTS ===\n");
  const c = counts.rows[0] as any;
  console.log(`  contractors_enriched : ${c.contractors}`);
  console.log(`  permits              : ${c.permits}`);
  console.log(`  inspections          : ${c.inspections}`);
  console.log(`  enrichment_signals   : ${c.signals}`);
  console.log(`  hypotheses           : ${c.hypotheses}`);
  console.log(`  outreach_touches     : ${c.touches}`);
  console.log();
}

main().catch(console.error).finally(() => process.exit(0));
