/**
 * backfill-inspection-pass-rates.ts
 *
 * One-time backfill: compute inspection_pass_rate for every contractor
 * that has at least one linked permit.
 *
 * Joins inspections.permit_ref (spaces) to permits.permit_number (dashes)
 * via REPLACE(permit_ref, ' ', '-').
 *
 * Run:  npx tsx src/scripts/backfill-inspection-pass-rates.ts
 */

import { db } from "../lib/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("[backfill] Computing inspection_pass_rate for all contractors...");

  const result = await db.execute(sql`
    WITH insp_agg AS (
      SELECT
        permit_ref,
        COUNT(*)::int                                                  AS total,
        COUNT(*) FILTER (WHERE inspection_result = 'Approved')::int   AS approved
      FROM inspections
      GROUP BY permit_ref
    ),
    contractor_stats AS (
      SELECT
        p.contractor_id,
        SUM(ia.approved)::int   AS total_approved,
        SUM(ia.total)::int      AS grand_total
      FROM insp_agg ia
      JOIN permits p
        ON p.permit_number = REPLACE(ia.permit_ref, ' ', '-')
      WHERE p.contractor_id IS NOT NULL
      GROUP BY p.contractor_id
    )
    UPDATE contractors_enriched AS ce
    SET
      inspection_pass_rate = cs.total_approved::real / NULLIF(cs.grand_total, 0)::real,
      updated_at           = NOW()
    FROM contractor_stats cs
    WHERE ce.id = cs.contractor_id
  `);

  console.log(`[backfill] Done — inspection_pass_rate set for ${result.rowCount ?? 0} contractors`);

  // Quick sanity check
  const check = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE inspection_pass_rate IS NOT NULL) AS with_rate,
      COUNT(*)                                                  AS total,
      ROUND(AVG(inspection_pass_rate)::numeric, 3)             AS avg_pass_rate
    FROM contractors_enriched
    WHERE permit_count_total > 0 OR permit_count_active > 0
  `);
  console.log("[backfill] Sanity check:", check.rows[0]);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
