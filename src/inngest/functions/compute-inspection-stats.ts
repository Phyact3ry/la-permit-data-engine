/**
 * compute-inspection-stats.ts — inspection stats pipeline.
 *
 * Weekly: compute first-time pass rate per ADU inspection type and publish a new
 * snapshot row into inspection_stats_snapshots. The CF Worker serves the
 * latest snapshot to the site.
 *
 * Idempotency: each run INSERTs a fresh snapshot (no upsert). A failed
 * or partial run throws, marks pipeline_state error, and writes NO snapshot — so
 * the previous successful snapshot stays "latest". History accumulates.
 *
 * Triggers: weekly cron + manual event "inspection-stats/compute".
 */

import { inngest } from "../client";
import { db } from "../../lib/db";
import { inspectionStatsSnapshots, pipelineState } from "../../schema";
import { eq, sql } from "drizzle-orm";
import { computeInspectionStats } from "../../lib/compute-inspection-stats";

const PIPELINE_NAME = "compute-inspection-stats";

export const computeInspectionStatsFn = inngest.createFunction(
  {
    id:      "compute-inspection-stats",
    name:    "Compute ADU Inspection Stats",
    retries: 3,
    triggers: [
      { cron: "0 6 * * 0" }, // Sundays 06:00 UTC, after link-permits (05:00)
      { event: "inspection-stats/compute" },
    ],
  },

  async ({ step, logger }) => {
    await step.run("update-state-running", async () => {
      await db
        .insert(pipelineState)
        .values({ pipelineName: PIPELINE_NAME, status: "running", recordsProcessed: 0, error: null })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set:    { status: "running", recordsProcessed: 0, error: null },
        });
      logger.info("[inspection-stats] Pipeline started");
    });

    // Pure read aggregation → artifact. Heavy step; memoized by Inngest on replay.
    const artifact = await step.run("compute", async () => {
      const a = await computeInspectionStats();
      const published = a.types.filter((t) => t.published).length;
      logger.info(
        `[inspection-stats] Computed ${a.types.length} types, ${published} published ` +
        `(period ${a.period.start}..${a.period.end})`
      );
      return a;
    });

    // New snapshot row — history preserved, no upsert.
    await step.run("persist-snapshot", async () => {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION READ WRITE`);
        await tx.insert(inspectionStatsSnapshots).values({
          snapshotDate:    artifact.snapshot_date,
          periodStart:     artifact.period.start,
          periodEnd:       artifact.period.end,
          sampleThreshold: artifact.sample_threshold,
          payload:         artifact,
        });
      });
      logger.info(`[inspection-stats] Snapshot persisted for ${artifact.snapshot_date}`);
    });

    const publishedCount = artifact.types.filter((t) => t.published).length;

    await step.run("update-state-done", async () => {
      await db
        .update(pipelineState)
        .set({
          status:           "done",
          lastRunAt:        new Date(),
          recordsProcessed: publishedCount,
          error:            null,
        })
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      logger.info(`[inspection-stats] Done — ${publishedCount} types published`);
    });

    return { snapshotDate: artifact.snapshot_date, publishedTypes: publishedCount };
  }
);
