/**
 * analyze-partial-approval.ts — ONE-OFF read-only.
 *
 * For (permit_ref, slug) pairs whose FIRST attempt result = 'Partial Approval'
 * (first attempt inside the 12-month window), answer:
 *   1. What share have a SECOND inspection of the same type? (i.e. you come back)
 *   2. What is the eventual (last-attempt) result of those pairs?
 * This tells us whether "Partial Approval" is a step that requires another
 * inspection to move forward, and how it usually resolves.
 *
 *   npx tsx src/scripts/analyze-partial-approval.ts
 */

import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { INSPECTION_TYPES } from "../lib/inspection-taxonomy";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function subMonths(d: Date, m: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() - m);
  return r;
}
function pctOf(n: number, d: number): string {
  return d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "n/a";
}

async function main() {
  const asOf = new Date();
  const periodEnd = ymd(asOf);
  const periodStart = ymd(subMonths(asOf, 12));

  const typeMapRows = sql.join(
    INSPECTION_TYPES.flatMap((t) =>
      t.ladbsTypes.map((rt) => sql`(${rt}, ${t.slug})`)
    ),
    sql`, `
  );

  await db.execute(sql`SET statement_timeout = '300s'`);

  const res = await db.execute(sql`
    WITH type_map(raw_type, slug) AS (VALUES ${typeMapRows}),
    mapped AS (
      SELECT tm.slug, i.permit_ref, i.inspection_result AS result, i.inspection_date::date AS idate, i.id
      FROM inspections i
      JOIN type_map tm ON tm.raw_type = i.inspection_type
      WHERE i.inspection_date IS NOT NULL
    ),
    grp AS (
      SELECT
        slug,
        permit_ref,
        COUNT(*)::int AS total_attempts,
        MIN(idate) AS first_date,
        (array_agg(result ORDER BY idate ASC,  id ASC))[1]  AS first_result,
        (array_agg(result ORDER BY idate DESC, id DESC))[1] AS last_result
      FROM mapped
      GROUP BY slug, permit_ref
    )
    SELECT
      slug,
      COUNT(*)::int                                              AS n_first_partial,
      COUNT(*) FILTER (WHERE total_attempts >= 2)::int           AS came_back,
      COUNT(*) FILTER (WHERE last_result = 'Approved')::int           AS ended_approved,
      COUNT(*) FILTER (WHERE last_result = 'Corrections Issued')::int AS ended_corrections,
      COUNT(*) FILTER (WHERE last_result = 'Partial Approval')::int   AS ended_still_partial,
      COUNT(*) FILTER (WHERE last_result NOT IN ('Approved','Corrections Issued','Partial Approval'))::int AS ended_other
    FROM grp
    WHERE first_result = 'Partial Approval'
      AND first_date >= ${periodStart}::date
      AND first_date <= ${periodEnd}::date
    GROUP BY slug
    ORDER BY n_first_partial DESC
  `);

  type Row = {
    slug: string;
    n_first_partial: number;
    came_back: number;
    ended_approved: number;
    ended_corrections: number;
    ended_still_partial: number;
    ended_other: number;
  };
  const rows = (res.rows as Row[]).map((r) => ({
    slug: r.slug,
    n: Number(r.n_first_partial),
    back: Number(r.came_back),
    appr: Number(r.ended_approved),
    corr: Number(r.ended_corrections),
    part: Number(r.ended_still_partial),
    other: Number(r.ended_other),
  }));

  console.log(`\n=== "Partial Approval" as a first attempt — what happens next ===`);
  console.log(`Window (first attempt): ${periodStart} .. ${periodEnd}`);
  console.log(`(Recent pairs may not have resolved yet — slight downward bias on "came back".)\n`);

  let tn = 0, tback = 0, tappr = 0, tcorr = 0, tpart = 0, tother = 0;
  for (const r of rows) {
    tn += r.n; tback += r.back; tappr += r.appr; tcorr += r.corr; tpart += r.part; tother += r.other;
    console.log("─".repeat(72));
    console.log(`[${r.slug}]  first-attempt = Partial Approval: ${r.n} pairs`);
    console.log(`  had a 2nd inspection (came back): ${r.back}  (${pctOf(r.back, r.n)})`);
    console.log(`  eventual (last) result of those pairs:`);
    console.log(`    Approved            ${String(r.appr).padStart(6)}  ${pctOf(r.appr, r.n)}`);
    console.log(`    Corrections Issued  ${String(r.corr).padStart(6)}  ${pctOf(r.corr, r.n)}`);
    console.log(`    still Partial       ${String(r.part).padStart(6)}  ${pctOf(r.part, r.n)}`);
    console.log(`    other/non-decisive  ${String(r.other).padStart(6)}  ${pctOf(r.other, r.n)}`);
  }

  console.log("═".repeat(72));
  console.log(`TOTAL first-attempt=Partial Approval: ${tn}`);
  console.log(`  came back (>=2 inspections): ${tback}  (${pctOf(tback, tn)})`);
  console.log(`  eventually Approved:         ${tappr}  (${pctOf(tappr, tn)})`);
  console.log(`  eventually Corrections:      ${tcorr}  (${pctOf(tcorr, tn)})`);
  console.log(`  still Partial (last):        ${tpart}  (${pctOf(tpart, tn)})`);
  console.log(`  other/non-decisive (last):   ${tother}  (${pctOf(tother, tn)})`);
  console.log("");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
