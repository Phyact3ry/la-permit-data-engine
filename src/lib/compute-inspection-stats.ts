/**
 * compute-inspection-stats.ts — core "first-time pass rate" engine.
 *
 * Pure read: aggregates the `inspections` table and returns the machine-readable
 * artifact. Does NOT write —
 * persisting a snapshot is the Inngest function's job.
 *
 * Methodology:
 *   • Group inspections by (permit_ref, slug). slug rolls up 1+ raw LADBS types.
 *   • The FIRST attempt of a (permit, slug) pair is the earliest inspection_date
 *     over ALL history (ROW_NUMBER … = 1). We do NOT pre-filter by the window
 *     before picking the first attempt — that would let a later attempt of an
 *     old permit masquerade as "first" and bias the fail rate upward.
 *   • A pair enters the cohort only if its first attempt falls inside the rolling
 *     window. Its result is classified via the taxonomy:
 *        pass  → passed
 *        fail  → failed
 *        nondecisive / unknown → excluded from the denominator (counted separately).
 *   • first_time_pass_rate = passed / (passed + failed).
 *   • Types with (passed+failed) < threshold → published:false, rates null.
 */

import { db } from "./db";
import { sql } from "drizzle-orm";
import {
  INSPECTION_TYPES,
  resultClassRows,
  SAMPLE_THRESHOLD,
} from "./inspection-taxonomy";

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface InspectionTypeStats {
  slug: string;
  name: string;
  ladbs_types: string[];
  tier: 1 | 2;
  sample_size: number;               // passed + failed (decisive first attempts)
  passed: number;
  failed: number;
  excluded_nondecisive: number;
  first_time_pass_rate: number | null; // null if below threshold
  first_time_fail_rate: number | null; // null if below threshold
  published: boolean;
}

export interface InspectionStatsArtifact {
  snapshot_date: string; // 'YYYY-MM-DD'
  period: { start: string; end: string; label: string };
  source: {
    agency: string;
    dataset: string;
    dataset_url: string;
    geo: string;
  };
  methodology: string;
  sample_threshold: number;
  types: InspectionTypeStats[];
}

export interface ComputeOptions {
  windowMonths?: number; // rolling window length, default 12
  threshold?: number;    // min decisive sample to publish, default SAMPLE_THRESHOLD
  asOf?: Date;           // window end / snapshot date, default now
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Format a Date as 'YYYY-MM-DD' (UTC-stable for date-only math). */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function subMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() - months);
  return r;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ─── CORE ─────────────────────────────────────────────────────────────────────

export async function computeInspectionStats(
  opts: ComputeOptions = {}
): Promise<InspectionStatsArtifact> {
  const windowMonths = opts.windowMonths ?? 12;
  const threshold = opts.threshold ?? SAMPLE_THRESHOLD;
  const asOf = opts.asOf ?? new Date();

  const periodEnd = ymd(asOf);
  const periodStart = ymd(subMonths(asOf, windowMonths));

  // raw inspection_type → slug VALUES list (single source of truth: taxonomy)
  const typeMapRows = sql.join(
    INSPECTION_TYPES.flatMap((t) =>
      t.ladbsTypes.map((rt) => sql`(${rt}, ${t.slug})`)
    ),
    sql`, `
  );

  // (slug, inspection_result) → 'pass'|'fail' VALUES list. slug '*' = default map;
  // a per-slug override row takes precedence. nondecisive is the fallthrough.
  const resClassRows = sql.join(
    resultClassRows().map((r) => sql`(${r.slug}, ${r.result}, ${r.cls})`),
    sql`, `
  );

  const result = await db.execute(sql`
    WITH type_map(raw_type, slug) AS (VALUES ${typeMapRows}),
    res_class(slug, result, cls) AS (VALUES ${resClassRows}),
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
    ),
    cohort AS (
      SELECT
        fa.slug,
        -- per-slug override wins, else default ('*'), else nondecisive
        COALESCE(ov.cls, def.cls, 'nondecisive') AS cls
      FROM first_attempt fa
      LEFT JOIN res_class ov  ON ov.slug = fa.slug AND ov.result = fa.result
      LEFT JOIN res_class def ON def.slug = '*'     AND def.result = fa.result
      WHERE fa.rn = 1
        AND fa.idate >= ${periodStart}::date
        AND fa.idate <= ${periodEnd}::date
    )
    SELECT
      slug,
      COUNT(*) FILTER (WHERE cls = 'pass')::int        AS passed,
      COUNT(*) FILTER (WHERE cls = 'fail')::int        AS failed,
      COUNT(*) FILTER (WHERE cls = 'nondecisive')::int AS nondecisive
    FROM cohort
    GROUP BY slug
  `);

  const bySlug = new Map<
    string,
    { passed: number; failed: number; nondecisive: number }
  >();
  for (const row of result.rows as {
    slug: string;
    passed: number;
    failed: number;
    nondecisive: number;
  }[]) {
    bySlug.set(row.slug, {
      passed: Number(row.passed),
      failed: Number(row.failed),
      nondecisive: Number(row.nondecisive),
    });
  }

  // Emit ALL 8 types (even tier-2 / zero-row ones); threshold decides published.
  const types: InspectionTypeStats[] = INSPECTION_TYPES.map((t) => {
    const agg = bySlug.get(t.slug) ?? { passed: 0, failed: 0, nondecisive: 0 };
    const sampleSize = agg.passed + agg.failed;
    const published = sampleSize >= threshold;
    const passRate = published && sampleSize > 0 ? round4(agg.passed / sampleSize) : null;
    return {
      slug: t.slug,
      name: t.name,
      ladbs_types: t.ladbsTypes,
      tier: t.tier,
      sample_size: sampleSize,
      passed: agg.passed,
      failed: agg.failed,
      excluded_nondecisive: agg.nondecisive,
      first_time_pass_rate: passRate,
      first_time_fail_rate: passRate === null ? null : round4(1 - passRate),
      published,
    };
  });

  return {
    snapshot_date: periodEnd,
    period: {
      start: periodStart,
      end: periodEnd,
      label: `Trailing ${windowMonths} months`,
    },
    source: {
      agency: "LADBS",
      dataset: "9w5z-rg2h",
      dataset_url: "https://data.lacity.org/resource/9w5z-rg2h",
      geo: "City of Los Angeles",
    },
    methodology:
      "first-time pass rate per (permit, inspection type); non-decisive results excluded",
    sample_threshold: threshold,
    types,
  };
}
