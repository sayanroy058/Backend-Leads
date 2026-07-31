import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db";
import { authenticate } from "../middleware/auth";

const router = new Hono();

router.get("/", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = getDb().prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
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
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z.array(leadSchema).parse(await c.req.json());
  const db = getDb();
  const stmt = db.prepare("INSERT OR REPLACE INTO leads (id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const inserted: Record<string, unknown>[] = [];
  db.transaction((rows: typeof data) => {
    for (const r of rows) {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      stmt.run(id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", r.score ?? 50, r.value ?? null, r.city ?? null, r.notes ?? null, now, now);
      inserted.push({ ...r, id, status: r.status ?? "new", score: r.score ?? 50, last_activity: now, created_at: now });
    }
  })(data);
  return c.json(inserted);
});

router.post("/status", async (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z.object({ id: z.string(), status: z.enum(["new", "contacted", "qualified", "booked", "lost"]) }).parse(await c.req.json());
  getDb().prepare("UPDATE leads SET status = ?, last_activity = ? WHERE id = ?").run([status, new Date().toISOString(), id]);
  return c.json({ success: true });
});

router.get("/activity/counts", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  return c.json({
    emails: (db.prepare("SELECT COUNT(*) as c FROM email_messages").get() as { c: number }).c,
    whatsapps: (db.prepare("SELECT COUNT(*) as c FROM whatsapp_messages").get() as { c: number }).c,
    calls: (db.prepare("SELECT COUNT(*) as c FROM call_logs").get() as { c: number }).c,
    appts: (db.prepare("SELECT COUNT(*) as c FROM appointments").get() as { c: number }).c,
  });
});

router.get("/activity/feed", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = getDb();
  const emails = db.prepare("SELECT id, subject, status, created_at FROM email_messages ORDER BY created_at DESC LIMIT 20").all() as { id: string; subject: string; status: string; created_at: string }[];
  const was = db.prepare("SELECT id, status, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 20").all() as { id: string; status: string; created_at: string }[];
  const calls = db.prepare("SELECT id, status, outcome, created_at FROM call_logs ORDER BY created_at DESC LIMIT 20").all() as { id: string; status: string; outcome: string | null; created_at: string }[];
  const items = [
    ...emails.map((e) => ({ id: `e-${e.id}`, type: "email", text: `Email "${e.subject}" — ${e.status}`, when: e.created_at })),
    ...was.map((e) => ({ id: `w-${e.id}`, type: "whatsapp", text: `WhatsApp message — ${e.status}`, when: e.created_at })),
    ...calls.map((e) => ({ id: `c-${e.id}`, type: "call", text: `Call — ${e.status}${e.outcome ? ` · ${e.outcome}` : ""}`, when: e.created_at })),
  ].sort((a, b) => +new Date(b.when) - +new Date(a.when)).slice(0, 8);
  return c.json(items);
});

export default router;
