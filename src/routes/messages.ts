import { Hono } from "hono";
import { z } from "zod";
import type { InStatement } from "@libsql/client";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";

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
  const statements: InStatement[] = data.map((r) => ({
    sql: "INSERT INTO whatsapp_messages (id, lead_id, body, status) VALUES (?, ?, ?, ?)",
    args: [crypto.randomUUID(), r.lead_id, r.body, r.status ?? "draft"],
  }));
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
  const statements: InStatement[] = data.map((r) => ({
    sql: "INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued"],
  }));
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
