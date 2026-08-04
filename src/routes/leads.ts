import { Hono } from "hono";
import { z } from "zod";
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

router.post("/bulk", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(leadSchema).parse(await c.req.json());
  const db = await getDb();
  const inserted: Record<string, unknown>[] = [];
  for (const r of data) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.execute({
      sql: "INSERT OR REPLACE INTO leads (id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", r.score ?? 50, r.value ?? null, r.city ?? null, r.notes ?? null, now, now],
    });
    inserted.push({ ...r, id, status: r.status ?? "new", score: r.score ?? 50, last_activity: now, created_at: now });
  }
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

export default router;
