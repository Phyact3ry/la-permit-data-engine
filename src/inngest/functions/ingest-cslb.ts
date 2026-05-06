/**
 * ingest-cslb.ts — Inngest pipeline: CSLB License Sync
 *
 * Расписание: каждое воскресенье 02:00 UTC (Weekly — из архитектурного файла)
 * Стратегия без seed-данных: диапазонный скан по номерам лицензий.
 * Когда придут 23,400 номеров из старого Worker -> обновить resolve-license-range.
 *
 * pipeline_state.last_offset хранит позицию в диапазоне.
 * Каждый прогон берёт BATCH_SIZE номеров, двигает offset вперёд.
 * Когда доходим до RANGE_END - сбрасываем в RANGE_START (новый полный цикл).
 */

import { inngest } from "../client";
import { db } from "../../lib/db";
import { contractorsEnriched, pipelineState } from "../../schema";
import { fetchCslbBatch } from "../../lib/cslb-fetcher";
import { eq, inArray } from "drizzle-orm";
import {
  ensureD1Table,
  syncContractorsToD1,
  buildD1Address,
  type D1SyncRecord,
} from "../../lib/d1-sync";

// Конфигурация диапазона
// Активные B-class подрядчики LA County: номера примерно в диапазоне 800K-1.1M
// TODO: после получения 23,400 номеров из старого Worker - заменить
//       диапазонный скан на чтение из CSV/таблицы в resolve-license-range
const RANGE_START = 800_000;
const RANGE_END   = 1_100_000;
const BATCH_SIZE  = 50;   // 50 лицензий x 800ms = 40 сек - в рамках Inngest timeout
const DELAY_MS    = 800;  // между запросами к CSLB (безопасный rate limit)

const PIPELINE_NAME = "ingest-cslb";

export const ingestCslb = inngest.createFunction(
  {
    id: "ingest-cslb",
    name: "Ingest CSLB Contractors",
    retries: 3,
    triggers: [{ cron: "0 2 * * 0" }],
  },

  async ({ step, logger }) => {

    // ШАГ 1: пометить pipeline как running
    await step.run("update-state-running", async () => {
      await db
        .insert(pipelineState)
        .values({
          pipelineName: PIPELINE_NAME,
          status: "running",
          lastRunAt: new Date(),
        })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: {
            status: "running",
            lastRunAt: new Date(),
            error: null,
          },
        });
      logger.info("[cslb] Pipeline started");
    });

    // ШАГ 2: определить диапазон этого прогона
    // TODO (когда придут 23,400 номеров из старого Worker):
    //   Заменить диапазонный скан на чтение из CSV/таблицы:
    //   const rows = await db.select().from(licenseSeedTable).offset(offset).limit(BATCH_SIZE)
    //   const licenseNumbers = rows.map(r => r.cslbLicense)
    const licenseRange = await step.run("resolve-license-range", async () => {
      const state = await db.query.pipelineState.findFirst({
        where: eq(pipelineState.pipelineName, PIPELINE_NAME),
      });

      let fromOffset = state?.lastOffset ?? RANGE_START;

      if (fromOffset >= RANGE_END) {
        fromOffset = RANGE_START;
        logger.info("[cslb] Достигли конца диапазона, начинаем новый цикл с " + RANGE_START);
      }

      const toOffset = Math.min(fromOffset + BATCH_SIZE, RANGE_END);
      logger.info("[cslb] Диапазон этого прогона: " + fromOffset + "-" + toOffset);
      return { from: fromOffset, to: toOffset };
    });

    // ШАГ 3: fetch CSLB + парсинг HTML
    // fetchCslbBatch делает GET (токены) + POST (данные) для каждого номера
    // с задержкой DELAY_MS между запросами.
    const fetchResult = await step.run("fetch-and-parse-cslb", async () => {
      const licenseNumbers = Array.from(
        { length: licenseRange.to - licenseRange.from },
        (_, i) => String(licenseRange.from + i)
      );

      logger.info("[cslb] Запрашиваем " + licenseNumbers.length + " лицензий (delay: " + DELAY_MS + "ms)");

      const batch = await fetchCslbBatch(licenseNumbers, { delayMs: DELAY_MS });

      logger.info(
        "[cslb] Получено: " + batch.results.length + " найдено, " +
        batch.notFound + " не найдено, " + batch.errors + " ошибок"
      );

      return batch;
    });

    // ШАГ 4: upsert в contractors_enriched
    // onConflictDoUpdate по cslb_license - идемпотентно.
    // При повторном прогоне обновляем только изменяемые поля (статус, бонд, страховка),
    // не трогаем аналитику (permit_count, icp_score) которую считают другие пайплайны.
    const upsertedCount = await step.run("upsert-contractors", async () => {
      const contractors = fetchResult.results;
      if (contractors.length === 0) {
        logger.info("[cslb] Нечего upsert-ить в этом batch");
        return 0;
      }

      for (const c of contractors) {
        await db
          .insert(contractorsEnriched)
          .values({
            cslbLicense:         c.cslbLicense,
            businessName:        c.businessName ?? "Unknown",
            ownerName:           c.ownerName,
            phone:               c.phone,
            addressStreet:       c.addressStreet,
            addressCity:         c.addressCity,
            addressState:        c.addressState,
            addressZip:          c.addressZip,
            licenseClass:        c.licenseClass,
            licenseStatus:       c.licenseStatus as any,
            licenseExpiry:       c.licenseExpiry,
            bondAmount:          c.bondAmount,
            workerCompInsurer:   c.workerCompInsurer,
            workerCompExpiry:    c.workerCompExpiry,
            hasActiveLicense:    c.hasActiveLicense,
            disciplinaryActions: c.disciplinaryActions,
            personnelOnLicense:  c.personnelOnLicense,
            secondaryLicenses:   c.secondaryLicenses,
            lastEnrichedAt:      new Date(),
          })
          .onConflictDoUpdate({
            target: contractorsEnriched.cslbLicense,
            set: {
              licenseStatus:       c.licenseStatus as any,
              licenseExpiry:       c.licenseExpiry,
              bondAmount:          c.bondAmount,
              workerCompInsurer:   c.workerCompInsurer,
              workerCompExpiry:    c.workerCompExpiry,
              hasActiveLicense:    c.hasActiveLicense,
              disciplinaryActions: c.disciplinaryActions,
              personnelOnLicense:  c.personnelOnLicense,
              lastEnrichedAt:      new Date(),
              updatedAt:           new Date(),
            },
          });
      }

      logger.info("[cslb] Upserted " + contractors.length + " contractors");
      return contractors.length;
    });

    // ШАГ 5: D1 sync — записать address → contractor_id для этого batch
    // Нужен CF_API_TOKEN в env. Если отсутствует — шаг пропускается без ошибки.
    const d1Synced = await step.run("sync-to-d1", async () => {
      if (!process.env.CF_API_TOKEN) {
        logger.warn("[cslb] CF_API_TOKEN not set — skipping D1 sync for this run");
        return 0;
      }

      const licenses = fetchResult.results.map((c) => c.cslbLicense);
      if (licenses.length === 0) return 0;

      // Query the just-upserted contractors to get their DB-generated UUIDs
      const rows = await db
        .select({
          id:            contractorsEnriched.id,
          cslbLicense:   contractorsEnriched.cslbLicense,
          addressStreet: contractorsEnriched.addressStreet,
          addressCity:   contractorsEnriched.addressCity,
        })
        .from(contractorsEnriched)
        .where(inArray(contractorsEnriched.cslbLicense, licenses));

      const d1Records: D1SyncRecord[] = rows
        .map((r) => {
          const address = buildD1Address(r.addressStreet, r.addressCity);
          if (!address) return null;
          return { address, contractorId: r.id, cslbLicense: r.cslbLicense };
        })
        .filter((r): r is D1SyncRecord => r !== null);

      await ensureD1Table();
      const count = await syncContractorsToD1(d1Records);
      logger.info("[cslb] D1 sync: " + count + " addresses cached");
      return count;
    });

    // ШАГ 6: обновить pipeline_state -> done
    await step.run("update-state-done", async () => {
      await db
        .insert(pipelineState)
        .values({
          pipelineName:     PIPELINE_NAME,
          status:           "done",
          lastRunAt:        new Date(),
          lastOffset:       licenseRange.to,
          recordsProcessed: upsertedCount,
        })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: {
            status:           "done",
            lastOffset:       licenseRange.to,
            recordsProcessed: upsertedCount,
          },
        });

      logger.info("[cslb] Done. Upserted: " + upsertedCount + ", next offset: " + licenseRange.to);
    });

    return {
      range:    licenseRange,
      found:    fetchResult.results.length,
      notFound: fetchResult.notFound,
      errors:   fetchResult.errors,
      upserted: upsertedCount,
      d1Synced,
    };
  }
);
