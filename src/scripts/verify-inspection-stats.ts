/**
 * verify-inspection-stats.ts — independent check that the stats are fair and true.
 *
 * Recomputes first-time pass rate for the Tier-1 slugs by querying Socrata
 * (9w5z-rg2h) DIRECTLY — an independent path that does NOT touch our DB — and
 * diffs it against our computed artifact. The two should match within a small
 * tolerance (ingest lag + Socrata refresh timing).
 *
 * The independent path applies the SAME taxonomy (classifyResult) and the SAME
 * first-attempt-over-full-history rule, so a non-trivial delta means either an
 * ingest gap or a logic divergence.
 *
 * Run: npx tsx src/scripts/verify-inspection-stats.ts [slug ...]
 *   (default: all Tier-1 slugs)
 *
 * NOTE: pulls FULL history for the requested types from Socrata to find true
 * first attempts. 'final' is large (~2.4M rows) — expect minutes. Pass specific
 * slugs (e.g. smoke-co-detectors) for a fast check.
 */

import { computeInspectionStats } from "../lib/compute-inspection-stats";
import {
  INSPECTION_TYPES,
  TIER1_SLUGS,
  ladbsTypeToSlug,
  resultClass,
} from "../lib/inspection-taxonomy";

const SOCRATA_BASE = "https://data.lacity.org/resource/9w5z-rg2h.json";
const PAGE_SIZE = 50_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function subMonths(d: Date, m: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() - m);
  return r;
}

interface SocrataRow {
  permit?: string;
  inspection?: string;
  inspection_date?: string;
  inspection_result?: string;
}

/** Independently recompute first-time pass/fail for the given slugs from Socrata. */
async function socrataRecompute(
  slugs: string[],
  periodStart: string,
  periodEnd: string
): Promise<Map<string, { passed: number; failed: number; nondecisive: number }>> {
  // raw LADBS type strings to pull
  const rawTypes = INSPECTION_TYPES.filter((t) => slugs.includes(t.slug)).flatMap(
    (t) => t.ladbsTypes
  );
  const inList = rawTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(",");
  const appToken = process.env.SOCRATA_APP_TOKEN;

  // earliest attempt per (permit, slug) over ALL history
  const earliest = new Map<string, { date: string; result: string | null }>();

  let offset = 0;
  let page = 0;
  while (true) {
    const params = new URLSearchParams({
      $select: "permit,inspection,inspection_date,inspection_result",
      $where: `inspection in (${inList})`,
      $order: "permit,inspection_date",
      $limit: String(PAGE_SIZE),
      $offset: String(offset),
    });
    const headers: HeadersInit = { Accept: "application/json" };
    if (appToken) headers["X-App-Token"] = appToken;

    const resp = await fetch(`${SOCRATA_BASE}?${params}`, { headers });
    if (!resp.ok) throw new Error(`Socrata ${resp.status}: ${await resp.text()}`);
    const rows = (await resp.json()) as SocrataRow[];
    if (rows.length === 0) break;

    for (const r of rows) {
      const slug = ladbsTypeToSlug(r.inspection);
      if (!slug || !r.permit || !r.inspection_date) continue;
      const date = r.inspection_date.slice(0, 10);
      const key = `${r.permit}|${slug}`;
      const prev = earliest.get(key);
      if (!prev || date < prev.date) {
        earliest.set(key, { date, result: r.inspection_result ?? null });
      }
    }

    page++;
    console.log(`  [socrata] page ${page} (offset ${offset}), pairs so far: ${earliest.size}`);
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  const agg = new Map<string, { passed: number; failed: number; nondecisive: number }>();
  for (const [key, fa] of earliest) {
    if (fa.date < periodStart || fa.date > periodEnd) continue; // window on first-attempt date
    const slug = key.split("|")[1];
    const cur = agg.get(slug) ?? { passed: 0, failed: 0, nondecisive: 0 };
    const cls = resultClass(fa.result, slug);
    if (cls === "pass") cur.passed++;
    else if (cls === "fail") cur.failed++;
    else cur.nondecisive++;
    agg.set(slug, cur);
  }
  return agg;
}

async function main() {
  const argSlugs = process.argv.slice(2);
  const slugs = argSlugs.length ? argSlugs : TIER1_SLUGS;
  console.log(`Verifying slugs: ${slugs.join(", ")}\n`);

  // 1) our artifact (from DB)
  const artifact = await computeInspectionStats();
  const { start, end } = artifact.period;
  console.log(`Period: ${start} .. ${end}\n`);

  // 2) independent Socrata recompute
  console.log("Recomputing independently from Socrata (full history)…");
  const socrata = await socrataRecompute(slugs, start, end);

  // 3) diff
  console.log(`\n=== fair-and-true comparison (period ${start}..${end}) ===\n`);
  console.log(
    "  slug                       | DB sample  DB pass%  | SOC sample  SOC pass% | Δsample  Δpass%"
  );
  console.log("  " + "-".repeat(96));

  for (const slug of slugs) {
    const a = artifact.types.find((t) => t.slug === slug);
    const s = socrata.get(slug) ?? { passed: 0, failed: 0, nondecisive: 0 };
    const sSample = s.passed + s.failed;
    const sRate = sSample > 0 ? s.passed / sSample : null;

    const aSample = a?.sample_size ?? 0;
    const aRate = a?.first_time_pass_rate ?? null;

    const dSample = aSample - sSample;
    const dRate =
      aRate !== null && sRate !== null ? (aRate - sRate) * 100 : null;

    const fmtPct = (r: number | null) => (r === null ? "  n/a " : (r * 100).toFixed(2).padStart(6));
    console.log(
      `  ${slug.padEnd(26)} | ${String(aSample).padStart(8)}  ${fmtPct(aRate)}  | ` +
      `${String(sSample).padStart(9)}  ${fmtPct(sRate)} | ${String(dSample).padStart(7)}  ` +
      `${dRate === null ? "  n/a " : dRate.toFixed(2).padStart(6)}`
    );
  }

  console.log(
    `\n  Δ tolerance note: small deltas are expected from ingest lag (our DB lags the live\n` +
    `  dataset) and Socrata's own refresh timing. Large deltas → ingest gap or logic drift.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("verify failed:", err);
  process.exit(1);
});
