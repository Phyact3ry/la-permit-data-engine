import { inngest } from "../client";
import { db } from "../../lib/db";
import { permits, contractorsEnriched, pipelineState } from "../../schema";
import { and, isNull, gt, ilike, or, eq, sql } from "drizzle-orm";
import { buildD1Address, lookupContractorsByAddress } from "../../lib/d1-sync";

const PIPELINE_NAME = "link-permits-to-contractors";
const BATCH_SIZE    = 1_000;

function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(llc|l\.l\.c\.?|inc\.?|corp\.?|corporation|co\.?|ltd\.?|lp|dba|the)\b/g, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function recomputeContractorCounters(contractorIds: string[]): Promise<void> {
  if (contractorIds.length === 0) return;

  const idList = sql.join(contractorIds.map((id) => sql`${id}`), sql`, `);

  // Два SELECT параллельно
  const [activeCounts, cityCounts] = await Promise.all([
    db
      .select({
        contractorId: permits.contractorId,
        cnt: sql<number>`cast(count(*) as int)`,
      })
      .from(permits)
      .where(sql`${permits.contractorId} IN (${idList}) AND ${permits.status} NOT IN ('Permit Finaled', 'Permit Expired', 'Permit Closed', 'Permit Withdrawn', 'Permit Revoked', 'Refund Completed', 'CofO Issued', 'CofC Issued', 'CofO Corrected', 'CofC Corrected')`)
      .groupBy(permits.contractorId),
    db
      .select({
        contractorId: permits.contractorId,
        city:         permits.city,
        cnt:          sql<number>`cast(count(*) as int)`,
      })
      .from(permits)
      .where(sql`${permits.contractorId} IN (${idList})`)
      .groupBy(permits.contractorId, permits.city),
  ]);

  const activeMap: Record<string, number> = {};
  for (const r of activeCounts) {
    if (r.contractorId) activeMap[r.contractorId] = r.cnt;
  }

  const cityMapByContractor: Record<string, Record<string, number>> = {};
  for (const r of cityCounts) {
    if (!r.contractorId || !r.city) continue;
    (cityMapByContractor[r.contractorId] ??= {})[r.city] = r.cnt;
  }

  // Один батч-UPDATE вместо N отдельных запросов
  const rows = sql.join(
    contractorIds.map((cid) => {
      const active  = activeMap[cid] ?? 0;
      const cityMap = JSON.stringify(cityMapByContractor[cid] ?? {});
      return sql`(${cid}::text, ${active}::int, ${cityMap}::jsonb)`;
    }),
    sql`, `
  );

  await db.execute(sql`
    UPDATE contractors_enriched AS ce
    SET permit_count_active  = m.active_count,
        permit_count_by_city = m.city_map,
        updated_at           = NOW()
    FROM (VALUES ${rows}) AS m(cid, active_count, city_map)
    WHERE ce.id = m.cid
  `);
}

export const linkPermitsToContractors = inngest.createFunction(
  {
    id:       "link-permits-to-contractors",
    name:     "Link Permits to Contractors",
    retries:  3,
    triggers: [
      { cron: "0 5 * * 0" },
      { event: "link-permits/run" },
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
      logger.info("[link-permits] Pipeline started");
    });

    const resumeCursor = await step.run("read-cursor", async () => {
      const [row] = await db
        .select({ lastCursor: pipelineState.lastCursor })
        .from(pipelineState)
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      return row?.lastCursor ?? null;
    });

    let lastProcessedId: string | null = resumeCursor;
    let totalLinked = 0;
    let batchIndex  = 0;
    // Accumulated across all batches — rebuilt from memoized step results on Inngest replay
    const allAffectedContractorIds = new Set<string>();

    if (lastProcessedId) {
      logger.info(`[link-permits] Resuming from cursor: ${lastProcessedId}`);
    }

    while (true) {
      const currentLastId: string | null = lastProcessedId;
      const batchIdx: number             = batchIndex;

      const batchResult = await step.run(
        `process-batch-${batchIdx}`,
        async (): Promise<{
          done:                  boolean;
          linked:                number;
          lastId:                string | null;
          affectedContractorIds: string[];
        }> => {

          // ── Fetch batch ────────────────────────────────────────────────────
          const batch = await db
            .select({
              id:               permits.id,
              contractorName:   permits.contractorName,
              contractorAddress: permits.contractorAddress,
              contractorLicense: sql<string | null>`${permits.rawSocrata}->>'license'`,
              contractorCity:   sql<string | null>`${permits.rawSocrata}->>'contractor_city'`,
              city:             permits.city,
            })
            .from(permits)
            .where(
              and(
                isNull(permits.contractorId),
                currentLastId ? gt(permits.id, currentLastId) : undefined
              )
            )
            .orderBy(permits.id)
            .limit(BATCH_SIZE);

          if (batch.length === 0) {
            return { done: true, linked: 0, lastId: currentLastId, affectedContractorIds: [] };
          }

          const updates = new Map<string, string>();

          // ── Pass 0: CSLB license direct match (highest confidence) ─────────
          const licenseToPermitIds = new Map<string, string[]>();
          for (const p of batch) {
            const lic = p.contractorLicense?.trim().toUpperCase();
            if (!lic) continue;
            if (!licenseToPermitIds.has(lic)) licenseToPermitIds.set(lic, []);
            licenseToPermitIds.get(lic)!.push(p.id);
          }

          if (licenseToPermitIds.size > 0) {
            const licList = sql.join(
              [...licenseToPermitIds.keys()].map((l) => sql`${l}`),
              sql`, `
            );
            const matches = await db
              .select({ id: contractorsEnriched.id, cslbLicense: contractorsEnriched.cslbLicense })
              .from(contractorsEnriched)
              .where(sql`${contractorsEnriched.cslbLicense} IN (${licList})`);

            for (const m of matches) {
              for (const pid of licenseToPermitIds.get(m.cslbLicense) ?? []) {
                updates.set(pid, m.id);
              }
            }
          }

          // ── Pass 1: D1 address lookup ──────────────────────────────────────
          const d1KeyToPermitIds = new Map<string, string[]>();
          const uniqueD1Keys     = new Set<string>();

          for (const p of batch) {
            if (updates.has(p.id)) continue;
            const key = buildD1Address(p.contractorAddress, p.contractorCity);
            if (!key) continue;
            uniqueD1Keys.add(key);
            if (!d1KeyToPermitIds.has(key)) d1KeyToPermitIds.set(key, []);
            d1KeyToPermitIds.get(key)!.push(p.id);
          }

          if (uniqueD1Keys.size > 0 && process.env.CF_API_TOKEN) {
            try {
              const d1Results = await lookupContractorsByAddress([...uniqueD1Keys]);
              for (const [key, contractorId] of d1Results) {
                for (const permitId of d1KeyToPermitIds.get(key) ?? []) {
                  updates.set(permitId, contractorId);
                }
              }
            } catch (err) {
              console.warn(`[link-permits] D1 lookup error: ${(err as Error).message}`);
            }
          } else if (!process.env.CF_API_TOKEN) {
            logger.warn("[link-permits] CF_API_TOKEN not set — skipping D1 pass");
          }

          // ── Pass 2: batch name lookup (one query for all names) ────────────
          // Requires pg_trgm GIN index on business_name for performance.
          // Run: npx tsx src/scripts/add-trgm-index.ts
          const nameToPermitIds = new Map<string, string[]>();

          for (const p of batch) {
            if (updates.has(p.id) || !p.contractorName) continue;
            const normalized = normalizeName(p.contractorName);
            if (normalized.length < 4) continue;
            if (!nameToPermitIds.has(normalized)) nameToPermitIds.set(normalized, []);
            nameToPermitIds.get(normalized)!.push(p.id);
          }

          if (nameToPermitIds.size > 0) {
            const normalizedNames = [...nameToPermitIds.keys()];
            // Дробим на чанки по 50 — иначе OR с 1000 ILIKE убивает планировщик
            const ILIKE_CHUNK = 50;
            const allCandidates: { id: string; businessName: string }[] = [];
            for (let i = 0; i < normalizedNames.length; i += ILIKE_CHUNK) {
              const chunk = normalizedNames.slice(i, i + ILIKE_CHUNK);
              const results = await db
                .select({ id: contractorsEnriched.id, businessName: contractorsEnriched.businessName })
                .from(contractorsEnriched)
                .where(or(...chunk.map((n) => ilike(contractorsEnriched.businessName, `%${n}%`))));
              allCandidates.push(...results);
            }

            for (const [normalized, permitIds] of nameToPermitIds) {
              const matches = allCandidates.filter((c) =>
                c.businessName.toLowerCase().includes(normalized)
              );
              if (matches.length === 1) {
                for (const pid of permitIds) {
                  updates.set(pid, matches[0].id);
                }
              }
            }
          }

          // ── Apply updates: single batch UPDATE via VALUES ──────────────────
          if (updates.size > 0) {
            const pairs = [...updates.entries()];
            await db.transaction(async (tx) => {
              await tx.execute(sql`SET TRANSACTION READ WRITE`);
              const rows = sql.join(
                pairs.map(([pid, cid]) => sql`(${pid}::text, ${cid}::text)`),
                sql`, `
              );
              await tx.execute(sql`
                UPDATE permits AS p
                SET contractor_id = m.cid, updated_at = NOW()
                FROM (VALUES ${rows}) AS m(pid, cid)
                WHERE p.id = m.pid
              `);
            });
          }

          logger.info(
            `[link-permits] Batch ${batchIdx}: ` +
            `${batch.length} permits scanned, ${updates.size} linked`
          );

          return {
            done:                  batch.length < BATCH_SIZE,
            linked:                updates.size,
            lastId:                batch[batch.length - 1].id,
            affectedContractorIds: [...new Set(updates.values())],
          };
        }
      );

      totalLinked += batchResult.linked;
      for (const id of batchResult.affectedContractorIds) {
        allAffectedContractorIds.add(id);
      }
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

    // Recompute permit counters once for all contractors touched this run
    await step.run("recompute-counters", async () => {
      const ids = [...allAffectedContractorIds];
      logger.info(`[link-permits] Recomputing counters for ${ids.length} contractors`);
      await recomputeContractorCounters(ids);
    });

    // Compute inspection_pass_rate for all contractors with linked permits.
    // Join inspections → permits via permit_ref (spaces) = permit_number (dashes).
    // Done once at end of run — covers all contractors, not just batch-touched ones.
    await step.run("compute-inspection-analytics", async () => {
      const result = await db.execute(sql`
        WITH insp_agg AS (
          SELECT
            permit_ref,
            COUNT(*)::int                                                        AS total,
            COUNT(*) FILTER (WHERE inspection_result = 'Approved')::int         AS approved
          FROM inspections
          GROUP BY permit_ref
        ),
        contractor_stats AS (
          SELECT
            p.contractor_id,
            SUM(ia.approved)::int   AS total_approved,
            SUM(ia.total)::int      AS grand_total
          FROM insp_agg ia
          JOIN permits p
            ON p.permit_number = REPLACE(ia.permit_ref, ' ', '-')
          WHERE p.contractor_id IS NOT NULL
          GROUP BY p.contractor_id
        )
        UPDATE contractors_enriched AS ce
        SET
          inspection_pass_rate = cs.total_approved::real / NULLIF(cs.grand_total, 0)::real,
          updated_at           = NOW()
        FROM contractor_stats cs
        WHERE ce.id = cs.contractor_id
      `);
      logger.info(`[link-permits] inspection_pass_rate updated for ${result.rowCount ?? 0} contractors`);
      return { updated: result.rowCount ?? 0 };
    });

    await step.run("update-state-done", async () => {
      await db
        .update(pipelineState)
        .set({
          status:           "done",
          lastRunAt:        new Date(),
          recordsProcessed: totalLinked,
          lastCursor:       null,
          error:            null,
        })
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      logger.info(`[link-permits] Done — ${totalLinked} permits linked this run`);
    });

    return { linked: totalLinked };
  }
);
