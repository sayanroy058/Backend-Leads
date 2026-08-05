// src/index.ts
import { serve } from "@hono/node-server";
import { Hono as Hono5 } from "hono";
import { cors } from "hono/cors";

// src/routes/auth.ts
import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { verify as argon2Verify } from "@node-rs/argon2";

// src/db.ts
import { createClient } from "@libsql/client";
var client;
var initPromise;
function getClient() {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set. Add them to your Vercel project environment variables (and locally) to connect to the hosted Turso database."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}
var TABLE_DDL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company TEXT,
    source TEXT,
    status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','booked','lost')),
    score INTEGER DEFAULT 0,
    value REAL,
    city TEXT,
    notes TEXT,
    last_activity TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS email_messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    subject TEXT,
    body TEXT,
    tone TEXT,
    goal TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    delivered_at TEXT,
    opened_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    body TEXT,
    status TEXT DEFAULT 'draft',
    sent_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_logs (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    goal TEXT,
    voice TEXT,
    status TEXT DEFAULT 'pending',
    outcome TEXT,
    transcript TEXT,
    summary TEXT,
    duration_sec INTEGER DEFAULT 0,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    lead_id TEXT,
    call_id TEXT,
    title TEXT,
    scheduled_at TEXT,
    duration_min INTEGER DEFAULT 30,
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content TEXT NOT NULL,
    citations TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`
];
var DEMO_USER_HASH = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";
async function initDb(c) {
  await c.batch(
    [
      ...TABLE_DDL,
      {
        sql: "INSERT OR IGNORE INTO users (id, name, email, password_hash) VALUES (1, ?, ?, ?)",
        args: ["Test User", "testuser@gmail.com", DEMO_USER_HASH]
      }
    ],
    "write"
  );
}
async function getDb() {
  const c = getClient();
  if (!initPromise) {
    initPromise = initDb(c).catch((err) => {
      initPromise = void 0;
      throw err;
    });
  }
  await initPromise;
  return c;
}
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/middleware/auth.ts
async function authenticate(c) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT u.id, u.name, u.email FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    args: [token]
  });
  const user = result.rows[0];
  return user ?? null;
}

// src/routes/auth.ts
var router = new Hono();
var registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6)
});
var loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
async function verifyPassword(db, password, storedHash, userId) {
  if (storedHash.startsWith("$argon2")) {
    const ok = await argon2Verify(storedHash, password);
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      await db.execute({
        sql: "UPDATE users SET password_hash = ? WHERE id = ?",
        args: [newHash, userId]
      });
    }
    return ok;
  }
  return bcrypt.compare(password, storedHash);
}
router.post("/register", async (c) => {
  try {
    const data = registerSchema.parse(await c.req.json());
    const db = await getDb();
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [data.email.toLowerCase().trim()] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);
    const hash = await bcrypt.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      args: [data.name.trim() || null, data.email.toLowerCase().trim(), hash]
    });
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, userId] });
    const user = (await db.execute({ sql: "SELECT id, name, email FROM users WHERE id = ?", args: [userId] })).rows[0];
    return c.json({ token, user });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/login", async (c) => {
  try {
    const data = loginSchema.parse(await c.req.json());
    const db = await getDb();
    const user = (await db.execute({
      sql: "SELECT id, name, email, password_hash FROM users WHERE email = ?",
      args: [data.email.toLowerCase().trim()]
    })).rows[0];
    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    const valid = await verifyPassword(db, data.password, user.password_hash, user.id);
    if (!valid) return c.json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    await db.execute({ sql: "INSERT INTO sessions (id, user_id) VALUES (?, ?)", args: [token, user.id] });
    return c.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/logout", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const authHeader = c.req.header("Authorization");
  const token = authHeader.slice(7);
  await (await getDb()).execute({ sql: "DELETE FROM sessions WHERE id = ?", args: [token] });
  return c.json({ success: true });
});
router.get("/me", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ user: null });
  return c.json({ user: { id: user.id, name: user.name, email: user.email } });
});
var auth_default = router;

// src/routes/leads.ts
import { Hono as Hono2 } from "hono";
import { z as z2 } from "zod";
var router2 = new Hono2();
router2.get("/", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM leads ORDER BY created_at DESC")).rows;
  return c.json(rows);
});
var leadSchema = z2.object({
  name: z2.string(),
  email: z2.string().nullable().optional(),
  phone: z2.string().nullable().optional(),
  company: z2.string().nullable().optional(),
  source: z2.string().nullable().optional(),
  status: z2.enum(["new", "contacted", "qualified", "booked", "lost"]).optional(),
  score: z2.number().optional(),
  value: z2.number().nullable().optional(),
  city: z2.string().nullable().optional(),
  notes: z2.string().nullable().optional()
});
var updateLeadSchema = z2.object({
  name: z2.string().optional(),
  email: z2.string().nullable().optional(),
  phone: z2.string().nullable().optional(),
  company: z2.string().nullable().optional(),
  source: z2.string().nullable().optional(),
  status: z2.enum(["new", "contacted", "qualified", "booked", "lost"]).optional(),
  score: z2.number().optional(),
  value: z2.number().nullable().optional(),
  city: z2.string().nullable().optional(),
  notes: z2.string().nullable().optional()
});
var SCORE_FIELDS = ["email", "phone", "company", "city", "notes", "value"];
function computeLeadScore(r) {
  let present = 0;
  for (const f of SCORE_FIELDS) {
    const v = r[f];
    if (v !== void 0 && v !== null && String(v).trim() !== "") present++;
  }
  return Math.round(present / SCORE_FIELDS.length * 100);
}
router2.post("/bulk", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z2.array(leadSchema).parse(await c.req.json());
  const db = await getDb();
  const inserted = [];
  const statements = [];
  for (const r of data) {
    const id = crypto.randomUUID();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    statements.push({
      sql: "INSERT OR REPLACE INTO leads (id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", computeLeadScore(r), r.value ?? null, r.city ?? null, r.notes ?? null, now, now]
    });
    inserted.push({ ...r, id, status: r.status ?? "new", score: computeLeadScore(r), last_activity: now, created_at: now });
  }
  if (statements.length) await db.batch(statements, "write");
  return c.json(inserted);
});
router2.post("/status", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z2.object({ id: z2.string(), status: z2.enum(["new", "contacted", "qualified", "booked", "lost"]) }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "UPDATE leads SET status = ?, last_activity = ? WHERE id = ?",
    args: [status, (/* @__PURE__ */ new Date()).toISOString(), id]
  });
  return c.json({ success: true });
});
router2.get("/activity/counts", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute(`SELECT
      (SELECT COUNT(*) FROM email_messages) AS emails,
      (SELECT COUNT(*) FROM whatsapp_messages) AS whatsapps,
      (SELECT COUNT(*) FROM call_logs) AS calls,
      (SELECT COUNT(*) FROM appointments) AS appts`)).rows;
  const row = rows[0];
  return c.json({ emails: row.emails, whatsapps: row.whatsapps, calls: row.calls, appts: row.appts });
});
router2.get("/activity/feed", async (c) => {
  const user = await authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = await getDb();
  const emails = (await db.execute("SELECT id, subject, status, created_at FROM email_messages ORDER BY created_at DESC LIMIT 20")).rows;
  const was = (await db.execute("SELECT id, status, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 20")).rows;
  const calls = (await db.execute("SELECT id, status, outcome, created_at FROM call_logs ORDER BY created_at DESC LIMIT 20")).rows;
  const items = [
    ...emails.map((e) => ({ id: `e-${e.id}`, type: "email", text: `Email "${e.subject}" \u2014 ${e.status}`, when: e.created_at })),
    ...was.map((e) => ({ id: `w-${e.id}`, type: "whatsapp", text: `WhatsApp message \u2014 ${e.status}`, when: e.created_at })),
    ...calls.map((e) => ({ id: `c-${e.id}`, type: "call", text: `Call \u2014 ${e.status}${e.outcome ? ` \xB7 ${e.outcome}` : ""}`, when: e.created_at }))
  ].sort((a, b) => +new Date(b.when) - +new Date(a.when)).slice(0, 8);
  return c.json(items);
});
router2.get("/:id", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const row = (await (await getDb()).execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [c.req.param("id")] })).rows[0];
  if (!row) return c.json({ error: "Lead not found" }, 404);
  return c.json(row);
});
router2.put("/:id", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  const data = updateLeadSchema.parse(await c.req.json());
  const db = await getDb();
  const existing = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0];
  if (!existing) return c.json({ error: "Lead not found" }, 404);
  const score = computeLeadScore({ ...existing, ...data });
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === "score") continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push("score = ?");
  vals.push(score);
  sets.push("last_activity = ?");
  vals.push((/* @__PURE__ */ new Date()).toISOString());
  vals.push(id);
  await db.execute({ sql: `UPDATE leads SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  const row = (await db.execute({ sql: "SELECT * FROM leads WHERE id = ?", args: [id] })).rows[0];
  return c.json(row);
});
router2.delete("/:id", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const id = c.req.param("id");
  await (await getDb()).execute({ sql: "DELETE FROM leads WHERE id = ?", args: [id] });
  return c.json({ success: true });
});
var leads_default = router2;

// src/routes/messages.ts
import { Hono as Hono3 } from "hono";
import { z as z3 } from "zod";
var router3 = new Hono3();
router3.get("/chat", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 50")).rows;
  return c.json(rows);
});
router3.post("/chat", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { role, content, citations } = z3.object({ role: z3.enum(["user", "assistant"]), content: z3.string(), citations: z3.array(z3.string()).optional() }).parse(await c.req.json());
  const id = crypto.randomUUID();
  await (await getDb()).execute({
    sql: "INSERT INTO chat_messages (id, role, content, citations) VALUES (?, ?, ?, ?)",
    args: [id, role, content, citations ? JSON.stringify(citations) : null]
  });
  return c.json({ id });
});
router3.get("/emails", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM email_messages ORDER BY created_at DESC LIMIT 100")).rows;
  return c.json(rows);
});
router3.post("/emails", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), subject: z3.string(), body: z3.string(), tone: z3.string().optional(), goal: z3.string().optional(), status: z3.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const statements = data.map((r) => ({
    sql: "INSERT INTO email_messages (id, lead_id, subject, body, tone, goal, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), r.lead_id, r.subject, r.body, r.tone ?? null, r.goal ?? null, r.status ?? "draft"]
  }));
  if (statements.length) await db.batch(statements, "write");
  return c.json({ success: true });
});
router3.post("/emails/status", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), opened_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  const sets = ["status = ?"];
  const vals = [d.status];
  if (d.sent_at) {
    sets.push("sent_at = ?");
    vals.push(d.sent_at);
  }
  if (d.delivered_at) {
    sets.push("delivered_at = ?");
    vals.push(d.delivered_at);
  }
  if (d.opened_at) {
    sets.push("opened_at = ?");
    vals.push(d.opened_at);
  }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE email_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});
router3.get("/whatsapps", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT 100")).rows;
  return c.json(rows);
});
router3.post("/whatsapps", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), body: z3.string(), status: z3.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const statements = data.map((r) => ({
    sql: "INSERT INTO whatsapp_messages (id, lead_id, body, status) VALUES (?, ?, ?, ?)",
    args: [crypto.randomUUID(), r.lead_id, r.body, r.status ?? "draft"]
  }));
  if (statements.length) await db.batch(statements, "write");
  return c.json({ success: true });
});
router3.post("/whatsapps/status", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), read_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  const sets = ["status = ?"];
  const vals = [d.status];
  if (d.sent_at) {
    sets.push("sent_at = ?");
    vals.push(d.sent_at);
  }
  if (d.delivered_at) {
    sets.push("delivered_at = ?");
    vals.push(d.delivered_at);
  }
  if (d.read_at) {
    sets.push("read_at = ?");
    vals.push(d.read_at);
  }
  vals.push(d.id);
  await db.execute({ sql: `UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});
router3.get("/calls", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 50")).rows;
  return c.json(rows);
});
router3.post("/calls", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), goal: z3.string().optional(), voice: z3.string().optional(), status: z3.string().optional() })).parse(await c.req.json());
  const db = await getDb();
  const statements = data.map((r) => ({
    sql: "INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued"]
  }));
  if (statements.length) await db.batch(statements, "write");
  const rows = (await db.execute("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 50")).rows;
  return c.json(rows);
});
router3.post("/calls/status", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string().optional(), outcome: z3.string().optional(), transcript: z3.any().optional(), summary: z3.string().optional(), duration_sec: z3.number().optional(), started_at: z3.string().optional(), ended_at: z3.string().optional() }).parse(await c.req.json());
  const db = await getDb();
  const sets = [];
  const vals = [];
  if (d.status !== void 0) {
    sets.push("status = ?");
    vals.push(d.status);
  }
  if (d.outcome !== void 0) {
    sets.push("outcome = ?");
    vals.push(d.outcome);
  }
  if (d.transcript !== void 0) {
    sets.push("transcript = ?");
    vals.push(JSON.stringify(d.transcript));
  }
  if (d.summary !== void 0) {
    sets.push("summary = ?");
    vals.push(d.summary);
  }
  if (d.duration_sec !== void 0) {
    sets.push("duration_sec = ?");
    vals.push(d.duration_sec);
  }
  if (d.started_at !== void 0) {
    sets.push("started_at = ?");
    vals.push(d.started_at);
  }
  if (d.ended_at !== void 0) {
    sets.push("ended_at = ?");
    vals.push(d.ended_at);
  }
  if (!sets.length) return c.json({ success: true });
  vals.push(d.id);
  await db.execute({ sql: `UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`, args: vals });
  return c.json({ success: true });
});
router3.get("/appointments", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const rows = (await (await getDb()).execute("SELECT id, title, scheduled_at, lead_id FROM appointments ORDER BY scheduled_at ASC LIMIT 20")).rows;
  return c.json(rows);
});
router3.post("/appointments", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ lead_id: z3.string(), call_id: z3.string().optional(), title: z3.string(), scheduled_at: z3.string(), duration_min: z3.number().optional(), status: z3.string().optional() }).parse(await c.req.json());
  await (await getDb()).execute({
    sql: "INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [crypto.randomUUID(), d.lead_id, d.call_id ?? null, d.title, d.scheduled_at, d.duration_min ?? 30, d.status ?? "confirmed"]
  });
  return c.json({ success: true });
});
var messages_default = router3;

// src/routes/ai.ts
import { Hono as Hono4 } from "hono";
import { z as z4 } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
var router4 = new Hono4();
var MODEL = process.env.AI_MODEL ?? "openai/gpt-5.6-luna";
function gateway() {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Missing AI_API_KEY or AI_BASE_URL");
  return createOpenAICompatible({ name: "ai-provider", apiKey, baseURL });
}
function leadsBlock(leads) {
  return leads.map((l) => `- [${l.id.slice(0, 8)}] ${l.name} \xB7 ${l.company ?? ""} \xB7 ${l.city ?? ""} \xB7 status=${l.status} \xB7 score=${l.score}`).join("\n");
}
router4.post("/chat", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { question, leads } = z4.object({ question: z4.string(), leads: z4.array(z4.any()) }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: "You are an assistant for a lead management CRM. Answer ONLY using the provided leads data. Be concise. Cite leads as [lead:FULL_ID]. Do not invent leads.",
    prompt: `Leads (${leads.length}):
${leadsBlock(leads)}

User question: ${question}`
  });
  const ids = Array.from(text.matchAll(/\[lead:([a-z0-9-]{8,})\]/gi)).map((m) => m[1]);
  const cited = Array.from(new Set(ids)).map((short) => leads.find((l) => l.id.startsWith(short))?.id).filter(Boolean);
  return c.json({ text, citations: cited });
});
router4.post("/email", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, tone, goal, senderName } = z4.object({ lead: z4.any(), tone: z4.string(), goal: z4.string(), senderName: z4.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: `You write short, high-converting sales emails. Reply as strict JSON: {"subject":"...","body":"..."}. Keep body under 110 words. Sign as ${senderName ?? "Jordan"}.`,
    prompt: `Tone: ${tone}
Goal: ${goal}
Lead: ${JSON.stringify(lead)}`
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({ subject: j.subject ?? "", body: j.body ?? "" });
  } catch {
    return c.json({ subject: "", body: text });
  }
});
router4.post("/whatsapp", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, intent } = z4.object({ lead: z4.any(), intent: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: "Write a friendly, concise WhatsApp follow-up (1-3 sentences, max 280 chars). Use the lead's first name. One emoji max. Return ONLY the message body.",
    prompt: `Intent: ${intent}
Lead: ${JSON.stringify(lead)}`
  });
  return c.json({ body: text.trim().replace(/^"|"$/g, "") });
});
router4.post("/call", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, goal } = z4.object({ lead: z4.any(), goal: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: 'Design AI voice agent call flows. Return strict JSON: {"opening":"...","talking_points":["..."],"objection_handling":["..."],"closing":"...","mock_transcript":[{"speaker":"agent|lead","text":"..."}],"summary":"...","suggested_outcome":"booked|interested|callback|not_interested|voicemail","book_appointment":true|false}. Transcript should be 6-10 turns.',
    prompt: `Call goal: ${goal}
Lead: ${JSON.stringify(lead)}`
  });
  try {
    return c.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch {
    return c.json({ suggested_outcome: "callback", book_appointment: false, summary: text, mock_transcript: [] });
  }
});
router4.post("/image", async (c) => {
  if (!await authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { prompt, size } = z4.object({ prompt: z4.string(), size: z4.string().optional() }).parse(await c.req.json());
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) return c.json({ error: "Missing AI_API_KEY or AI_BASE_URL" }, 500);
  const model = process.env.AI_IMAGE_MODEL ?? "gpt-image-2";
  const endpoint = `${baseURL.replace(/\/+$/, "")}/images/generations`;
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, prompt, n: 1, size: size ?? "auto" })
  });
  if (!upstream.ok) {
    const detail = await upstream.text();
    return c.json({ error: `Image generation failed (${upstream.status}): ${detail.slice(0, 500)}` }, 502);
  }
  const json = await upstream.json();
  const item = json.data?.[0];
  if (item?.b64_json) return c.json({ image: `data:image/png;base64,${item.b64_json}` });
  if (item?.url) return c.json({ image: item.url });
  return c.json({ error: "No image returned by the model" }, 502);
});
var ai_default = router4;

// src/index.ts
var extraOrigins = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
var app = new Hono5();
app.use("/*", cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://rosybrown-pig-742740.hostingersite.com",
    ...extraOrigins
  ],
  credentials: true
}));
app.route("/api/auth", auth_default);
app.route("/api/leads", leads_default);
app.route("/api/messages", messages_default);
app.route("/api/ai", ai_default);
app.get("/api/health", (c) => c.json({ status: "ok" }));
var index_default = app;
if (process.env.NODE_ENV !== "production") {
  const port = parseInt(process.env.PORT ?? "3001");
  console.log(`Backend running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
} else {
  console.log("Leadflow backend in serverless mode \u2014 no listener started.");
}

// src/vercel.ts
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : void 0));
    req.on("error", reject);
  });
}
async function toWebRequest(req) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === void 0) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
  }
  return new Request(url, { method: req.method ?? "GET", headers, body });
}
async function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  res.end(Buffer.from(await response.arrayBuffer()));
}
async function handler(req, res) {
  try {
    const response = await index_default.fetch(await toWebRequest(req));
    await sendNodeResponse(res, response);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: e.message }));
  }
}
export {
  handler as default
};
