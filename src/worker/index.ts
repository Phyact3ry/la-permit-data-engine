import { Hono } from "hono";
import { queryContractor, getTouchByExternalId, insertTouch, getLatestInspectionSnapshot } from "./supabase";

type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  DB: D1Database;
  TWILIO_AUTH_TOKEN: string;
};

// CTIA-mandated opt-out keywords (Twilio also handles these natively at carrier level)
const STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);

async function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  // Twilio HMAC-SHA1: HMAC(authToken, url + sorted(key+value pairs))
  const sortedData = Object.keys(params).sort().map(k => k + params[k]).join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(url + sortedData));
  const computed = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return computed === signature;
}

const app = new Hono<{ Bindings: Bindings }>();

app.post("/webhooks/twilio-sms", async (c) => {
  try {
    const authToken = c.env.TWILIO_AUTH_TOKEN;
    const signature = c.req.header("X-Twilio-Signature") ?? "";
    const url = new URL(c.req.url).toString();

    const raw = await c.req.text();
    const params = Object.fromEntries(new URLSearchParams(raw).entries());

    const valid = await validateTwilioSignature(authToken, signature, url, params);
    if (!valid) {
      return c.text("Forbidden", 403);
    }

    const fromPhone = params["From"] ?? "";
    const body = (params["Body"] ?? "").trim().toUpperCase();
    const messageSid = params["MessageSid"] ?? "";

    const twiml = (msg: string) =>
      new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${msg}</Message></Response>`, {
        headers: { "Content-Type": "text/xml" },
      });

    if (!STOP_KEYWORDS.has(body)) {
      return twiml("");
    }

    const contractor = await queryContractor(c.env, { phone: fromPhone });

    if (contractor) {
      // Check idempotency — don't double-insert opted_out for same contractor
      const checkUrl = `${c.env.SUPABASE_URL}/rest/v1/outreach_touches?contractor_id=eq.${encodeURIComponent(contractor.id)}&touch_type=eq.opted_out&channel=eq.sms&limit=1`;
      const checkResp = await fetch(checkUrl, {
        headers: {
          apikey:        c.env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${c.env.SUPABASE_SERVICE_KEY}`,
        },
      });
      const existing = checkResp.ok ? ((await checkResp.json()) as any[]) : [];

      if (existing.length === 0) {
        await insertTouch(c.env, {
          contractor_id: contractor.id,
          hypothesis_id: null,
          sequence_id:   null,
          channel:       "sms",
          direction:     "inbound",
          touch_type:    "opted_out",
          external_id:   messageSid,
          occurred_at:   new Date().toISOString(),
        });
      }
    }

    return twiml(
      "You have been unsubscribed. No further messages will be sent. Reply HELP for help."
    );
  } catch (err) {
    console.error("[twilio-sms-webhook] Error:", err);
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`,
      { headers: { "Content-Type": "text/xml" } }
    );
  }
});

app.post("/webhooks/vapi", async (c) => {
  try {
    const payload = await c.req.json() as any;
    const message = payload?.message;

    let touchType: string | null = null;
    if (message?.type === "status-update" && message?.status === "in-progress") {
      touchType = "call_answered";
    } else if (message?.type === "end-of-call-report") {
      if (message?.endedReason === "voicemail") touchType = "call_voicemail";
      else if (message?.endedReason === "customer-did-not-answer") touchType = "call_no_answer";
      else touchType = "call_completed";
    }

    if (!touchType) return c.json({ ok: true });

    const callId = message?.call?.id;
    if (!callId) return c.json({ ok: true });

    const original = await getTouchByExternalId(c.env, callId);
    if (!original) return c.json({ ok: true });

    const idempotencyUrl = `${c.env.SUPABASE_URL}/rest/v1/outreach_touches?external_id=eq.${encodeURIComponent(callId)}&touch_type=eq.${touchType}&limit=1`;
    const idempotencyResp = await fetch(idempotencyUrl, {
      headers: {
        apikey:        c.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${c.env.SUPABASE_SERVICE_KEY}`,
      },
    });
    if (idempotencyResp.ok) {
      const existing = (await idempotencyResp.json()) as any[];
      if (existing.length > 0) return c.json({ ok: true });
    }

    await insertTouch(c.env, {
      contractor_id:    original.contractor_id,
      hypothesis_id:    original.hypothesis_id,
      sequence_id:      original.sequence_id,
      channel:          "voice",
      direction:        "inbound",
      touch_type:       touchType,
      external_id:      callId,
      duration_seconds: message.durationSeconds ?? undefined,
      occurred_at:      new Date().toISOString(),
    });

    return c.json({ ok: true });
  } catch (err) {
    console.error("[vapi-webhook] Error:", err);
    return c.json({ ok: true });
  }
});

// ─── ADU Inspection Index artifact ───────────────────────────────────────────
// Public, read-only aggregate data — no PII. CORS-open + 1h cache.
const INSPECTION_INDEX_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=3600",
};

app.get("/inspection-index", async (c) => {
  const payload = await getLatestInspectionSnapshot(c.env);
  if (!payload) return c.json({ error: "no_snapshot" }, 404, INSPECTION_INDEX_HEADERS);
  return c.json(payload, 200, INSPECTION_INDEX_HEADERS);
});

app.get("/inspection-index/:slug", async (c) => {
  const payload = await getLatestInspectionSnapshot(c.env);
  if (!payload) return c.json({ error: "no_snapshot" }, 404, INSPECTION_INDEX_HEADERS);
  const type = payload.types.find((t) => t.slug === c.req.param("slug"));
  if (!type) return c.json({ error: "not_found" }, 404, INSPECTION_INDEX_HEADERS);
  // include shared metadata so a leaf page has period/source/last-updated from one call
  return c.json(
    {
      snapshot_date: payload.snapshot_date,
      period: payload.period,
      source: payload.source,
      methodology: payload.methodology,
      sample_threshold: payload.sample_threshold,
      type,
    },
    200,
    INSPECTION_INDEX_HEADERS
  );
});

app.get("/contractors/by-phone/:phone", async (c) => {
  const contractor = await queryContractor(c.env, { phone: c.req.param("phone") });
  if (!contractor) return c.json({ error: "not_found" }, 404);
  return c.json(contractor);
});

app.get("/contractors/:cslbLicense", async (c) => {
  const contractor = await queryContractor(c.env, { cslbLicense: c.req.param("cslbLicense") });
  if (!contractor) return c.json({ error: "not_found" }, 404);
  return c.json(contractor);
});

export default app;
