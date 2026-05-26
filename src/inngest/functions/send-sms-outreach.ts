import { inngest } from "../client";
import { db } from "../../lib/db";
import { pipelineState, outreachSequences, outreachTouches } from "../../schema";
import { eq, sql } from "drizzle-orm";

const PIPELINE_NAME = "send-sms-outreach";
const BATCH_SIZE = 25;

function toE164(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export const sendSmsOutreach = inngest.createFunction(
  {
    id: "send-sms-outreach",
    name: "Send SMS Outreach",
    retries: 3,
    triggers: [{ event: "outreach/send-sms" }],
  },

  async ({ step, logger }) => {
    await step.run("mark-running", async () => {
      await db
        .insert(pipelineState)
        .values({ pipelineName: PIPELINE_NAME, status: "running", recordsProcessed: 0, error: null })
        .onConflictDoUpdate({
          target: pipelineState.pipelineName,
          set: { status: "running", recordsProcessed: 0, error: null },
        });
      logger.info("[send-sms] Pipeline started");
    });

    const resumeCursor = await step.run("read-cursor", async () => {
      const [row] = await db
        .select({ lastCursor: pipelineState.lastCursor })
        .from(pipelineState)
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      return row?.lastCursor ?? null;
    });

    const sequenceId = await step.run("create-sequence", async () => {
      await db
        .insert(outreachSequences)
        .values({
          name:          "m1-sms-tier-ab",
          status:        "active",
          channel:       "sms",
          icpTierFilter: ["A", "B"],
        })
        .onConflictDoNothing();

      const [row] = await db
        .select({ id: outreachSequences.id })
        .from(outreachSequences)
        .where(eq(outreachSequences.name, "m1-sms-tier-ab"));

      return row!.id;
    });

    let lastProcessedId: string | null = resumeCursor;
    let totalSent = 0;
    let batchIndex = 0;

    while (true) {
      const currentLastId: string | null = lastProcessedId;
      const batchIdx: number = batchIndex;

      const batchResult = await step.run(
        `process-batch-${batchIdx}`,
        async (): Promise<{ done: boolean; sent: number; skipped: number; failed: number; lastId: string | null }> => {
          const accountSid = process.env.TWILIO_ACCOUNT_SID!;
          const authToken  = process.env.TWILIO_AUTH_TOKEN!;
          const fromNumber = process.env.TWILIO_FROM_NUMBER!;

          const cursorClause = currentLastId !== null
            ? sql`AND ce.id > ${currentLastId}`
            : sql``;

          const result = await db.execute(sql`
            SELECT ce.id AS contractor_id, ce.phone, ce.business_name,
                   h.id AS hypothesis_id, h.hook_line, h.body_text
            FROM contractors_enriched ce
            JOIN hypotheses h ON h.contractor_id = ce.id AND h.rank = 1
            WHERE ce.icp_tier IN ('A', 'B')
              AND ce.phone IS NOT NULL
              ${cursorClause}
              AND NOT EXISTS (
                SELECT 1 FROM outreach_touches ot
                WHERE ot.contractor_id = ce.id AND ot.touch_type = 'sms_sent'
              )
              AND NOT EXISTS (
                SELECT 1 FROM outreach_touches ot2
                WHERE ot2.contractor_id = ce.id AND ot2.touch_type = 'opted_out'
              )
            ORDER BY ce.id ASC
            LIMIT ${BATCH_SIZE}
          `);

          const batch = result.rows as Array<{
            contractor_id: string;
            phone: string;
            business_name: string;
            hypothesis_id: string;
            hook_line: string;
            body_text: string;
          }>;

          if (batch.length === 0) {
            return { done: true, sent: 0, skipped: 0, failed: 0, lastId: currentLastId };
          }

          const dryRun = process.env.DRY_RUN === "true";
          let sent = 0;
          let skipped = 0;
          let failed = 0;

          for (const row of batch) {
            const toPhone = toE164(row.phone);
            if (!toPhone) {
              logger.warn(`[send-sms] Skipping ${row.contractor_id} — invalid phone: ${row.phone}`);
              skipped++;
              continue;
            }

            const body = `${row.hook_line}\n\n${row.body_text}`;

            if (dryRun) {
              logger.info(
                `[send-sms] DRY_RUN — would send to ${toPhone} (${row.business_name}): "${row.hook_line}"`
              );
              sent++;
              continue;
            }

            try {
              const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
              const resp = await fetch(url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  Authorization: "Basic " + btoa(`${accountSid}:${authToken}`),
                },
                body: new URLSearchParams({ To: toPhone, From: fromNumber, Body: body }).toString(),
              });

              if (!resp.ok) throw new Error(`Twilio ${resp.status}: ${JSON.stringify(await resp.json())}`);
              const data = await resp.json() as { sid: string };

              await db.insert(outreachTouches).values({
                contractorId: row.contractor_id,
                hypothesisId: row.hypothesis_id,
                sequenceId,
                channel:      "sms",
                direction:    "outbound",
                touchType:    "sms_sent",
                sequenceStep: 1,
                externalId:   data.sid,
                subject:      row.hook_line,
                occurredAt:   new Date(),
              });

              sent++;
              await new Promise((r) => setTimeout(r, 200));
            } catch (err) {
              logger.warn(`[send-sms] Failed for contractor ${row.contractor_id}: ${err}`);
              failed++;
            }
          }

          const lastId = batch[batch.length - 1].contractor_id;
          logger.info(`[send-sms] Batch ${batchIdx}: sent=${sent}, skipped=${skipped}, failed=${failed}`);

          return {
            done: batch.length < BATCH_SIZE,
            sent,
            skipped,
            failed,
            lastId,
          };
        }
      );

      totalSent += batchResult.sent;
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
          recordsProcessed: totalSent,
          lastCursor:       null,
          error:            null,
        })
        .where(eq(pipelineState.pipelineName, PIPELINE_NAME));
      logger.info(`[send-sms] Done — ${totalSent} SMS sent`);
    });

    return { sent: totalSent };
  }
);
