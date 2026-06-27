/**
 * inspection-taxonomy.ts — single source of truth for the
 * "first-time pass rate" methodology.
 *
 * Two concerns live here:
 *   1. RESULT TAXONOMY — maps a raw Socrata `inspection_result` to a decisive
 *      class: 'pass' | 'fail' | 'nondecisive'. Unknown/missing → 'nondecisive'
 *      (never silently pass/fail). Non-decisive is excluded from the rate.
 *      The taxonomy is CONTEXT-SENSITIVE per slug (see SLUG_RESULT_OVERRIDES):
 *      a "Final" inspection passes by becoming "Permit Finaled", whereas a trade
 *      inspection passes by "Approved". The same string can mean different things.
 *   2. TYPE MAPPING — maps the 8 ADU inspection types to URL slugs.
 *
 * Grounded in the real result distribution of dataset 9w5z-rg2h (12-month window,
 * verified 2026-06-27):
 *   • Dataset has NO "Disapproved" — a failed trade inspection is "Corrections Issued".
 *   • For 'Final', "Approved" occurs ~14× in 12mo; the real pass signal is
 *     "Permit Finaled" (~94K). Hence the per-slug override.
 *   • "+B" DECISION (2026-07-01): a first attempt where the work was
 *     NOT READY when the inspector arrived counts as a first-time FAIL — uniformly,
 *     for every type. "Not Ready for Inspection" (default) and "SGSOV Not Ready"
 *     (SGSOV) are therefore 'fail', not 'nondecisive'. This resolves the old SGSOV
 *     ~100%-by-construction problem: SGSOV now has a real fail signal (~32%).
 *     We do NOT count "Partial Approval" as a fail (+C) — analysis showed a partial
 *     escalates to a real fail only ~2.3% of the time; it is routine incremental
 *     sign-off, so it stays 'nondecisive'.
 */

// ─── SAMPLE THRESHOLD ─────────────────────────────────────────────────────────

/** Types with fewer than this many decisive (pass+fail) first-attempt pairs
 *  are NOT published and show no percentage. Default 100. */
export const SAMPLE_THRESHOLD = 100;

// ─── RESULT TAXONOMY ──────────────────────────────────────────────────────────

export type ResultClass = "pass" | "fail" | "nondecisive";
type Decisive = Extract<ResultClass, "pass" | "fail">;

/**
 * DEFAULT classes — used for every slug unless overridden below.
 * Tuned for TRADE inspections (smoke, electrical, stucco, foundation, shear, framing),
 * where the pass signal is "Approved" and the fail signal is "Corrections Issued".
 * Anything NOT listed (here or in an override) → 'nondecisive'.
 */
export const DEFAULT_RESULT_TAXONOMY: Record<string, Decisive> = {
  // ── decisive PASS ──
  "Approved":                       "pass",
  "Approved Pending GreenApproval": "pass",
  "Event Approved":                 "pass",
  "Completed":                      "pass",
  "Completed (special insp)":       "pass",
  "Completed-MF (special insp)":    "pass",
  "No Violation (special insp)":    "pass",
  // REVIEW: "Conditional Approval" = approved with conditions. Defaulted to PASS.
  // Requires product/legal sign-off — moving it changes published percentages.
  "Conditional Approval":           "pass",

  // ── decisive FAIL ──
  // In 9w5z-rg2h the disapproval signal is "Corrections Issued", NOT "Disapproved".
  "Corrections Issued":             "fail",
  "Violation Observed":             "fail",
  "Order to Comply Issued":         "fail",
  "OTC Issued":                     "fail",
  "NOV Issued":                     "fail",
  // "+B" (2026-07-01): work not ready at the first attempt is a first-time fail.
  "Not Ready for Inspection":       "fail",

  // REVIEW: "Partial Approval" / "Partial Inspection" intentionally NOT here
  // (→ nondecisive). Analysis (2026-07-01) showed a partial escalates to a real
  // fail only ~2.3% of the time — routine incremental sign-off, so not a fail.
};

/**
 * Per-slug overrides MERGED onto the default map for that slug.
 * Only list values whose class DIFFERS from the default.
 */
export const SLUG_RESULT_OVERRIDES: Record<string, Record<string, Decisive>> = {
  // 'Final' passes by FINALING the permit, not by "Approved".
  final: {
    "Permit Finaled":   "pass",
    "CofO Issued":      "pass",
    "OK to Issue CofO": "pass",
    "OK for CofO":      "pass",
    "OK for CofC":      "pass",
    "OK for TCO":       "pass",
    // 'Permit Closed' / 'Permit Expired' / 'OK to Expire Permit' stay non-decisive
    // (permit ended without a passed final).
  },
  // SGSOV passes by "SGSOV Approved". Under "+B" (2026-07-01) a valve that is
  // "SGSOV Not Ready" at the first attempt counts as a first-time FAIL — this is
  // the SGSOV-specific readiness string, mirroring the default "Not Ready for
  // Inspection". SGSOV therefore has a real fail signal now (~32%), not ~100% pass.
  "gas-shutoff-valve-sgsov": {
    "SGSOV Approved":  "pass",
    "SGSOV Not Ready": "fail",
  },
};

/**
 * Classify a raw inspection_result for a given slug.
 * Trims input; unknown / empty / null → 'nondecisive'. Override wins over default.
 */
export function resultClass(
  raw: string | null | undefined,
  slug?: string | null
): ResultClass {
  if (!raw) return "nondecisive";
  const key = raw.trim();
  if (!key) return "nondecisive";
  if (slug) {
    const ov = SLUG_RESULT_OVERRIDES[slug]?.[key];
    if (ov) return ov;
  }
  return DEFAULT_RESULT_TAXONOMY[key] ?? "nondecisive";
}

/**
 * Flattened (slug, result, class) rows for SQL. slug '*' = default map.
 * Per-slug overrides are emitted with their actual slug and take precedence.
 */
export function resultClassRows(): { slug: string; result: string; cls: Decisive }[] {
  const rows: { slug: string; result: string; cls: Decisive }[] = [];
  for (const [result, cls] of Object.entries(DEFAULT_RESULT_TAXONOMY)) {
    rows.push({ slug: "*", result, cls });
  }
  for (const [slug, map] of Object.entries(SLUG_RESULT_OVERRIDES)) {
    for (const [result, cls] of Object.entries(map)) {
      rows.push({ slug, result, cls });
    }
  }
  return rows;
}

// ─── TYPE MAPPING (8 ADU inspection types) ───────────────────────────────────

export interface InspectionTypeDef {
  /** URL slug for the leaf page */
  slug: string;
  /** human-readable name shown on the page */
  name: string;
  /** raw LADBS `inspection` strings that roll up into this slug (verbatim) */
  ladbsTypes: string[];
  /** publishing tier: 1 = MVP leaf pages, 2 = next wave */
  tier: 1 | 2;
}

/**
 * Type strings are VERBATIM from the dataset, including the
 * source typo "Diaphrgm". Verified present (12-month volumes) on 2026-06-27.
 */
export const INSPECTION_TYPES: InspectionTypeDef[] = [
  { slug: "final",                   name: "ADU Final Inspection",                   tier: 1, ladbsTypes: ["Final"] },
  { slug: "smoke-co-detectors",      name: "ADU Smoke & CO Detector",                tier: 1, ladbsTypes: ["Smoke Detectors"] },
  { slug: "electrical-service",      name: "ADU Electrical Service / Power Release",  tier: 1, ladbsTypes: ["Service/Power Release"] },
  { slug: "gas-shutoff-valve-sgsov", name: "ADU Gas Shut-Off Valve (SGSOV)",          tier: 1, ladbsTypes: ["SGSOV-Seismic Gas S/O Valve"] },
  { slug: "stucco-lath",             name: "ADU Stucco & Lath",                       tier: 2, ladbsTypes: ["Interior/Exterior Lathing"] },
  { slug: "foundation-footing",      name: "ADU Foundation & Footing",                tier: 2, ladbsTypes: ["Footing/Foundation/Slab"] },
  { slug: "shear-wall-seismic",      name: "ADU Seismic Shear Wall",                  tier: 2, ladbsTypes: ["Floor/Roof Diaphrgm/Shear Wall"] },
  { slug: "framing-rough",           name: "ADU Framing / Rough",                     tier: 2, ladbsTypes: ["Rough", "BUILDING-Rough-Frame", "Wood Frame"] },
];

/** Tier-1 slugs — the 4 MVP leaf pages (D3). */
export const TIER1_SLUGS = INSPECTION_TYPES.filter((t) => t.tier === 1).map((t) => t.slug);

// ─── REVERSE LOOKUP ───────────────────────────────────────────────────────────

const RAW_TYPE_TO_SLUG: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const t of INSPECTION_TYPES) {
    for (const raw of t.ladbsTypes) m.set(raw, t.slug);
  }
  return m;
})();

/** Map a raw `inspection` type string to its slug, or null if it isn't one of the 8. */
export function ladbsTypeToSlug(rawType: string | null | undefined): string | null {
  if (!rawType) return null;
  return RAW_TYPE_TO_SLUG.get(rawType.trim()) ?? null;
}
