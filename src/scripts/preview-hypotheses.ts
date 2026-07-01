/**
 * Preview script — generates hypotheses for 5 tier-A/B contractors and prints
 * them to stdout. Does NOT write to the hypotheses table.
 *
 * Usage: npx tsx src/scripts/preview-hypotheses.ts
 * Optional: LIMIT=10 npx tsx src/scripts/preview-hypotheses.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../lib/db";
import { contractorsEnriched, enrichmentSignals } from "../schema";
import { and, eq, inArray, sql } from "drizzle-orm";

const LIMIT = parseInt(process.env.LIMIT ?? "5", 10);

const VALID_PAIN_ANGLES = new Set([
  "inspection_delays", "correction_rate", "multi_city_complexity",
  "missed_deadline_risk", "trade_coordination", "license_compliance",
  "scale_readiness", "digital_presence",
]);

const anthropic = new Anthropic();

async function main() {
  console.log(`\n=== Hypotheses Preview (${LIMIT} contractors, DRY RUN — no DB writes) ===\n`);

  const rows = await db.execute(sql`
    SELECT id FROM contractors_enriched
    WHERE icp_tier IN ('A', 'B')
    ORDER BY icp_score DESC NULLS LAST
    LIMIT ${LIMIT}
  `);

  const ids = (rows.rows as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) {
    console.log("No tier-A/B contractors found. Run compute-icp-scores first.");
    process.exit(0);
  }

  const contractors = await db
    .select()
    .from(contractorsEnriched)
    .where(inArray(contractorsEnriched.id, ids));

  const signals = await db
    .select()
    .from(enrichmentSignals)
    .where(and(inArray(enrichmentSignals.contractorId, ids), eq(enrichmentSignals.isActive, true)));

  const signalsMap = new Map<string, typeof signals>();
  for (const s of signals) {
    if (!signalsMap.has(s.contractorId)) signalsMap.set(s.contractorId, []);
    signalsMap.get(s.contractorId)!.push(s);
  }

  // Sort by icp_score desc to match query order
  contractors.sort((a, b) => (b.icpScore ?? 0) - (a.icpScore ?? 0));

  for (let i = 0; i < contractors.length; i++) {
    const c = contractors[i];
    const sigs = signalsMap.get(c.id) ?? [];
    const signalSummary = sigs.length > 0
      ? sigs.map((s) => `${s.signalType} (value: ${s.signalValue.toFixed(2)})`).join("\n")
      : "None";

    console.log(`─── [${i + 1}/${contractors.length}] ${c.businessName} | license: ${c.cslbLicense} | tier: ${c.icpTier} | score: ${(c.icpScore ?? 0).toFixed(1)} ───`);
    console.log(`    City: ${c.addressCity ?? "unknown"} | Active permits: ${c.permitCountActive ?? 0} | Class: ${c.licenseClass ?? "unknown"}`);
    console.log(`    Signals: ${sigs.length > 0 ? sigs.map((s) => s.signalType).join(", ") : "none"}\n`);

    const userPrompt = `Contractor data:
- Business name: ${c.businessName}
- License class: ${c.licenseClass ?? "unknown"}
- City: ${c.addressCity ?? "unknown"}
- ICP score: ${c.icpScore ?? 0}
- Active permits: ${c.permitCountActive ?? 0}

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
      if (!jsonMatch) {
        console.log("  [ERROR] No JSON array in response. Raw:\n", text, "\n");
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        rank: number;
        pain_angle: string;
        hook_line: string;
        body_text: string;
        grounding_signals: string[];
      }>;

      const valid = parsed.filter(
        (h) => typeof h.rank === "number" && VALID_PAIN_ANGLES.has(h.pain_angle)
      );

      if (valid.length === 0) {
        console.log("  [WARN] LLM returned no valid angles.\n");
        continue;
      }

      for (const h of valid) {
        console.log(`  [Rank ${h.rank}] pain_angle: ${h.pain_angle}`);
        console.log(`    SUBJECT: ${h.hook_line}`);
        console.log(`    BODY:    ${h.body_text}`);
        console.log(`    SIGNALS: ${(h.grounding_signals ?? []).join(", ") || "—"}`);
        console.log();
      }

      // Show token usage so you know the cost
      const u = response.usage;
      console.log(`  tokens — input: ${u.input_tokens}, output: ${u.output_tokens}\n`);
    } catch (err) {
      console.log(`  [ERROR] ${err}\n`);
    }
  }

  console.log("=== Done (nothing written to DB) ===\n");
  process.exit(0);
}

main();
