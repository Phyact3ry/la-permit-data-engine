/**
 * ingest-socrata.ts -- Inngest functions for Socrata data ingestion
 *
 * Function 1 (2.4): LA City Permits -- data.lacity.org/resource/vdg9-hy7c.json
 *   Cron: weekly (Monday 03:00 UTC)
 *   Steps: mark running -> resolve cursor -> paginated fetch+upsert -> LLM classify -> mark done
 *
 * Function 2 (2.5): LA City Inspections -- data.lacity.org/resource/9w5z-rg2h.json
 *   Cron: daily (04:00 UTC)
 *   Steps: mark running -> resolve cursor -> paginated fetch+upsert -> mark done
 *
 * Real inspections fields (verified 2026-04-23):
 *   permit, address, permit_status, inspection_date, inspection, inspection_result, lat_lon
 *   No inspection_number -- dedup key: (permit_ref, inspection_date, inspection_type)
 */

import { eq } from "drizzle-orm";
import { inngest } from "../client";
import { db } from "../../lib/db";
import { pipelineState } from "../../schema";
import {
  fetchAllPermits,
  mapSocrataPermit,
  upsertPermits,
  classifyUnclassifiedPermits,
  type SocrataPermitRaw,
} from "../../lib/socrata-permits-fetcher";
import {
  fetchAllInspections,
  mapSocrataInspection,
  upsertInspections,
  type SocrataInspectionRaw,
} from "../../lib/socrata-inspections-fetcher";

// =============================================================
// FUNCTION 1 -- LA City Permits (Socrata pi9x-tg5x)
// Pipeline name: "ingest-lacity-permits"
// =============================================================

export const ingestLacityPermits = inngest.createFunction(
  {
    id:      "ingest-lacity-permits",
    name:    "Ingest LA City Permits (Socrata)",
    retries: 3,
    triggers: [{ cron: "0 3 * * 1" }], // every Monday 03:00 UTC
  },

  async ({ step, logger }) => {

    // -- Step 1: Mark pipeline as running -----------------------------------------
    await step.run("update-state-running", async () => {
      await db
        .insert(pipelineState)
        .values({
          pipelineName:     "ingest-lacity-permits",
          status:           "running",
          recordsProcessed: 0,
          error:            null,
        })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: {
            status:           "running",
            recordsProcessed: 0,
            error:            null,
            // lastRunAt intentionally NOT updated here — Step 2 reads it as the
            // previous run's end time for delta filtering; Step 5 writes it.
          },
        });
      logger.info("[permits] Pipeline started");
    });

    // -- Step 2: Read cursor for delta mode ---------------------------------------
    const cursor = await step.run("resolve-cursor", async () => {
      const rows = await db
        .select({
          lastOffset: pipelineState.lastOffset,
          lastRunAt:  pipelineState.lastRunAt,
        })
        .from(pipelineState)
        .where(eq(pipelineState.pipelineName, "ingest-lacity-permits"))
        .limit(1);

      const row = rows[0];

      // Format lastRunAt as ISO string for SODA $where clause.
      // Socrata expects: "2025-04-01T00:00:00.000" (no Z suffix).
      // toISOString() returns "...211Z"; replace the ms+Z tail to avoid "...211.000".
      const lastRunAt = row?.lastRunAt
        ? row.lastRunAt.toISOString().replace(/\.\d{3}Z$/, ".000")
        : null;

      logger.info(
        `[permits] Cursor -- lastRunAt=${lastRunAt ?? "null (full scan)"}, ` +
        `lastOffset=${row?.lastOffset ?? 0}`
      );
      return { lastRunAt, lastOffset: row?.lastOffset ?? 0 };
    });

    // -- Step 3: Paginated fetch + upsert (batched, resumable) --------------------
    // 10 pages × 1K records = 10K per step. Reduced from 30 to avoid overwhelming
    // Supabase during initial full-scan (500K permits / 2M inspections).
    const PAGES_PER_STEP = 10; // 10K records per step ≈ 30–60s

    // For delta runs, always start from 0 (only changed records since lastRunAt).
    const initialOffset = cursor.lastRunAt ? 0 : cursor.lastOffset;
    let resumeOffset = initialOffset;
    let totalFetched  = 0;
    let batchIndex    = 0;

    while (true) {
      const batchOffset = resumeOffset; // capture for closure
      const batchIdx    = batchIndex;

      const batchResult = await step.run(`fetch-batch-${batchIdx}`, async () => {
        let fetched       = 0;
        let batchEndOffset = batchOffset;

        await fetchAllPermits({
          lastRunAt:   cursor.lastRunAt,
          startOffset: batchOffset,
          appToken:    process.env.SOCRATA_APP_TOKEN,
          maxPages:    PAGES_PER_STEP,

          onPage: async (rawPage: SocrataPermitRaw[], pNum: number) => {
            const mapped = rawPage
              .map(mapSocrataPermit)
              .filter((p): p is NonNullable<typeof p> => p !== null);

            await upsertPermits(mapped);
            fetched        += rawPage.length;
            // pNum is 1-indexed; each page advances offset by PAGE_SIZE (1000)
            batchEndOffset  = batchOffset + pNum * 1_000;

            logger.info(
              `[permits] Batch ${batchIdx} page ${pNum} -- ${rawPage.length} fetched` +
              ` (total so far: ${totalFetched + fetched})`
            );
          },
        });

        // Save progress so any retry/re-invoke resumes from here.
        // On the last batch (done=true) step 5 will reset lastOffset to 0.
        const done = fetched < PAGES_PER_STEP * 1_000;
        await db
          .update(pipelineState)
          .set({ lastOffset: done ? 0 : batchEndOffset })
          .where(eq(pipelineState.pipelineName, "ingest-lacity-permits"));

        return { fetched, nextOffset: batchEndOffset, done };
      });

      totalFetched += batchResult.fetched;
      if (batchResult.done) break;
      resumeOffset = batchResult.nextOffset;
      batchIndex++;
    }

    // -- Step 4: LLM classify new/unclassified permits ----------------------------
    // Classifies all permits where project_category_ai IS NULL.
    // Uses Claude Haiku in batches of 50 (see socrata-permits-fetcher.ts).
    const classified = await step.run("classify-work-descriptions", async () => {
      logger.info("[permits] Starting LLM classification...");
      const count = await classifyUnclassifiedPermits();
      logger.info(`[permits] Classification complete -- ${count} permits classified`);
      return count;
    });

    // -- Step 5: Mark pipeline done -----------------------------------------------
    await step.run("update-state-done", async () => {
      await db
        .update(pipelineState)
        .set({
          status:           "done",
          lastRunAt:        new Date(),
          recordsProcessed: totalFetched,
          lastOffset:       0, // reset -- delta mode uses :updated_at, not offset
          error:            null,
        })
        .where(eq(pipelineState.pipelineName, "ingest-lacity-permits"));

      logger.info(
        `[permits] Pipeline done -- ${totalFetched} fetched, ${classified} classified`
      );
    });

    return { fetched: totalFetched, classified };
  }
);

// =============================================================
// FUNCTION 2 -- LA City Inspections (Socrata 9w5z-rg2h)
// Pipeline name: "ingest-lacity-inspections"
// =============================================================

export const ingestLacityInspections = inngest.createFunction(
  {
    id:      "ingest-lacity-inspections",
    name:    "Ingest LA City Inspections (Socrata)",
    retries: 3,
    triggers: [{ cron: "0 4 * * *" }], // daily 04:00 UTC
  },

  async ({ step, logger }) => {

    // -- Step 1: Mark running -----------------------------------------------------
    // NOTE: lastRunAt is intentionally NOT set here. Step 2 reads the previous
    // run's lastRunAt as the delta cursor; Step 5 writes the new value.
    await step.run("update-state-running", async () => {
      await db
        .insert(pipelineState)
        .values({
          pipelineName:     "ingest-lacity-inspections",
          status:           "running",
          recordsProcessed: 0,
          error:            null,
        })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: {
            status:           "running",
            recordsProcessed: 0,
            error:            null,
          },
        });
      logger.info("[inspections] Pipeline started");
    });

    // -- Step 2: Resolve cursor for delta mode ------------------------------------
    const cursor = await step.run("resolve-cursor", async () => {
      const rows = await db
        .select({
          lastRunAt:  pipelineState.lastRunAt,
          lastOffset: pipelineState.lastOffset,
        })
        .from(pipelineState)
        .where(eq(pipelineState.pipelineName, "ingest-lacity-inspections"))
        .limit(1);

      const row = rows[0];

      // Format for SODA $where: "2025-04-01T00:00:00.000" (no Z suffix)
      // toISOString() returns "...211Z"; replace the ms+Z tail to avoid "...211.000".
      const lastRunAt = row?.lastRunAt
        ? row.lastRunAt.toISOString().replace(/\.\d{3}Z$/, ".000")
        : null;

      logger.info(
        `[inspections] Cursor -- lastRunAt=${lastRunAt ?? "null (full scan)"}, ` +
        `lastOffset=${row?.lastOffset ?? 0}`
      );
      return { lastRunAt, lastOffset: row?.lastOffset ?? 0 };
    });

    // -- Step 3: Paginated fetch + upsert (batched, resumable) --------------------
    // 2 pages × 5K records = 10K per step (same duration as before, 5x fewer steps total).
    const PAGES_PER_STEP = 2;

    const initialOffset = cursor.lastRunAt ? 0 : cursor.lastOffset;
    let resumeOffset = initialOffset;
    let totalFetched  = 0;
    let batchIndex    = 0;

    while (true) {
      const batchOffset = resumeOffset;
      const batchIdx    = batchIndex;

      const batchResult = await step.run(`fetch-batch-${batchIdx}`, async () => {
        let fetched        = 0;
        let batchEndOffset = batchOffset;

        await fetchAllInspections({
          lastRunAt:   cursor.lastRunAt,
          startOffset: batchOffset,
          appToken:    process.env.SOCRATA_APP_TOKEN,
          maxPages:    PAGES_PER_STEP,

          onPage: async (rawPage: SocrataInspectionRaw[], pNum: number) => {
            const mapped = rawPage
              .map(mapSocrataInspection)
              .filter((r): r is NonNullable<typeof r> => r !== null);

            await upsertInspections(mapped);
            fetched        += rawPage.length;
            batchEndOffset  = batchOffset + pNum * 1_000;

            logger.info(
              `[inspections] Batch ${batchIdx} page ${pNum} -- ${rawPage.length} fetched` +
              ` (total so far: ${totalFetched + fetched})`
            );
          },
        });

        const done = fetched < PAGES_PER_STEP * 5_000; // 2 × 5K = 10K full batch
        await db
          .update(pipelineState)
          .set({ lastOffset: done ? 0 : batchEndOffset })
          .where(eq(pipelineState.pipelineName, "ingest-lacity-inspections"));

        return { fetched, nextOffset: batchEndOffset, done };
      });

      totalFetched += batchResult.fetched;
      if (batchResult.done) break;
      resumeOffset = batchResult.nextOffset;
      batchIndex++;
    }

    // -- Step 4: Mark pipeline done -----------------------------------------------
    await step.run("update-state-done", async () => {
      await db
        .update(pipelineState)
        .set({
          status:           "done",
          lastRunAt:        new Date(),
          recordsProcessed: totalFetched,
          lastOffset:       0, // not used for inspections — delta is time-based
          error:            null,
        })
        .where(eq(pipelineState.pipelineName, "ingest-lacity-inspections"));

      logger.info(`[inspections] Pipeline done -- ${totalFetched} fetched`);
    });

    return { fetched: totalFetched };
  }
);
