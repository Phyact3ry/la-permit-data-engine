import { inngest } from "../client";
import { db } from "../../lib/db";
import { contractorsEnriched, enrichmentSignals, pipelineState } from "../../schema";
import { eq, sql } from "drizzle-orm";
import type { IcpTier } from "../../schema";

const PIPELINE_NAME = "compute-icp-scores";
const BATCH_SIZE = 200;

type CeRow = {
  id: string;
  permit_count_active: number;
  permit_count_by_city: Record<string, number> | null;
  has_active_license: boolean;
  years_in_business: number | null;
  license_expiry: string | null;
  worker_comp_expiry: string | null;
  inspection_pass_rate: number | null;
  avg_days_between_inspections: number | null;
  correction_rate_by_trade: Record<string, number> | null;
  google_rating: number | null;
  review_count: number | null;
  social_links: unknown | null;
  website: string | null;
};

type PermitAggr = {
  contractor_id: string;
  computed_permit_total: number;
  computed_total_valuation_cents: string; // BIGINT → string from pg driver
  computed_adu_permit_count: number;
};

type ComputedRow = {
  id: string;
  icpScore: number;
  icpTier: IcpTier;
  dimensions: {
    permit_activity: number;
    pain: number;
    maturity: number;
    adu_focus: number;
    digital: number;
    reach: number;
  };
  permitCountTotal: number;
  totalValuationCents: number;
  avgValuationCents: number;
  permitCountActive: number;
  digitalScore: number;
  aduPermitCount: number;
  citiesCount: number;
  licenseExpiry: string | null;
  workerCompExpiry: string | null;
};

function computePermitActivity(
  row: CeRow,
  permitTotal: number,
  totalCents: number
): number {
  const activeBonus = row.permit_count_active > 0 ? 40 : 0;
  const totalScore = Math.min(permitTotal / 50, 1) * 40;
  const valuationScore = Math.min(totalCents / 500_000_000, 1) * 20;
  return activeBonus + totalScore + valuationScore;
}

function computePain(row: CeRow): number {
  if (row.inspection_pass_rate === null) return 50;
  let score = (1 - row.inspection_pass_rate) * 60;
  if (
    row.correction_rate_by_trade !== null &&
    Object.values(row.correction_rate_by_trade).some((v) => v > 0.3)
  ) {
    score += 20;
  }
  if (row.avg_days_between_inspections !== null && row.avg_days_between_inspections > 14) {
    score += 20;
  }
  return score;
}

function computeMaturity(row: CeRow): number {
  if (!row.has_active_license) return 0;
  let score = 40;
  score += Math.min((row.years_in_business ?? 0) / 20, 1) * 30;
  const in90 = new Date(Date.now() + 90 * 86_400_000);
  if (row.license_expiry === null || new Date(row.license_expiry) >= in90) score += 15;
  if (row.worker_comp_expiry === null || new Date(row.worker_comp_expiry) >= in90) score += 15;
  return score;
}

function computeDigital(row: CeRow): number {
  let score = 0;
  if (row.website !== null) score += 40;
  if (row.google_rating !== null) {
    score += Math.max(0, ((row.google_rating - 1) / 4) * 30);
  }
  if ((row.review_count ?? 0) >= 20) score += 20;
  else if ((row.review_count ?? 0) >= 5) score += 10;
  if (row.social_links !== null) score += 10;
  return score;
}

function computeReach(row: CeRow): number {
  const count = Object.keys(row.permit_count_by_city ?? {}).length;
  if (count === 0) return 0;
  if (count === 1) return 20;
  if (count <= 3) return 50;
  return 100;
}

function assignTier(score: number): IcpTier {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  return "D";
}

export const computeIcpScores = inngest.createFunction(
  {
    id: "compute-icp-scores",
    name: "Compute ICP Scores",
    retries: 3,
    triggers: [
      { cron: "0 6 * * 2" },
      { event: "icp/compute" },
    ],
  },

  async ({ step, logger }) => {
    await step.run("update-state-running", async () => {
      await db
        .insert(pipelineState)
        .values({ pipelineName: PIPELINE_NAME, status: "running", recordsProcessed: 0, error: null })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: { status: "running", recordsProcessed: 0, error: null },
        });
      logger.info("[compute-icp] Pipeline started");
    });

    const resumeCursor = await step.run("read-cursor", async () => {
      const [row] = await db
        .select({ lastCursor: pipelineState.lastCursor })
        .from(pipelineState)
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      return row?.lastCursor ?? null;
    });

    let lastProcessedId: string | null = resumeCursor;
    let totalProcessed = 0;
    let batchIndex = 0;

    if (lastProcessedId) {
      logger.info(`[compute-icp] Resuming from cursor: ${lastProcessedId}`);
    }

    while (true) {
      const currentLastId: string | null = lastProcessedId;
      const batchIdx: number = batchIndex;

      const batchResult = await step.run(
        `process-batch-${batchIdx}`,
        async (): Promise<{ done: boolean; processed: number; lastId: string | null }> => {

          // Query 1: contractors page — fast primary-key range scan, no join
          const whereClause = currentLastId === null
            ? sql`TRUE`
            : sql`ce.id > ${currentLastId}`;

          const ceResult = await db.execute(sql`
            SELECT * FROM contractors_enriched ce
            WHERE ${whereClause}
            ORDER BY ce.id
            LIMIT ${BATCH_SIZE}
          `);
          const ceRows = ceResult.rows as unknown as CeRow[];

          if (ceRows.length === 0) {
            return { done: true, processed: 0, lastId: currentLastId };
          }

          // Query 2: permit aggregates for this batch only — indexed lookup on contractor_id
          const idList = sql.join(ceRows.map((r) => sql`${r.id}`), sql`, `);
          const permitsResult = await db.execute(sql`
            SELECT
              contractor_id,
              CAST(COUNT(id) AS INT) AS computed_permit_total,
              CAST(COALESCE(SUM(valuation_usd), 0) * 100 AS BIGINT) AS computed_total_valuation_cents,
              CAST(COALESCE(SUM(CASE WHEN adu_flag = true THEN 1 ELSE 0 END), 0) AS INT) AS computed_adu_permit_count
            FROM permits
            WHERE contractor_id IN (${idList})
            GROUP BY contractor_id
          `);

          const permitsMap = new Map<string, PermitAggr>();
          for (const r of permitsResult.rows as unknown as PermitAggr[]) {
            permitsMap.set(r.contractor_id, r);
          }

          const now = new Date();
          const in90 = new Date(Date.now() + 90 * 86_400_000);

          const computedBatch: ComputedRow[] = ceRows.map((row) => {
            const aggr = permitsMap.get(row.id);
            const permitTotal = aggr?.computed_permit_total ?? 0;
            const totalCents = Number(aggr?.computed_total_valuation_cents ?? "0");
            const aduCount = aggr?.computed_adu_permit_count ?? 0;
            const citiesCount = Object.keys(row.permit_count_by_city ?? {}).length;

            const permitActivity = computePermitActivity(row, permitTotal, totalCents);
            const pain = computePain(row);
            const maturity = computeMaturity(row);
            const aduFocus = Math.min(aduCount / 5, 1) * 100;
            const digital = computeDigital(row);
            const reach = computeReach(row);

            const icpScore =
              permitActivity * 0.25 +
              pain           * 0.25 +
              maturity       * 0.20 +
              aduFocus       * 0.15 +
              digital        * 0.10 +
              reach          * 0.05;

            const avgValuationCents =
              permitTotal > 0
                ? Math.min(Math.round(totalCents / permitTotal), 2_000_000_000)
                : 0;

            return {
              id: row.id,
              icpScore: Math.round(icpScore * 100) / 100,
              icpTier: assignTier(icpScore),
              dimensions: {
                permit_activity: permitActivity,
                pain,
                maturity,
                adu_focus: aduFocus,
                digital,
                reach,
              },
              permitCountTotal: permitTotal,
              totalValuationCents: Math.min(totalCents, 2_000_000_000),
              avgValuationCents,
              permitCountActive: row.permit_count_active,
              digitalScore: digital,
              aduPermitCount: aduCount,
              citiesCount,
              licenseExpiry: row.license_expiry,
              workerCompExpiry: row.worker_comp_expiry,
            };
          });

          const allSignalRows = computedBatch.flatMap((r) => {
            const permitVelocityActive = r.permitCountActive > 0;
            const digitalPresenceLow = r.digitalScore < 50;
            const aduActiveFlag = r.aduPermitCount > 0;
            const multiCityActive = r.citiesCount >= 2;
            const licenseExpiringActive =
              r.licenseExpiry !== null &&
              new Date(r.licenseExpiry) >= now &&
              new Date(r.licenseExpiry) < in90;
            const workersCompLapsed =
              r.workerCompExpiry !== null && new Date(r.workerCompExpiry) < now;

            return [
              {
                contractorId: r.id,
                signalType: "permit_velocity_high" as const,
                signalValue: Math.min(r.permitCountActive / 10, 1.0),
                isActive: permitVelocityActive,
                detectedAt: permitVelocityActive ? now : null,
              },
              {
                contractorId: r.id,
                signalType: "digital_presence_low" as const,
                signalValue: 1 - r.digitalScore / 100,
                isActive: digitalPresenceLow,
                detectedAt: digitalPresenceLow ? now : null,
              },
              {
                contractorId: r.id,
                signalType: "adu_active" as const,
                signalValue: Math.min(r.aduPermitCount / 5, 1.0),
                isActive: aduActiveFlag,
                detectedAt: aduActiveFlag ? now : null,
              },
              {
                contractorId: r.id,
                signalType: "multi_city_active" as const,
                signalValue: Math.min(r.citiesCount / 10, 1.0),
                isActive: multiCityActive,
                detectedAt: multiCityActive ? now : null,
              },
              {
                contractorId: r.id,
                signalType: "license_expiring_soon" as const,
                signalValue: licenseExpiringActive ? 1.0 : 0,
                isActive: licenseExpiringActive,
                detectedAt: licenseExpiringActive ? now : null,
              },
              {
                contractorId: r.id,
                signalType: "workers_comp_lapsed" as const,
                signalValue: workersCompLapsed ? 1.0 : 0,
                isActive: workersCompLapsed,
                detectedAt: workersCompLapsed ? now : null,
              },
            ];
          });

          await db.transaction(async (tx) => {
            await tx.execute(sql`SET TRANSACTION READ WRITE`);

            const ceUpdateRows = sql.join(
              computedBatch.map((r) =>
                sql`(
                  ${r.id}::text,
                  ${r.icpScore}::real,
                  ${r.icpTier}::icp_tier,
                  ${JSON.stringify(r.dimensions)}::jsonb,
                  ${r.permitCountTotal}::int,
                  ${Math.min(r.totalValuationCents, 2_000_000_000)}::int,
                  ${Math.min(r.avgValuationCents, 2_000_000_000)}::int
                )`
              ),
              sql`, `
            );

            await tx.execute(sql`
              UPDATE contractors_enriched AS ce
              SET icp_score               = m.icp_score,
                  icp_tier                = m.icp_tier,
                  icp_score_dimensions    = m.dimensions,
                  permit_count_total      = m.pct,
                  total_project_valuation = m.tpv,
                  avg_project_valuation   = m.apv,
                  updated_at              = now()
              FROM (VALUES ${ceUpdateRows})
                AS m(id, icp_score, icp_tier, dimensions, pct, tpv, apv)
              WHERE ce.id = m.id
            `);

            await tx
              .insert(enrichmentSignals)
              .values(allSignalRows)
              .onConflictDoUpdate({
                target: [enrichmentSignals.contractorId, enrichmentSignals.signalType],
                set: {
                  signalValue: sql`EXCLUDED.signal_value`,
                  isActive:    sql`EXCLUDED.is_active`,
                  detectedAt:  sql`CASE WHEN EXCLUDED.is_active = true THEN EXCLUDED.detected_at ELSE ${enrichmentSignals.detectedAt} END`,
                  updatedAt:   sql`now()`,
                },
              });
          });

          logger.info(`[compute-icp] Batch ${batchIdx}: ${ceRows.length} contractors scored`);

          return {
            done: ceRows.length < BATCH_SIZE,
            processed: ceRows.length,
            lastId: ceRows[ceRows.length - 1].id,
          };
        }
      );

      totalProcessed += batchResult.processed;
      if (batchResult.done) break;
      lastProcessedId = batchResult.lastId;

      await step.run(`save-cursor-${batchIndex}`, async () => {
        await db
          .update(pipelineState)
          .set({ lastCursor: lastProcessedId })
          .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      });

      batchIndex++;
    }

    await step.run("update-state-done", async () => {
      await db
        .update(pipelineState)
        .set({
          status:           "done",
          lastRunAt:        new Date(),
          recordsProcessed: totalProcessed,
          lastCursor:       null,
          error:            null,
        })
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      logger.info(`[compute-icp] Done — ${totalProcessed} contractors scored`);
    });

    return { processed: totalProcessed };
  }
);
