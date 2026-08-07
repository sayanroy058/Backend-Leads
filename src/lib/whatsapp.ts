// Phase 2 — WhatsApp provider bridge.
//
// This module talks to the WhatsApp business messaging API. It is built against
// the standard **Meta WhatsApp Cloud API** contract (https://developers.facebook.com/docs/whatsapp/cloud-api),
// which is also the shape exposed by provider bridges such as RelayX
// (https://whatssapi.vercel.app) — a thin wrapper around the same webhook +
// /{phone-id}/messages endpoints.
//
// Everything provider-specific is configurable through env vars so the same
// code can point at Meta directly or at any bridge that accepts Meta-shaped
// webhooks and a Bearer token on the send endpoint:
//   - WHATSAPP_API_BASE      base URL for the send endpoint (defaults to Meta Graph v21.0)
//   - WHATSAPP_API_TOKEN     Bearer token (a Meta system-user token, or the bridge's key)
//   - WHATSAPP_PHONE_ID      the phone-number-id that identifies the sending number
//   - WHATSAPP_FROM_NUMBER   the sending WhatsApp number (E.164, e.g. "15551234567")
//   - WHATSAPP_WEBHOOK_VERIFY_TOKEN  token used for the GET webhook handshake (hub.verify_token)
//   - WHATSAPP_WEBHOOK_SECRET        optional secret matched against x-webhook-secret / X-Hub-Signature
//   - WHATSAPP_WORKING_*     working-hours window used to decide auto-acknowledgements

const DEFAULT_GRAPH = "https://graph.facebook.com/v21.0";

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function whatsappConfig() {
  return {
    enabled: Boolean(env("WHATSAPP_API_TOKEN") && env("WHATSAPP_PHONE_ID")),
    base: (env("WHATSAPP_API_BASE") || DEFAULT_GRAPH).replace(/\/+$/, ""),
    token: env("WHATSAPP_API_TOKEN"),
    phoneId: env("WHATSAPP_PHONE_ID"),
    fromNumber: env("WHATSAPP_FROM_NUMBER"),
    verifyToken: env("WHATSAPP_WEBHOOK_VERIFY_TOKEN"),
    webhookSecret: env("WHATSAPP_WEBHOOK_SECRET"),
  };
}

// ---------------------------------------------------------------------------
// Phone normalization & matching
// ---------------------------------------------------------------------------

/** Strip everything but digits. */
export function normalizePhone(raw: string | null | undefined): string {
  return (raw ?? "").replace(/[^\d]/g, "");
}

/**
 * Two phone numbers "match" if they share the same significant trailing digits.
 * We compare on the last 10 digits (or the full shorter value), which tolerates
 * differences in country code / formatting so a caller and a WhatsApp contact
 * with the same number resolve to one lead.
 */
export function phoneMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  const len = Math.min(10, Math.min(na.length, nb.length));
  if (len === 0) return false;
  return na.slice(-len) === nb.slice(-len);
}

// ---------------------------------------------------------------------------
// Webhook handshake & authorization
// ---------------------------------------------------------------------------

export interface HandshakeResult {
  ok: boolean;
  challenge: string | null;
}

/** Validate `hub.*` query params from a Meta GET verification request. */
export function verifyHandshake(
  mode: string | null | undefined,
  token: string | null | undefined,
  challenge: string | null | undefined
): HandshakeResult {
  const cfg = whatsappConfig();
  if (mode === "subscribe" && token && cfg.verifyToken && token === cfg.verifyToken && challenge) {
    return { ok: true, challenge };
  }
  return { ok: false, challenge: null };
}

/**
 * Authorize an inbound POST. Honors an explicit `x-webhook-secret` /
 * `X-Hub-Signature-256` header set by the provider, or falls back to a
 * configured shared secret when the bridge can't sign. If no secret is
 * configured the webhook is trusted as-is.
 */
export async function authorizeWebhook(headerValue: string | null | undefined): Promise<boolean> {
  const cfg = whatsappConfig();
  if (!cfg.webhookSecret) return true;
  if (!headerValue) return false;
  return headerValue === cfg.webhookSecret;
}

// ---------------------------------------------------------------------------
// Inbound payload normalization
// ---------------------------------------------------------------------------

export interface InboundWhatsApp {
  from: string; // wa_id (E.164 digits)
  contactName: string | null;
  body: string;
  providerMessageId: string;
  timestamp: string; // ISO 8601
  messageType: string;
}

/**
 * Normalize a provider webhook body into a flat list of inbound text messages.
 * Handles the canonical Meta Cloud API shape:
 *   { object, entry: [{ changes: [{ value: { contacts, messages: [...] } }] }] }
 * and, defensively, a plain `{ messages: [...] }` array for flexible bridges.
 */
export function normalizeInbound(body: any): InboundWhatsApp[] {
  const out: InboundWhatsApp[] = [];
  if (!body || typeof body !== "object") return out;

  const messages: any[] = [];
  const contacts: any[] = [];

  if (Array.isArray(body?.entry)) {
    for (const entry of body.entry) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value;
        if (Array.isArray(value?.messages)) messages.push(...value.messages);
        if (Array.isArray(value?.contacts)) contacts.push(...value.contacts);
      }
    }
  } else if (Array.isArray(body?.messages)) {
    messages.push(...body.messages);
    if (Array.isArray(body?.contacts)) contacts.push(...body.contacts);
  }

  const contactByWa = new Map<string, string | null>();
  for (const c of contacts) {
    if (c?.wa_id) contactByWa.set(String(c.wa_id), c?.profile?.name ?? null);
  }

  for (const m of messages) {
    if (m?.type !== "text") continue; // images/audio/etc. are out of scope for now
    const from = String(m.from ?? "").replace(/[^\d]/g, "");
    const body = (m?.text?.body ?? "").toString();
    if (!from || !body) continue;
    const tsNum = Number(m.timestamp);
    out.push({
      from,
      contactName: contactByWa.get(from) ?? null,
      body,
      providerMessageId: String(m.id ?? `${from}-${m.timestamp}-${body.slice(0, 16)}`),
      timestamp: Number.isFinite(tsNum) ? new Date(tsNum * 1000).toISOString() : new Date().toISOString(),
      messageType: "text",
    });
  }

  return out;
}



// ---------------------------------------------------------------------------
// Outbound send
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  error?: string;
}

/**
 * Send a text message to `to` (E.164) via the provider, using the Meta Cloud
 * API send contract:  POST {base}/{phone_id}/messages  with a Bearer token.
 */
export async function sendText(to: string, text: string): Promise<SendResult> {
  const cfg = whatsappConfig();
  if (!cfg.enabled) return { ok: false, providerMessageId: null, error: "WhatsApp provider is not configured (WHATSAPP_API_TOKEN / WHATSAPP_PHONE_ID)" };
  if (!cfg.phoneId) return { ok: false, providerMessageId: null, error: "WHATSAPP_PHONE_ID is not set" };

  const url = `${cfg.base}/${encodeURIComponent(cfg.phoneId)}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizePhone(to),
        type: "text",
        text: { body: text },
      }),
    });
  } catch (e) {
    return { ok: false, providerMessageId: null, error: `WhatsApp provider unreachable: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { ok: false, providerMessageId: null, error: `WhatsApp send failed (${res.status}): ${detail.slice(0, 500)}` };
  }

  const json = (await res.json().catch(() => ({}))) as any;
  return { ok: true, providerMessageId: json?.messages?.[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Working hours & auto-acknowledgement
// ---------------------------------------------------------------------------

export function workingHoursConfig() {
  return {
    start: env("WHATSAPP_WORKING_HOURS_START") || "09:00", // 24h "HH:MM"
    end: env("WHATSAPP_WORKING_HOURS_END") || "18:00",
    tz: env("WHATSAPP_WORKING_TZ") || "America/New_York",
  };
}

/** True when `date` falls inside the configured working-hours window (local tz). */
export function isWithinWorkingHours(date: Date): boolean {
  const { start, end, tz } = workingHoursConfig();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const s = sh * 60 + (sm || 0);
  const e = eh * 60 + (em || 0);
  return mins >= s && mins < e;
}

/** The canned off-hours acknowledgement we send when a lead messages us late. */
export function autoAckText(): string {
  return "Thanks for reaching out — we got your message. Our team will get back to you shortly. 🙌";
}
