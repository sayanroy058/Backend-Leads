import { Hono } from "hono";
import { z } from "zod";
import type { InStatement } from "@libsql/client";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";
import { sendMessage, listMessages, getMessage } from "../lib/agentmail";
import { insertEvent } from "../lib/events";
import { computeLeadScore } from "./leads";

const router = new Hono();

// ---- Chat ----
router.get("/chat", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 50")).rows;
  return c.json(rows);
});

router.post("/chat", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { role, content, citations } = z.object({ role: z.enum(["user", "assistant"]), content: z.string(), citations: z.array(z.string()).optional() }).parse(await c.req.json());
  const id = crypto.randomUUID();
  await (await getDb()).execute({
    sql: "INSERT INTO chat_messages (id, role, content, citations) VALUES (?, ?, ?, ?)",
    args: [id, role, content, citations ? JSON.stringify(citations) : null],
  });
  return c.json({ id });
});

// ---- Email ----
router.get("/emails", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM email_messages ORDER BY created_at DESC LIMIT 100")).rows;
  return c.json(rows);
});

router.post("/emails", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(z.object({ lead_id: z.string(), subject: z.string(), body: z.string(), tone: z.string().optional(), goal: z.string().optional(), status: z.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const statements: InStatement[] = data.map((r) => ({
    sql: "INSERT INTO email_messages (id, lead_id, subject, body, tone, goal, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), r.lead_id, r.subject, r.body, r.tone ?? null, r.goal ?? null, r.status ?? "draft"],
  }));
  if (statements.length) await db.batch(statements, "write"); // atomic insert
  return c.json({ success: true });
});

router.post("/emails/status", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ id: z.string(), status: z.string(), sent_at: z.string().optional(), delivered_at: z.string().optional(), opened_at: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  const sets = ["status = ?"]; const vals: (string | null)[] = [d.status];
  if (d.sent_at) { sets.push("sent_at = ?"); vals.push(d.sent_at); }
  if (d.delivered_at) { sets.push("delivered_at = ?"); vals.push(d.delivered_at); }
  if (d.opened_at) { sets.push("opened_at = ?"); vals.push(d.opened_at); }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE email_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});

// Actually send an email draft through AgentMail (leads-test@agentmail.to).
router.post("/emails/send", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const { id } = z.object({ id: z.string() }).parse(await c.req.json());
  const db = await getDb();
  const row = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0] as unknown as
    | { lead_id: string | null; subject: string; body: string }
    | undefined;
  if (!row) return c.json({ error: "Email not found" }, 404);
  if (!row.lead_id) return c.json({ error: "Email is not linked to a lead" }, 400);
  const lead = (await db.execute({ sql: "SELECT email FROM leads WHERE id = ?", args: [row.lead_id] })).rows[0] as unknown as
    | { email: string | null }
    | undefined;
  if (!lead?.email) return c.json({ error: "Lead has no email address — add one before sending" }, 400);
  try {
    const sent = await sendMessage({ to: lead.email, subject: row.subject, text: row.body });
    const inbox = process.env.AGENTMAIL_INBOX ?? "";
    const now = new Date().toISOString();
    await db.execute({
      sql: "UPDATE email_messages SET status = 'sent', sent_at = ?, from_email = ?, to_email = ?, agentmail_message_id = ?, agentmail_thread_id = ? WHERE id = ?",
      args: [now, inbox, lead.email, sent.message_id ?? null, sent.thread_id ?? null, id],
    });
    await db.execute({ sql: "UPDATE leads SET status = 'contacted', last_activity = ? WHERE id = ?", args: [now, row.lead_id] });
    await insertEvent(db, {
      lead_id: row.lead_id,
      channel: "email",
      action: "sent",
      summary: row.subject,
      source_ref: id,
      metadata: { message_id: sent.message_id ?? null, thread_id: sent.thread_id ?? null, to: lead.email },
      created_at: now,
    });
    const updated = (await db.execute({ sql: "SELECT * FROM email_messages WHERE id = ?", args: [id] })).rows[0];
    return c.json(updated);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
});

// Pull the latest inbound mail from the AgentMail inbox into email_messages.
router.post("/emails/sync", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  let msgs: any[] = [];
  try {
    const res = await listMessages({ limit: 50 });
    msgs = Array.isArray(res.messages) ? res.messages : [];
  } catch (e) {
    return c.json({ error: (e as Error).message }, 502);
  }
  let synced = 0;
  for (const m of msgs) {
    if (!m.message_id) continue;
    if (Array.isArray(m.labels) && m.labels.includes("sent")) continue; // outbound copy
    const existing = (await db.execute({ sql: "SELECT id FROM email_messages WHERE agentmail_message_id = ?", args: [m.message_id] })).rows[0];
    if (existing) continue; // already synced
    let full = m;
    try {
      full = await getMessage(m.message_id); // list omits bodies — fetch content
    } catch { /* keep metadata-only */ }
    const fromEmail = extractEmail(full.from);
    const toEmail = Array.isArray(full.to) ? full.to[0] ?? null : typeof full.to === "string" ? full.to : null;
    const body = full.extracted_text ?? full.text ?? stripHtml(full.extracted_html ?? full.html);
    let leadId: string | null = null;
    if (fromEmail) {
      const lead = (await db.execute({ sql: "SELECT id FROM leads WHERE email = ?", args: [fromEmail] })).rows[0] as unknown as
        | { id: string }
        | undefined;
      if (lead) {
        leadId = lead.id;
      } else {
        // Unmatched sender → create a contact from the inbound email.
        const now = new Date().toISOString();
        const newId = crypto.randomUUID();
        const name = extractName(full.from) ?? fromEmail;
        await db.execute({
          sql: "INSERT INTO leads (id, name, email, source, status, score, last_activity, created_at) VALUES (?, ?, ?, 'inbound email', 'new', ?, ?, ?)",
          args: [newId, name, fromEmail, computeLeadScore({ email: fromEmail, name }), now, now],
        });
        leadId = newId;
      }
    }
    const emailRowId = crypto.randomUUID();
    const emailCreatedAt = full.timestamp ?? new Date().toISOString();
    await db.execute({
      sql: "INSERT INTO email_messages (id, lead_id, subject, body, direction, status, from_email, to_email, agentmail_message_id, agentmail_thread_id, created_at) VALUES (?, ?, ?, ?, 'inbound', 'received', ?, ?, ?, ?, ?)",
      args: [emailRowId, leadId, full.subject ?? null, body, fromEmail, toEmail, full.message_id, full.thread_id ?? null, emailCreatedAt],
    });
    await insertEvent(db, {
      lead_id: leadId,
      channel: "email",
      action: "received",
      summary: full.subject ?? "(no subject)",
      source_ref: emailRowId,
      metadata: { from: fromEmail, message_id: full.message_id },
      created_at: emailCreatedAt,
    });
    synced++;
  }
  return c.json({ synced, total: msgs.length });
});

/** Pull the email address out of a display string like "Name <user@example.com>". */
function extractEmail(from: unknown): string | null {
  if (!from) return null;
  const s = String(from).trim();
  const m = s.match(/<([^<>]+)>/);
  return (m ? m[1] : s) || null;
}

/** Pull the display name out of "Name <user@example.com>", if present. */
function extractName(from: unknown): string | null {
  if (!from) return null;
  const m = String(from).trim().match(/^(.*?)\s*<[^<>]+>$/);
  return m && m[1].trim() ? m[1].trim() : null;
}

/** Crude HTML → text for preview bodies when no plain-text part exists. */
function stripHtml(html: unknown): string | null {
  if (!html) return null;
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

// ---- WhatsApp ----
router.get("/whatsapps", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT 100")).rows;
  return c.json(rows);
});

router.post("/whatsapps", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(z.object({ lead_id: z.string(), body: z.string(), status: z.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const now = new Date().toISOString();
  const statements: InStatement[] = data.flatMap((r) => {
    const id = crypto.randomUUID();
    return [
      { sql: "INSERT INTO whatsapp_messages (id, lead_id, body, status) VALUES (?, ?, ?, ?)", args: [id, r.lead_id, r.body, r.status ?? "draft"] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'whatsapp', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "draft", r.body.slice(0, 120), id, now] },
    ];
  });
  if (statements.length) await db.batch(statements, "write"); // atomic insert
  return c.json({ success: true });
});

router.post("/whatsapps/status", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ id: z.string(), status: z.string(), sent_at: z.string().optional(), delivered_at: z.string().optional(), read_at: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  const sets = ["status = ?"]; const vals: (string | null)[] = [d.status];
  if (d.sent_at) { sets.push("sent_at = ?"); vals.push(d.sent_at); }
  if (d.delivered_at) { sets.push("delivered_at = ?"); vals.push(d.delivered_at); }
  if (d.read_at) { sets.push("read_at = ?"); vals.push(d.read_at); }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const w = (await db.execute({ sql: "SELECT lead_id FROM whatsapp_messages WHERE id = ?", args: [d.id] })).rows[0] as unknown as { lead_id: string | null } | undefined;
  await insertEvent(db, { lead_id: w?.lead_id ?? null, channel: "whatsapp", action: d.status, source_ref: d.id });
  return c.json({ success: true });
});

// ---- Calls ----
router.get("/calls", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 50")).rows;
  return c.json(rows);
});

router.post("/calls", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(z.object({ lead_id: z.string(), goal: z.string().optional(), voice: z.string().optional(), status: z.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const now = new Date().toISOString();
  const statements: InStatement[] = data.flatMap((r) => {
    const id = crypto.randomUUID();
    return [
      { sql: "INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)", args: [id, r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued"] },
      { sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, created_at) VALUES (?, ?, 'call', ?, ?, ?, ?)", args: [crypto.randomUUID(), r.lead_id, r.status ?? "queued", r.goal ?? null, id, now] },
    ];
  });
  if (statements.length) await db.batch(statements, "write"); // atomic insert
  const rows = (await db.execute("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 50")).rows;
  return c.json(rows);
});

router.post("/calls/status", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ id: z.string(), status: z.string().optional(), outcome: z.string().optional(), transcript: z.any().optional(), summary: z.string().optional(), duration_sec: z.number().optional(), started_at: z.string().optional(), ended_at: z.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  const sets: string[] = []; const vals: (string | number | null)[] = [];
  if (d.status !== undefined) { sets.push("status = ?"); vals.push(d.status); }
  if (d.outcome !== undefined) { sets.push("outcome = ?"); vals.push(d.outcome); }
  if (d.transcript !== undefined) { sets.push("transcript = ?"); vals.push(JSON.stringify(d.transcript)); }
  if (d.summary !== undefined) { sets.push("summary = ?"); vals.push(d.summary); }
  if (d.duration_sec !== undefined) { sets.push("duration_sec = ?"); vals.push(d.duration_sec); }
  if (d.started_at !== undefined) { sets.push("started_at = ?"); vals.push(d.started_at); }
  if (d.ended_at !== undefined) { sets.push("ended_at = ?"); vals.push(d.ended_at); }
  if (!sets.length) return c.json({ success: true });
  vals.push(d.id);
  await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const cl = (await db.execute({ sql: "SELECT lead_id FROM call_logs WHERE id = ?", args: [d.id] })).rows[0] as unknown as { lead_id: string | null } | undefined;
  await insertEvent(db, { lead_id: cl?.lead_id ?? null, channel: "call", action: d.outcome ?? d.status ?? "updated", source_ref: d.id });
  return c.json({ success: true });
});

// ---- Appointments ----
router.get("/appointments", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT id, title, scheduled_at, lead_id FROM appointments ORDER BY scheduled_at ASC LIMIT 20")).rows;
  return c.json(rows);
});

router.post("/appointments", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const d = z.object({ lead_id: z.string(), call_id: z.string().optional(), title: z.string(), scheduled_at: z.string(), duration_min: z.number().optional(), status: z.string().optional() }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), d.lead_id, d.call_id ?? null, d.title, d.scheduled_at, d.duration_min ?? 30, d.status ?? "confirmed"],
  });
  return c.json({ success: true });
});

export default router;
