import { Hono } from "hono";
import type { Client } from "@libsql/client";
import { getDb } from "../db";
import { insertEvent } from "../lib/events";
import {
  verifyHandshake,
  authorizeWebhook,
  normalizeInbound,
  phoneMatches,
  normalizePhone,
  sendText,
  isWithinWorkingHours,
  autoAckText,
  whatsappConfig,
} from "../lib/whatsapp";

// Phase 2 — WhatsApp inbound webhook.
//
// This route is PUBLIC (no auth): it is the URL you register with Meta /
// RelayX as the WhatsApp webhook. GET performs the Meta Cloud API handshake;
// POST receives inbound messages and routes them into the same Event /
// Conversation model as every other channel, matching contacts by phone number
// so a lead who calls and later WhatsApps is ONE contact, ONE thread.
//
// Router prefix: /api/webhooks/whatsapp

const ACK_DEBOUNCE_MS = 5 * 60 * 1000; // only auto-ack once per ~5 min per number

const router = new Hono();

// ---- Meta / bridge handshake (GET) ----
router.get("/", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const { ok, challenge: ch } = verifyHandshake(mode, token, challenge);
  if (!ok) return c.text("Verification failed", 403);
  return c.text(ch ?? "");
});

// ---- Inbound messages (POST) ----
router.post("/", async (c) => {
  // Authorize via webhook header or, when the bridge can't sign, a shared secret.
  const authHeader = c.req.header("x-webhook-secret") ?? c.req.header("x-hub-signature-256");
  if (!(await authorizeWebhook(authHeader))) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  if (body?.object === "whatsapp_business_account") {
    // Meta sends a status-check payload for the business-account object.
    return c.json({ status: "ok" });
  }

  const inbound = normalizeInbound(body);
  if (!inbound.length) return c.json({ status: "ok", received: 0 });

  const db = await getDb();
  const cfg = whatsappConfig();

  let receivedCount = 0;
  for (const msg of inbound) {
    // Dedupe by provider message id — webhook delivery is at-least-once.
    const dup = (
      await db.execute({
        sql: "SELECT id FROM whatsapp_messages WHERE provider_message_id = ? LIMIT 1",
        args: [msg.providerMessageId],
      })
    ).rows[0];
    if (dup) continue;

    // Merge by phone: reuse an existing lead (caller, importer, whatever) so a
    // WhatsApp contact and a caller with the same number are one persona.
    const leadId = await findOrCreateLead(db, msg);

    const now = msg.timestamp || new Date().toISOString();
    const inboundId = crypto.randomUUID();

    await db.execute({
      sql: `INSERT INTO whatsapp_messages
        (id, lead_id, body, direction, from_number, to_number, provider_message_id, status, created_at)
        VALUES (?, ?, ?, 'inbound', ?, ?, ?, 'received', ?)`,
      args: [
        inboundId,
        leadId,
        msg.body,
        msg.from,
        cfg.fromNumber || null,
        msg.providerMessageId,
        now,
      ],
    });

    await insertEvent(db, {
      lead_id: leadId,
      channel: "whatsapp",
      type: "whatsapp",
      direction: "inbound",
      handled_by: "unhandled",
      action: "received",
      summary: msg.body.slice(0, 120),
      content: msg.body,
      source_ref: msg.providerMessageId,
      metadata: { from: msg.from, to: cfg.fromNumber || null, message_type: msg.messageType },
      created_at: now,
    });

    // Off-hours auto-acknowledgement (human-only for now — no AI reply).
    let acknowledged = false;
    if (!isWithinWorkingHours(new Date())) {
      acknowledged = await maybeAutoAck(db, msg, inboundId, cfg.fromNumber);
    }

    if (acknowledged) {
      await db.execute({
        sql: "UPDATE whatsapp_messages SET acknowledged_at = ? WHERE id = ?",
        args: [new Date().toISOString(), inboundId],
      });
    }

    receivedCount++;
  }

  return c.json({ status: "ok", received: receivedCount });
});

async function findOrCreateLead(db: Client, msg: {
  from: string;
  contactName: string | null;
  body: string;
}): Promise<string> {
  // Search existing leads by phone (trailing-digit tolerant match).
  const rows = (await db.execute("SELECT id, phone FROM leads WHERE phone IS NOT NULL AND phone != ''")).rows as unknown as
    | { id: string; phone: string | null }[];
  for (const r of rows) {
    if (phoneMatches(r.phone, msg.from)) return r.id;
  }

  // Unmatched sender → create a contact so the conversation has a home.
  const id = crypto.randomUUID();
  const name = msg.contactName?.trim() || msg.from;
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO leads (id, name, phone, source, status, score, last_activity, created_at)
      VALUES (?, ?, ?, 'whatsapp inbound', 'new', 0, ?, ?)`,
    args: [id, name, normalizePhone(msg.from), now, now],
  });
  return id;
}

/** Send an off-hours acknowledgement, debounced to once per window per number. */
async function maybeAutoAck(
  db: Client,
  msg: { from: string },
  inboundId: string,
  fromNumber: string | null
): Promise<boolean> {
  if (!fromNumber) return false;

  const recent = (
    await db.execute({
      sql: `SELECT id FROM whatsapp_messages
        WHERE direction = 'outbound' AND to_number = ? AND created_at >= ?
        ORDER BY created_at DESC LIMIT 1`,
      args: [msg.from, new Date(Date.now() - ACK_DEBOUNCE_MS).toISOString()],
    })
  ).rows[0];
  if (recent) return false; // already replied recently — don't spam

  const send = await sendText(msg.from, autoAckText());
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO whatsapp_messages
      (id, lead_id, body, direction, from_number, to_number, provider_message_id, status, created_at)
      VALUES (?, NULL, ?, 'outbound', ?, ?, ?, 'sent', ?)`,
    args: [
      crypto.randomUUID(),
      autoAckText(),
      fromNumber,
      normalizePhone(msg.from),
      send.providerMessageId,
      now,
    ],
  });
  await insertEvent(db, {
    lead_id: null,
    channel: "whatsapp",
    type: "whatsapp",
    direction: "outbound",
    handled_by: "human",
    action: "auto-acknowledged",
    summary: autoAckText().slice(0, 120),
    content: autoAckText(),
    source_ref: inboundId,
    metadata: { to: msg.from, provider_message_id: send.providerMessageId, off_hours: true },
    created_at: now,
  });
  return send.ok;
}

export default router;

