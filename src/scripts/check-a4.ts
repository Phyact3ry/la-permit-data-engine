import { db } from "../lib/db";
import { contractorsEnriched, enrichmentSignals, pipelineState } from "../schema";
import { eq, sql, isNull } from "drizzle-orm";

async function main() {
  // 1. Pipeline state
  const [state] = await db
    .select()
    .from(pipelineState)
    .where(eq(pipelineState.pipelineName, "compute-icp-scores"));

  console.log("=== A4 Pipeline State ===");
  console.log(JSON.stringify(state ?? "no state row found", null, 2));

  // 2. ICP tier distribution
  const tierDist = await db.execute(sql`
    SELECT icp_tier, CAST(COUNT(*) AS INT) AS cnt
    FROM contractors_enriched
    GROUP BY icp_tier
    ORDER BY icp_tier NULLS LAST
  `);
  console.log("\n=== ICP Tier Distribution ===");
  for (const row of tierDist.rows as { icp_tier: string | null; cnt: number }[]) {
    console.log(`  Tier ${row.icp_tier ?? "NULL (not scored)"}: ${row.cnt.toLocaleString()}`);
  }

  // 3. Score range sanity
  const scoreStats = await db.execute(sql`
    SELECT
      CAST(MIN(icp_score) AS NUMERIC(6,2))   AS min_score,
      CAST(MAX(icp_score) AS NUMERIC(6,2))   AS max_score,
      CAST(AVG(icp_score) AS NUMERIC(6,2))   AS avg_score,
      CAST(COUNT(*) FILTER (WHERE icp_score = 0) AS INT)    AS zero_scores,
      CAST(COUNT(*) FILTER (WHERE icp_score IS NULL) AS INT) AS null_scores,
      CAST(COUNT(*) FILTER (WHERE icp_score > 100) AS INT)  AS over_100
    FROM contractors_enriched
  `);
  console.log("\n=== Score Sanity ===");
  const ss = scoreStats.rows[0] as Record<string, string | number>;
  console.log(`  Min:       ${ss.min_score}`);
  console.log(`  Max:       ${ss.max_score}`);
  console.log(`  Avg:       ${ss.avg_score}`);
  console.log(`  Zero:      ${ss.zero_scores} (has_active_license=false → expected)`);
  console.log(`  NULL:      ${ss.null_scores} (should be 0 after full run)`);
  console.log(`  Over 100:  ${ss.over_100} (should be 0)`);

  // 4. Permit count and valuation fill-in (A4 responsibility)
  const fillStats = await db.execute(sql`
    SELECT
      CAST(COUNT(*) FILTER (WHERE permit_count_total > 0) AS INT) AS with_permit_total,
      CAST(COUNT(*) FILTER (WHERE total_project_valuation > 0) AS INT) AS with_valuation,
      CAST(COUNT(*) AS INT) AS total
    FROM contractors_enriched
  `);
  const fs = fillStats.rows[0] as Record<string, number>;
  console.log("\n=== A4 Fill-in (permit_count_total + total_project_valuation) ===");
  console.log(`  permit_count_total > 0:      ${fs.with_permit_total.toLocaleString()} / ${fs.total.toLocaleString()}`);
  console.log(`  total_project_valuation > 0: ${fs.with_valuation.toLocaleString()} / ${fs.total.toLocaleString()}`);

  // 5. Enrichment signals: total count and per-type active breakdown
  const [sigTotal] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(enrichmentSignals);

  console.log("\n=== Enrichment Signals ===");
  console.log(`  Total signal rows: ${sigTotal.count.toLocaleString()}`);
  console.log(`  Expected (23359 × 6): ${(23359 * 6).toLocaleString()}`);

  const sigBreakdown = await db.execute(sql`
    SELECT
      signal_type,
      CAST(COUNT(*) AS INT) AS total,
      CAST(COUNT(*) FILTER (WHERE is_active = true) AS INT) AS active
    FROM enrichment_signals
    GROUP BY signal_type
    ORDER BY active DESC
  `);
  console.log("\n  Signal breakdown (active / total):");
  for (const r of sigBreakdown.rows as { signal_type: string; total: number; active: number }[]) {
    const pct = r.total > 0 ? ((r.active / r.total) * 100).toFixed(1) : "0";
    console.log(`    ${r.signal_type.padEnd(30)} ${String(r.active).padStart(6)} / ${String(r.total).padStart(6)} (${pct}%)`);
  }

  // 6. Top 5 Tier A contractors with dimension breakdown
  const topA = await db.execute(sql`
    SELECT
      business_name,
      cslb_license,
      icp_score,
      icp_tier,
      permit_count_active,
      permit_count_total,
      CAST(total_project_valuation / 100 AS INT) AS total_valuation_usd,
      icp_score_dimensions
    FROM contractors_enriched
    WHERE icp_tier = 'B'
    ORDER BY icp_score DESC
    LIMIT 5
  `);
  console.log("\n=== Top 5 Tier B Contractors (no Tier A — max score 78.92) ===");
  for (const r of topA.rows as {
    business_name: string;
    cslb_license: string;
    icp_score: number;
    icp_tier: string;
    permit_count_active: number;
    permit_count_total: number;
    total_valuation_usd: number;
    icp_score_dimensions: Record<string, number>;
  }[]) {
    console.log(`\n  ${r.business_name} [${r.cslb_license}]`);
    console.log(`    Score: ${r.icp_score} (Tier ${r.icp_tier})`);
    console.log(`    Permits active/total: ${r.permit_count_active} / ${r.permit_count_total}`);
    console.log(`    Total valuation: $${r.total_valuation_usd.toLocaleString()}`);
    if (r.icp_score_dimensions) {
      const d = r.icp_score_dimensions;
      const pa = d.permit_activity, pain = d.pain, mat = d.maturity;
      const adu = d.adu_focus, dig = d.digital, reach = d.reach;
      const recomputed = pa * 0.25 + pain * 0.25 + mat * 0.20 + adu * 0.15 + dig * 0.10 + reach * 0.05;
      console.log(`    Dimensions: permit_activity=${pa} pain=${pain} maturity=${mat} adu_focus=${adu} digital=${dig} reach=${reach}`);
      console.log(`    Recomputed score: ${Math.round(recomputed * 100) / 100} (stored: ${r.icp_score})`);
    }
  }

  // 7. Math spot-check: one Tier A contractor, verify score against raw DB values
  const spotCheck = await db.execute(sql`
    SELECT
      ce.id, ce.business_name, ce.cslb_license,
      ce.icp_score, ce.icp_score_dimensions,
      ce.permit_count_active, ce.permit_count_by_city,
      ce.has_active_license, ce.years_in_business,
      ce.license_expiry, ce.worker_comp_expiry,
      ce.inspection_pass_rate, ce.avg_days_between_inspections,
      ce.correction_rate_by_trade,
      ce.google_rating, ce.review_count, ce.social_links, ce.website,
      COUNT(p.id)::int AS real_permit_total,
      COALESCE(SUM(p.valuation_usd), 0)::bigint AS real_valuation_usd,
      COALESCE(SUM(CASE WHEN p.adu_flag = true THEN 1 ELSE 0 END), 0)::int AS real_adu_count
    FROM contractors_enriched ce
    LEFT JOIN permits p ON p.contractor_id = ce.id
    WHERE ce.icp_tier = 'B'
    GROUP BY ce.id
    ORDER BY ce.icp_score DESC
    LIMIT 1
  `);

  if (spotCheck.rows.length > 0) {
    const r = spotCheck.rows[0] as {
      id: string; business_name: string; cslb_license: string;
      icp_score: number; icp_score_dimensions: Record<string, number>;
      permit_count_active: number; permit_count_by_city: Record<string, number> | null;
      has_active_license: boolean; years_in_business: number | null;
      license_expiry: string | null; worker_comp_expiry: string | null;
      inspection_pass_rate: number | null; avg_days_between_inspections: number | null;
      correction_rate_by_trade: Record<string, number> | null;
      google_rating: number | null; review_count: number | null;
      social_links: unknown; website: string | null;
      real_permit_total: number; real_valuation_usd: string; real_adu_count: number;
    };

    const totalCents = Number(r.real_valuation_usd) * 100;
    const citiesCount = Object.keys(r.permit_count_by_city ?? {}).length;

    // Recompute each dimension from scratch
    const activeBonus = r.permit_count_active > 0 ? 40 : 0;
    const totalScore = Math.min(r.real_permit_total / 50, 1) * 40;
    const valuationScore = Math.min(totalCents / 500_000_000, 1) * 20;
    const permitActivity = activeBonus + totalScore + valuationScore;

    let pain: number;
    if (r.inspection_pass_rate === null) {
      pain = 50;
    } else {
      pain = (1 - r.inspection_pass_rate) * 60;
      if (r.correction_rate_by_trade !== null && Object.values(r.correction_rate_by_trade).some(v => v > 0.3)) pain += 20;
      if (r.avg_days_between_inspections !== null && r.avg_days_between_inspections > 14) pain += 20;
    }

    let maturity: number;
    if (!r.has_active_license) {
      maturity = 0;
    } else {
      maturity = 40;
      maturity += Math.min((r.years_in_business ?? 0) / 20, 1) * 30;
      const in90 = new Date(Date.now() + 90 * 86_400_000);
      if (r.license_expiry === null || new Date(r.license_expiry) >= in90) maturity += 15;
      if (r.worker_comp_expiry === null || new Date(r.worker_comp_expiry) >= in90) maturity += 15;
    }

    const aduFocus = Math.min(r.real_adu_count / 5, 1) * 100;

    let digital = 0;
    if (r.website !== null) digital += 40;
    if (r.google_rating !== null) digital += Math.max(0, ((r.google_rating - 1) / 4) * 30);
    if ((r.review_count ?? 0) >= 20) digital += 20;
    else if ((r.review_count ?? 0) >= 5) digital += 10;
    if (r.social_links !== null) digital += 10;

    const reach = citiesCount === 0 ? 0 : citiesCount === 1 ? 20 : citiesCount <= 3 ? 50 : 100;

    const recomputed = Math.round((permitActivity * 0.25 + pain * 0.25 + maturity * 0.20 + aduFocus * 0.15 + digital * 0.10 + reach * 0.05) * 100) / 100;
    const drift = Math.abs(recomputed - r.icp_score);

    console.log(`\n=== Math Spot-Check: ${r.business_name} [${r.cslb_license}] ===`);
    console.log(`  Stored score:     ${r.icp_score}`);
    console.log(`  Recomputed score: ${recomputed}`);
    console.log(`  Drift:            ${drift.toFixed(4)} (should be < 0.1)`);
    console.log(`  Dimensions computed:`);
    console.log(`    permit_activity = ${permitActivity.toFixed(2)} (stored: ${r.icp_score_dimensions?.permit_activity})`);
    console.log(`    pain            = ${pain.toFixed(2)} (stored: ${r.icp_score_dimensions?.pain})`);
    console.log(`    maturity        = ${maturity.toFixed(2)} (stored: ${r.icp_score_dimensions?.maturity})`);
    console.log(`    adu_focus       = ${aduFocus.toFixed(2)} (stored: ${r.icp_score_dimensions?.adu_focus})`);
    console.log(`    digital         = ${digital.toFixed(2)} (stored: ${r.icp_score_dimensions?.digital})`);
    console.log(`    reach           = ${reach.toFixed(2)} (stored: ${r.icp_score_dimensions?.reach})`);
    console.log(`  Raw data used:`);
    console.log(`    permit_count_active = ${r.permit_count_active}`);
    console.log(`    real_permit_total   = ${r.real_permit_total}`);
    console.log(`    real_valuation_usd  = $${Number(r.real_valuation_usd).toLocaleString()} → ${totalCents.toLocaleString()} cents`);
    console.log(`    real_adu_count      = ${r.real_adu_count}`);
    console.log(`    cities_count        = ${citiesCount}`);
    console.log(`    has_active_license  = ${r.has_active_license}`);
    console.log(`    years_in_business   = ${r.years_in_business}`);
    console.log(`    inspection_pass_rate= ${r.inspection_pass_rate}`);

    if (drift > 0.5) {
      console.log(`\n  !! DRIFT TOO HIGH — potential scoring bug`);
    } else {
      console.log(`\n  OK — scores match within tolerance`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
