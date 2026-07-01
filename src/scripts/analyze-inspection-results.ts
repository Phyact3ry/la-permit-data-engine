/**
 * analyze-inspection-results.ts — ONE-OFF read-only analysis.
 *
 * For each of the 8 ADU inspection slugs, show the distribution of raw
 * inspection_result values on the FIRST attempt within the 12-month window,
 * with the CURRENT taxonomy class (pass/fail/nondecisive), the current
 * first-time fail rate, and a sensitivity table: what the fail rate becomes
 * if each currently-nondecisive result were reclassified as a fail.
 *
 * Does NOT write anything. Does NOT change the taxonomy. Analysis only.
 *   npx tsx src/scripts/analyze-inspection-results.ts
 */

import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import {
  INSPECTION_TYPES,
  resultClass,
  SAMPLE_THRESHOLD,
} from "../lib/inspection-taxonomy";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function subMonths(d: Date, m: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() - m);
  return r;
}
function pct(n: number): string {
  return (n * 100).toFixed(2) + "%";
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

  // First-attempt-in-window distribution of raw results, per slug.
  const res = await db.execute(sql`
    WITH type_map(raw_type, slug) AS (VALUES ${typeMapRows}),
    first_attempt AS (
      SELECT
        tm.slug,
        i.inspection_result AS result,
        i.inspection_date::date AS idate,
        ROW_NUMBER() OVER (
          PARTITION BY i.permit_ref, tm.slug
          ORDER BY i.inspection_date::date ASC, i.id ASC
        ) AS rn
      FROM inspections i
      JOIN type_map tm ON tm.raw_type = i.inspection_type
      WHERE i.inspection_date IS NOT NULL
    )
    SELECT slug, COALESCE(result, '(null)') AS result, COUNT(*)::int AS n
    FROM first_attempt
    WHERE rn = 1
      AND idate >= ${periodStart}::date
      AND idate <= ${periodEnd}::date
    GROUP BY slug, result
    ORDER BY slug, n DESC
  `);

  type Row = { slug: string; result: string; n: number };
  const rows = (res.rows as Row[]).map((r) => ({ ...r, n: Number(r.n) }));

  const bySlug = new Map<string, Row[]>();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug)!.push(r);
  }

  console.log(`\n=== ADU inspection first-attempt result distribution ===`);
  console.log(`Window: ${periodStart} .. ${periodEnd} (trailing 12 months)`);
  console.log(`Sample threshold (publish): ${SAMPLE_THRESHOLD}`);
  console.log(`Class: raw result -> current taxonomy class\n`);

  for (const t of INSPECTION_TYPES) {
    const list = (bySlug.get(t.slug) ?? []).slice().sort((a, b) => b.n - a.n);
    const total = list.reduce((s, r) => s + r.n, 0);

    let passed = 0,
      failed = 0,
      nondecisive = 0;
    const nd: { result: string; n: number }[] = [];
    for (const r of list) {
      const cls =
        r.result === "(null)" ? "nondecisive" : resultClass(r.result, t.slug);
      if (cls === "pass") passed += r.n;
      else if (cls === "fail") failed += r.n;
      else {
        nondecisive += r.n;
        nd.push({ result: r.result, n: r.n });
      }
    }
    const decisive = passed + failed;
    const failRate = decisive > 0 ? failed / decisive : 0;

    console.log("─".repeat(78));
    console.log(
      `[${t.slug}]  tier ${t.tier}  —  ${t.name}\n` +
        `  LADBS types: ${t.ladbsTypes.join(", ")}`
    );
    console.log(
      `  first-attempts in window: ${total}  |  pass ${passed}  fail ${failed}  nondecisive ${nondecisive}`
    );
    console.log(
      `  CURRENT decisive sample = ${decisive}  ->  fail rate = ${
        decisive > 0 ? pct(failRate) : "n/a"
      }  (published: ${decisive >= SAMPLE_THRESHOLD})`
    );

    console.log(`  full result breakdown:`);
    for (const r of list) {
      const cls =
        r.result === "(null)" ? "nondecisive" : resultClass(r.result, t.slug);
      const share = total > 0 ? ((r.n / total) * 100).toFixed(1) : "0.0";
      console.log(
        `    ${String(r.n).padStart(7)}  ${share.padStart(5)}%  [${cls.padEnd(
          11
        )}]  ${r.result}`
      );
    }

    if (nd.length > 0) {
      console.log(
        `  SENSITIVITY — if a currently-nondecisive result were counted as FAIL:`
      );
      // cumulative: add the biggest nondecisive buckets one at a time
      let cumFail = failed;
      let cumDecisive = decisive;
      for (const r of nd.sort((a, b) => b.n - a.n)) {
        // marginal: this single bucket alone -> fail
        const dOne = decisive + r.n;
        const fOne = failed + r.n;
        const rateOne = dOne > 0 ? fOne / dOne : 0;
        // cumulative: this bucket + all larger ones -> fail
        cumFail += r.n;
        cumDecisive += r.n;
        const rateCum = cumDecisive > 0 ? cumFail / cumDecisive : 0;
        console.log(
          `    +"${r.result}" (${r.n})  ->  alone: fail ${pct(
            rateOne
          )}  |  cumulative: fail ${pct(rateCum)}`
        );
      }
    }
    console.log("");
  }

  console.log("─".repeat(78));
  console.log("Done. (read-only, nothing changed)\n");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
