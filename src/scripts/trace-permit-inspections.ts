/**
 * trace-permit-inspections.ts — manual reconciliation of one permit.
 *
 * Prints the full inspection timeline for one permit_ref from our DB, maps each
 * row to its slug + result class, and shows the computed first-time outcome per
 * slug. Lets a human eyeball that the engine's first-attempt result matches the
 * raw history.
 *
 * Run: npx tsx src/scripts/trace-permit-inspections.ts "<permit_ref>"
 */

import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { ladbsTypeToSlug, resultClass } from "../lib/inspection-taxonomy";

async function main() {
  const permitRef = process.argv[2];
  if (!permitRef) {
    console.error('Usage: npx tsx src/scripts/trace-permit-inspections.ts "<permit_ref>"');
    process.exit(1);
  }

  const res = await db.execute(sql`
    SELECT id, inspection_date, inspection_type, inspection_result
    FROM inspections
    WHERE permit_ref = ${permitRef}
    ORDER BY inspection_date::date ASC, id ASC
  `);
  const rows = res.rows as {
    id: string;
    inspection_date: string;
    inspection_type: string;
    inspection_result: string | null;
  }[];

  if (rows.length === 0) {
    console.log(`No inspections found for permit_ref="${permitRef}"`);
    process.exit(0);
  }

  console.log(`\n=== Inspection timeline for permit_ref="${permitRef}" (${rows.length} rows) ===\n`);
  console.log("  date        slug                       class         result / type");
  console.log("  " + "-".repeat(90));
  for (const r of rows) {
    const slug = ladbsTypeToSlug(r.inspection_type);
    const cls = resultClass(r.inspection_result, slug);
    const slugStr = (slug ?? "(not an ADU type)").padEnd(26);
    const clsStr = cls.padEnd(13);
    console.log(
      `  ${r.inspection_date}  ${slugStr} ${clsStr} ${r.inspection_result ?? "(null)"}  [${r.inspection_type}]`
    );
  }

  // First attempt per slug (over this permit's full history shown above)
  console.log(`\n=== Computed first-time outcome per slug ===\n`);
  const firstBySlug = new Map<string, { date: string; result: string | null; cls: string }>();
  for (const r of rows) {
    const slug = ladbsTypeToSlug(r.inspection_type);
    if (!slug) continue;
    if (!firstBySlug.has(slug)) {
      firstBySlug.set(slug, {
        date: r.inspection_date,
        result: r.inspection_result,
        cls: resultClass(r.inspection_result, slug),
      });
    }
  }

  if (firstBySlug.size === 0) {
    console.log("  (no rows mapped to any of the 8 ADU inspection types)");
  }
  for (const [slug, fa] of firstBySlug) {
    const outcome =
      fa.cls === "pass" ? "PASS (first-time)" :
      fa.cls === "fail" ? "FAIL (first-time)" :
      "EXCLUDED (non-decisive — not counted)";
    console.log(`  ${slug.padEnd(26)} first=${fa.date} result="${fa.result}" → ${outcome}`);
  }

  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("trace failed:", err);
  process.exit(1);
});
