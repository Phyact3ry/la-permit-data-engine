import Anthropic from "@anthropic-ai/sdk";
import { inngest } from "../client";
import { db } from "../../lib/db";
import {
  contractorsEnriched,
  enrichmentSignals,
  hypotheses,
  pipelineState,
} from "../../schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { PainAngle } from "../../schema";

const PIPELINE_NAME = "generate-hypotheses";
const BATCH_SIZE = 50;

const VALID_PAIN_ANGLES = new Set<string>([
  "inspection_delays",
  "correction_rate",
  "multi_city_complexity",
  "missed_deadline_risk",
  "trade_coordination",
  "license_compliance",
  "scale_readiness",
  "digital_presence",
]);

const anthropic = new Anthropic();

type HypothesisItem = {
  rank: number;
  pain_angle: string;
  hook_line: string;
  body_text: string;
  grounding_signals: string[];
};

export const generateHypotheses = inngest.createFunction(
  {
    id: "generate-hypotheses",
    name: "Generate Hypotheses",
    retries: 3,
    triggers: [
      { cron: "0 7 * * 2" },
      { event: "hypotheses/generate" },
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
      logger.info("[gen-hypotheses] Pipeline started");
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
      logger.info(`[gen-hypotheses] Resuming from cursor: ${lastProcessedId}`);
    }

    while (true) {
      const currentLastId: string | null = lastProcessedId;
      const batchIdx: number = batchIndex;

      const batchResult = await step.run(
        `process-batch-${batchIdx}`,
        async (): Promise<{ done: boolean; processed: number; lastId: string | null }> => {
          const whereClause = currentLastId === null
            ? sql`TRUE`
            : sql`ce.id > ${currentLastId}`;

          const idsResult = await db.execute(sql`
            SELECT ce.id
            FROM contractors_enriched ce
            WHERE ${whereClause}
              AND ce.icp_tier IN ('A', 'B')
              AND NOT EXISTS (
                SELECT 1 FROM hypotheses h WHERE h.contractor_id = ce.id
              )
            ORDER BY ce.id ASC
            LIMIT ${BATCH_SIZE}
          `);

          const batchIds = (idsResult.rows as { id: string }[]).map((r) => r.id);

          if (batchIds.length === 0) {
            return { done: true, processed: 0, lastId: currentLastId };
          }

          const ceRows = await db
            .select()
            .from(contractorsEnriched)
            .where(inArray(contractorsEnriched.id, batchIds));

          const signalRows = await db
            .select()
            .from(enrichmentSignals)
            .where(
              and(
                inArray(enrichmentSignals.contractorId, batchIds),
                eq(enrichmentSignals.isActive, true)
              )
            );

          const signalsMap = new Map<string, typeof signalRows>();
          for (const sig of signalRows) {
            if (!signalsMap.has(sig.contractorId)) {
              signalsMap.set(sig.contractorId, []);
            }
            signalsMap.get(sig.contractorId)!.push(sig);
          }

          const allHypothesisRows: Array<{
            contractorId: string;
            rank: number;
            painAngle: PainAngle;
            channel: "email";
            hookLine: string;
            bodyText: string;
            groundingSignals: string[];
            modelUsed: string;
            promptVersion: string;
            wasUsed: boolean;
          }> = [];

          for (const contractor of ceRows) {
            const signals = signalsMap.get(contractor.id) ?? [];
            const signalSummary = signals.length > 0
              ? signals.map((s) => `${s.signalType} (value: ${s.signalValue.toFixed(2)})`).join("\n")
              : "None";

            const userPrompt = `Contractor data:
- Business name: ${contractor.businessName}
- License class: ${contractor.licenseClass ?? "unknown"}
- City: ${contractor.addressCity ?? "unknown"}
- ICP score: ${contractor.icpScore ?? 0}
- Active permits: ${contractor.permitCountActive ?? 0}

Active signals:
${signalSummary}

Generate 2-3 personalized outreach angles as a JSON array. Each object must have exactly these fields:
{
  "rank": <1, 2, or 3>,
  "pain_angle": "<one of: inspection_delays | correction_rate | multi_city_complexity | missed_deadline_risk | trade_coordination | license_compliance | scale_readiness | digital_presence>",
  "hook_line": "<compelling email subject or voice opener, max 80 chars>",
  "body_text": "<2-3 short sentences max. Conversational cold-email tone, not marketing copy. Reference the contractor's specific city, permit count, or signals — do NOT use first names extracted from the business name. Do NOT invent statistics, percentages, or time-savings claims — we have no benchmarks yet.>",
  "grounding_signals": ["<signal_type>"]
}

Rules:
- Each angle must use a DIFFERENT pain_angle — no repeats across the 2-3 items.
- Never claim existing customers or invented metrics (no "our customers save X%", no "cut Y by Z%").
- Address the business by company name only, never by a first name.

Return only the JSON array, no other text.`;

            try {
              const response = await anthropic.messages.create({
                model: "claude-sonnet-4-6",
                max_tokens: 1024,
                system:
                  "You are a B2B sales assistant specializing in construction industry outreach. " +
                  "Generate personalized outreach angles for a SaaS that helps " +
                  "contractors pass LA County building inspections faster.",
                messages: [{ role: "user", content: userPrompt }],
              });

              const text = response.content
                .filter((c) => c.type === "text")
                .map((c) => (c as { type: "text"; text: string }).text)
                .join("");

              const jsonMatch = text.match(/\[[\s\S]*\]/);
              if (!jsonMatch) throw new Error("No JSON array in LLM response");

              const parsed: HypothesisItem[] = JSON.parse(jsonMatch[0]);

              const valid = parsed.filter(
                (h) =>
                  typeof h.rank === "number" &&
                  VALID_PAIN_ANGLES.has(h.pain_angle) &&
                  typeof h.hook_line === "string" &&
                  typeof h.body_text === "string"
              );

              for (const h of valid) {
                allHypothesisRows.push({
                  contractorId: contractor.id,
                  rank: h.rank,
                  painAngle: h.pain_angle as PainAngle,
                  channel: "email",
                  hookLine: h.hook_line,
                  bodyText: h.body_text,
                  groundingSignals: Array.isArray(h.grounding_signals) ? h.grounding_signals : [],
                  modelUsed: "claude-sonnet-4-6",
                  promptVersion: "v1",
                  wasUsed: false,
                });
              }
            } catch (err) {
              logger.warn(`[gen-hypotheses] LLM error for contractor ${contractor.id}: ${err}`);
            }
          }

          if (allHypothesisRows.length > 0) {
            await db.transaction(async (tx) => {
              await tx.execute(sql`SET TRANSACTION READ WRITE`);
              await tx
                .insert(hypotheses)
                .values(allHypothesisRows)
                .onConflictDoUpdate({
                  target: [hypotheses.contractorId, hypotheses.rank],
                  set: {
                    painAngle:        sql`EXCLUDED.pain_angle`,
                    hookLine:         sql`EXCLUDED.hook_line`,
                    bodyText:         sql`EXCLUDED.body_text`,
                    groundingSignals: sql`EXCLUDED.grounding_signals`,
                    modelUsed:        sql`EXCLUDED.model_used`,
                    promptVersion:    sql`EXCLUDED.prompt_version`,
                    updatedAt:        sql`now()`,
                  },
                });
            });
          }

          logger.info(
            `[gen-hypotheses] Batch ${batchIdx}: ${ceRows.length} contractors, ` +
            `${allHypothesisRows.length} hypotheses upserted`
          );

          const lastId = batchIds[batchIds.length - 1];
          return {
            done: batchIds.length < BATCH_SIZE,
            processed: ceRows.length,
            lastId,
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
      logger.info(`[gen-hypotheses] Done — ${totalProcessed} contractors processed`);
    });

    return { processed: totalProcessed };
  }
);
