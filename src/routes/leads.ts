import { Hono } from "hono";
import { z } from "zod";
import type { InStatement } from "@libsql/client";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";

const router = new Hono();

router.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM leads ORDER BY created_at DESC")).rows;
  return c.json(rows);
});

const leadSchema = z.object({
  name: z.string(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  status: z.enum(["new", "contacted", "qualified", "booked", "lost"]).optional(),
  score: z.number().optional(),
  value: z.number().nullable().optional(),
  city: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const updateLeadSchema = z.object({
  name: z.string().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  status: z.enum(["new", "contacted", "qualified", "booked", "lost"]).optional(),
  score: z.number().optional(),
  value: z.number().nullable().optional(),
  city: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

const SCORE_FIELDS = ["email", "phone", "company", "city", "notes", "value"] as const;

// Score 0-100 based on how many lead fields are filled vs. missing.
function computeLeadScore(r: Record<string, unknown>): number {
  let present = 0;
  for (const f of SCORE_FIELDS) {
    const v = r[f];
    if (v !== undefined && v !== null && String(v).trim() !== "") present++;
  }
  return Math.round((present / SCORE_FIELDS.length) * 100);
}

router.post("/bulk", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(leadSchema).parse(await c.req.json());
  const db = await getDb();
  const inserted: Record<string, unknown>[] = [];
  const statements: InStatement[] = [];
  for (const r of data) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    statements.push({
      sql: "INSERT OR REPLACE INTO leads (id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", computeLeadScore(r), r.value ?? null, r.city ?? null, r.notes ?? null, now, now],
    });
    inserted.push({ ...r, id, status: r.status ?? "new", score: computeLeadScore(r), last_activity: now, created_at: now });
  }
  if (statements.length) await db.batch(statements, "write"); // atomic import
  return c.json(inserted);
});

router.post("/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z.object({ id: z.string(), status: z.enum(["new", "contacted", "qualified", "booked", "lost"]) }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "UPDATE leads SET status = ?, last_activity = ? WHERE id = ?",
    args: [status, new Date().toISOString(), id],
  });
  return c.json({ success: true });
});

router.get("/activity/counts", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (
    await (await getDb()).execute(`SELECT
      (SELECT COUNT(*) FROM email_messages) AS emails,
      (SELECT COUNT(*) FROM whatsapp_messages) AS whatsapps,
      (SELECT COUNT(*) FROM call_logs) AS calls,
      (SELECT COUNT(*) FROM appointments) AS appts`)
  ).rows;
  const row = rows[0] as unknown as { emails: number; whatsapps: number; calls: number; appts: number };
  return c.json({ emails: row.emails, whatsapps: row.whatsapps, calls: row.calls, appts: row.appts });
});

router.get("/activity/feed", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const emails = (await db.execute("SELECT id, subject, status, created_at FROM email_messages ORDER BY created_at DESC LIMIT 20")).rows as unknown as { id: string; subject: string; status: string; created_at: string }[];
  const was = (await db.execute("SELECT id, status, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 20")).rows as unknown as { id: string; status: string; created_at: string }[];
  const calls = (await db.execute("SELECT id, status, outcome, created_at FROM call_logs ORDER BY created_at DESC LIMIT 20")).rows as unknown as { id: string; status: string; outcome: string | null; created_at: string }[];
  const items = [
    ...emails.map((e) => ({ id: `e-${e.id}`, type: "email", text: `Email "${e.subject}" — ${e.status}`, when: e.created_at })),
    ...was.map((e) => ({ id: `w-${e.id}`, type: "whatsapp", text: `WhatsApp message — ${e.status}`, when: e.created_at })),
    ...calls.map((e) => ({ id: `c-${e.id}`, type: "call", text: `Call — ${e.status}${e.outcome ? ` · ${e.outcome}` : ""}`, when: e.created_at })),
  ].sort((a, b) => +new Date(b.when) - +new Date(a.when)).slice(0, 8);
  return c.json(items);
});

router.get("/:id", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const row = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [c.req.param("id")] })).rows[0];
  if (!row) return c.json({ error: "Lead not found" }, 404);
  return c.json(row);
});

router.put("/:id", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const data = updateLeadSchema.parse(await c.req.json());
  const db = await getDb();
  const existing = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0] as Record<string, unknown> | undefined;
  if (!existing) return c.json({ error: "Lead not found" }, 404);
  const score = computeLeadScore({ ...existing, ...data });
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "score") continue; // score is auto-computed from field completeness
    sets.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  sets.push("score = ?");
  vals.push(score);
  sets.push("last_activity = ?");
  vals.push(new Date().toISOString());
  vals.push(id);
  await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0];
  return c.json(row);
});

router.delete("/:id", async (c) => {
  if (!(await authenticate(c))) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  await (await getDb()).execute({ sql: "DELETE FROM leads WHERE id = ?", args: [id] });
  return c.json({ success: true });
});

export default router;
