/**
 * probe-inspection-types.ts — read-only sanity check
 *
 * Confirms that the 8 ADU inspection types are present
 * verbatim in our inspections table, and dumps the full distribution of
 * inspection_result values so the taxonomy (Step 1) can be grounded in real data.
 *
 * Reads ONLY from our DB (inspections). Does NOT touch Socrata, does NOT write.
 *
 * Run: npx tsx src/scripts/probe-inspection-types.ts
 */

import { db } from "../lib/db";
import { sql } from "drizzle-orm";

// slug -> exact LADBS inspection_type strings (verbatim from the dataset, incl. typo "Diaphrgm")
const TYPE_MAP: { slug: string; tier: number; ladbsTypes: string[] }[] = [
  { slug: "final",                    tier: 1, ladbsTypes: ["Final"] },
  { slug: "smoke-co-detectors",       tier: 1, ladbsTypes: ["Smoke Detectors"] },
  { slug: "electrical-service",       tier: 1, ladbsTypes: ["Service/Power Release"] },
  { slug: "gas-shutoff-valve-sgsov",  tier: 1, ladbsTypes: ["SGSOV-Seismic Gas S/O Valve"] },
  { slug: "stucco-lath",              tier: 2, ladbsTypes: ["Interior/Exterior Lathing"] },
  { slug: "foundation-footing",       tier: 2, ladbsTypes: ["Footing/Foundation/Slab"] },
  { slug: "shear-wall-seismic",       tier: 2, ladbsTypes: ["Floor/Roof Diaphrgm/Shear Wall"] },
  { slug: "framing-rough",            tier: 2, ladbsTypes: ["Rough", "BUILDING-Rough-Frame", "Wood Frame"] },
];

async function main() {
  console.log("=== Step 0: probe inspection types (rolling 12 months) ===\n");

  for (const t of TYPE_MAP) {
    const inList = sql.join(t.ladbsTypes.map((s) => sql`${s}`), sql`, `);
    const rows = await db.execute(sql`
      SELECT inspection_type, count(*)::int AS cnt
      FROM inspections
      WHERE inspection_type IN (${inList})
        AND inspection_date::date >= (current_date - interval '12 months')
      GROUP BY inspection_type
      ORDER BY cnt DESC
    `);
    const found = rows.rows as { inspection_type: string; cnt: number }[];
    const total = found.reduce((a, r) => a + Number(r.cnt), 0);
    console.log(`[${t.tier === 1 ? "T1" : "T2"}] ${t.slug}  (expect: ${t.ladbsTypes.join(" | ")})`);
    console.log(`     12mo total = ${total.toLocaleString()}`);
    for (const r of found) {
      console.log(`        - "${r.inspection_type}": ${Number(r.cnt).toLocaleString()}`);
    }
    // flag any expected type string that returned zero rows
    for (const expected of t.ladbsTypes) {
      if (!found.some((r) => r.inspection_type === expected)) {
        console.log(`        ⚠️  NO ROWS for expected type "${expected}"`);
      }
    }
    console.log("");
  }

  console.log("=== distinct inspection_result (all-time, top 60 by count) ===\n");
  const resRows = await db.execute(sql`
    SELECT COALESCE(NULLIF(inspection_result, ''), '(empty)') AS result, count(*)::int AS cnt
    FROM inspections
    GROUP BY COALESCE(NULLIF(inspection_result, ''), '(empty)')
    ORDER BY cnt DESC
    LIMIT 60
  `);
  for (const r of resRows.rows as { result: string; cnt: number }[]) {
    console.log(`  ${String(Number(r.cnt).toLocaleString()).padStart(12)}  ${r.result}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
