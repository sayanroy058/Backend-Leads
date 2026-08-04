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
import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
var DB_PATH = process.env.DB_PATH ?? (process.env.VERCEL ? "/tmp/leadflow.db" : join(DB_DIR, "leadflow.db"));
var db;
function ensureDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
function initDb(database) {
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      company TEXT,
      source TEXT,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','booked','lost')),
      score INTEGER DEFAULT 50,
      value REAL,
      city TEXT,
      notes TEXT,
      last_activity TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS email_messages (
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
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      body TEXT,
      status TEXT DEFAULT 'draft',
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS call_logs (
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
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS appointments (
      id TEXT PRIMARY KEY,
      lead_id TEXT,
      call_id TEXT,
      title TEXT,
      scheduled_at TEXT,
      duration_min INTEGER DEFAULT 30,
      status TEXT DEFAULT 'confirmed',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL
    )`);
  database.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      citations TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
}
function getDb() {
  if (!db) {
    ensureDir();
    db = new Database(DB_PATH);
    initDb(db);
  }
  return db;
}
function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// src/middleware/auth.ts
function authenticate(c) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  const db2 = getDb();
  const user = db2.prepare(`
    SELECT u.id, u.name, u.email FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?
  `).get(token);
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
async function verifyPassword(db2, password, storedHash, userId) {
  if (storedHash.startsWith("$argon2")) {
    const ok = await argon2Verify(storedHash, password);
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      db2.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run([newHash, userId]);
    }
    return ok;
  }
  return bcrypt.compare(password, storedHash);
}
router.post("/register", async (c) => {
  try {
    const data = registerSchema.parse(await c.req.json());
    const db2 = getDb();
    const existing = db2.prepare("SELECT id FROM users WHERE email = ?").get(data.email.toLowerCase().trim());
    if (existing) return c.json({ error: "Email already registered" }, 409);
    const hash = await bcrypt.hash(data.password, 10);
    const result = db2.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run([data.name.trim() || null, data.email.toLowerCase().trim(), hash]);
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    db2.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run([token, userId]);
    const user = db2.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
    return c.json({ token, user });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/login", async (c) => {
  try {
    const data = loginSchema.parse(await c.req.json());
    const db2 = getDb();
    const user = db2.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?").get(data.email.toLowerCase().trim());
    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    const valid = await verifyPassword(db2, data.password, user.password_hash, user.id);
    if (!valid) return c.json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    db2.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run([token, user.id]);
    return c.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    return c.json({ error: e.message }, 400);
  }
});
router.post("/logout", async (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const authHeader = c.req.header("Authorization");
  const token = authHeader.slice(7);
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run([token]);
  return c.json({ success: true });
});
router.get("/me", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ user: null });
  return c.json({ user: { id: user.id, name: user.name, email: user.email } });
});
var auth_default = router;

// src/routes/leads.ts
import { Hono as Hono2 } from "hono";
import { z as z2 } from "zod";
var router2 = new Hono2();
router2.get("/", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = getDb().prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
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
router2.post("/bulk", async (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const data = z2.array(leadSchema).parse(await c.req.json());
  const db2 = getDb();
  const stmt = db2.prepare("INSERT OR REPLACE INTO leads (id, name, email, phone, company, source, status, score, value, city, notes, last_activity, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const inserted = [];
  db2.transaction((rows) => {
    for (const r of rows) {
      const id = crypto.randomUUID();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      stmt.run(id, r.name, r.email ?? null, r.phone ?? null, r.company ?? null, r.source ?? "import", r.status ?? "new", r.score ?? 50, r.value ?? null, r.city ?? null, r.notes ?? null, now, now);
      inserted.push({ ...r, id, status: r.status ?? "new", score: r.score ?? 50, last_activity: now, created_at: now });
    }
  })(data);
  return c.json(inserted);
});
router2.post("/status", async (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const { id, status } = z2.object({ id: z2.string(), status: z2.enum(["new", "contacted", "qualified", "booked", "lost"]) }).parse(await c.req.json());
  getDb().prepare("UPDATE leads SET status = ?, last_activity = ? WHERE id = ?").run([status, (/* @__PURE__ */ new Date()).toISOString(), id]);
  return c.json({ success: true });
});
router2.get("/activity/counts", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db2 = getDb();
  return c.json({
    emails: db2.prepare("SELECT COUNT(*) as c FROM email_messages").get().c,
    whatsapps: db2.prepare("SELECT COUNT(*) as c FROM whatsapp_messages").get().c,
    calls: db2.prepare("SELECT COUNT(*) as c FROM call_logs").get().c,
    appts: db2.prepare("SELECT COUNT(*) as c FROM appointments").get().c
  });
});
router2.get("/activity/feed", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db2 = getDb();
  const emails = db2.prepare("SELECT id, subject, status, created_at FROM email_messages ORDER BY created_at DESC LIMIT 20").all();
  const was = db2.prepare("SELECT id, status, created_at FROM whatsapp_messages ORDER BY created_at DESC LIMIT 20").all();
  const calls = db2.prepare("SELECT id, status, outcome, created_at FROM call_logs ORDER BY created_at DESC LIMIT 20").all();
  const items = [
    ...emails.map((e) => ({ id: `e-${e.id}`, type: "email", text: `Email "${e.subject}" \u2014 ${e.status}`, when: e.created_at })),
    ...was.map((e) => ({ id: `w-${e.id}`, type: "whatsapp", text: `WhatsApp message \u2014 ${e.status}`, when: e.created_at })),
    ...calls.map((e) => ({ id: `c-${e.id}`, type: "call", text: `Call \u2014 ${e.status}${e.outcome ? ` \xB7 ${e.outcome}` : ""}`, when: e.created_at }))
  ].sort((a, b) => +new Date(b.when) - +new Date(a.when)).slice(0, 8);
  return c.json(items);
});
var leads_default = router2;

// src/routes/messages.ts
import { Hono as Hono3 } from "hono";
import { z as z3 } from "zod";
var router3 = new Hono3();
router3.get("/chat", (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(getDb().prepare("SELECT * FROM chat_messages ORDER BY created_at ASC LIMIT 50").all());
});
router3.post("/chat", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { role, content, citations } = z3.object({ role: z3.enum(["user", "assistant"]), content: z3.string(), citations: z3.array(z3.string()).optional() }).parse(await c.req.json());
  const id = crypto.randomUUID();
  getDb().prepare("INSERT INTO chat_messages (id, role, content, citations) VALUES (?, ?, ?, ?)").run([id, role, content, citations ? JSON.stringify(citations) : null]);
  return c.json({ id });
});
router3.get("/emails", (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(getDb().prepare("SELECT * FROM email_messages ORDER BY created_at DESC LIMIT 100").all());
});
router3.post("/emails", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), subject: z3.string(), body: z3.string(), tone: z3.string().optional(), goal: z3.string().optional(), status: z3.string().optional() })).parse(await c.req.json());
  const db2 = getDb();
  const stmt = db2.prepare("INSERT INTO email_messages (id, lead_id, subject, body, tone, goal, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
  db2.transaction((rows) => {
    for (const r of rows) stmt.run(crypto.randomUUID(), r.lead_id, r.subject, r.body, r.tone ?? null, r.goal ?? null, r.status ?? "draft");
  })(data);
  return c.json({ success: true });
});
router3.post("/emails/status", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), opened_at: z3.string().optional() }).parse(await c.req.json());
  const db2 = getDb();
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
  db2.prepare(`UPDATE email_messages SET ${sets.join(", ")} WHERE id = ?`).run(vals);
  return c.json({ success: true });
});
router3.get("/whatsapps", (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(getDb().prepare("SELECT * FROM whatsapp_messages ORDER BY created_at DESC LIMIT 100").all());
});
router3.post("/whatsapps", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), body: z3.string(), status: z3.string().optional() })).parse(await c.req.json());
  const db2 = getDb();
  const stmt = db2.prepare("INSERT INTO whatsapp_messages (id, lead_id, body, status) VALUES (?, ?, ?, ?)");
  db2.transaction((rows) => {
    for (const r of rows) stmt.run(crypto.randomUUID(), r.lead_id, r.body, r.status ?? "draft");
  })(data);
  return c.json({ success: true });
});
router3.post("/whatsapps/status", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string(), sent_at: z3.string().optional(), delivered_at: z3.string().optional(), read_at: z3.string().optional() }).parse(await c.req.json());
  const db2 = getDb();
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
  db2.prepare(`UPDATE whatsapp_messages SET ${sets.join(", ")} WHERE id = ?`).run(vals);
  return c.json({ success: true });
});
router3.get("/calls", (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(getDb().prepare("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 50").all());
});
router3.post("/calls", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const data = z3.array(z3.object({ lead_id: z3.string(), goal: z3.string().optional(), voice: z3.string().optional(), status: z3.string().optional() })).parse(await c.req.json());
  const db2 = getDb();
  const stmt = db2.prepare("INSERT INTO call_logs (id, lead_id, goal, voice, status) VALUES (?, ?, ?, ?, ?)");
  db2.transaction((rows) => {
    for (const r of rows) stmt.run(crypto.randomUUID(), r.lead_id, r.goal ?? null, r.voice ?? null, r.status ?? "queued");
  })(data);
  return c.json(db2.prepare("SELECT * FROM call_logs ORDER BY created_at DESC LIMIT 50").all());
});
router3.post("/calls/status", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ id: z3.string(), status: z3.string().optional(), outcome: z3.string().optional(), transcript: z3.any().optional(), summary: z3.string().optional(), duration_sec: z3.number().optional(), started_at: z3.string().optional(), ended_at: z3.string().optional() }).parse(await c.req.json());
  const db2 = getDb();
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
  db2.prepare(`UPDATE call_logs SET ${sets.join(", ")} WHERE id = ?`).run(vals);
  return c.json({ success: true });
});
router3.get("/appointments", (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  return c.json(getDb().prepare("SELECT id, title, scheduled_at, lead_id FROM appointments ORDER BY scheduled_at ASC LIMIT 20").all());
});
router3.post("/appointments", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const d = z3.object({ lead_id: z3.string(), call_id: z3.string().optional(), title: z3.string(), scheduled_at: z3.string(), duration_min: z3.number().optional(), status: z3.string().optional() }).parse(await c.req.json());
  getDb().prepare("INSERT INTO appointments (id, lead_id, call_id, title, scheduled_at, duration_min, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run([crypto.randomUUID(), d.lead_id, d.call_id ?? null, d.title, d.scheduled_at, d.duration_min ?? 30, d.status ?? "confirmed"]);
  return c.json({ success: true });
});
var messages_default = router3;

// src/routes/ai.ts
import { Hono as Hono4 } from "hono";
import { z as z4 } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
var router4 = new Hono4();
var MODEL = process.env.AI_MODEL ?? "google/gemini-2.5-flash";
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
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { question, leads } = z4.object({ question: z4.string(), leads: z4.array(z4.any()) }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: "You are an assistant for a lead management CRM. Answer ONLY using the provided leads data. Be concise. Cite leads as [lead:FULL_ID]. Do not invent leads.",
    prompt: `Leads (${leads.length}):
${leadsBlock(leads)}

User question: ${question}`,
    temperature: 0.3
  });
  const ids = Array.from(text.matchAll(/\[lead:([a-z0-9-]{8,})\]/gi)).map((m) => m[1]);
  const cited = Array.from(new Set(ids)).map((short) => leads.find((l) => l.id.startsWith(short))?.id).filter(Boolean);
  return c.json({ text, citations: cited });
});
router4.post("/email", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, tone, goal, senderName } = z4.object({ lead: z4.any(), tone: z4.string(), goal: z4.string(), senderName: z4.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: `You write short, high-converting sales emails. Reply as strict JSON: {"subject":"...","body":"..."}. Keep body under 110 words. Sign as ${senderName ?? "Jordan"}.`,
    prompt: `Tone: ${tone}
Goal: ${goal}
Lead: ${JSON.stringify(lead)}`,
    temperature: 0.7
  });
  try {
    const j = JSON.parse(text.replace(/```json|```/g, "").trim());
    return c.json({ subject: j.subject ?? "", body: j.body ?? "" });
  } catch {
    return c.json({ subject: "", body: text });
  }
});
router4.post("/whatsapp", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, intent } = z4.object({ lead: z4.any(), intent: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: "Write a friendly, concise WhatsApp follow-up (1-3 sentences, max 280 chars). Use the lead's first name. One emoji max. Return ONLY the message body.",
    prompt: `Intent: ${intent}
Lead: ${JSON.stringify(lead)}`,
    temperature: 0.7
  });
  return c.json({ body: text.trim().replace(/^"|"$/g, "") });
});
router4.post("/call", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, goal } = z4.object({ lead: z4.any(), goal: z4.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL),
    system: 'Design AI voice agent call flows. Return strict JSON: {"opening":"...","talking_points":["..."],"objection_handling":["..."],"closing":"...","mock_transcript":[{"speaker":"agent|lead","text":"..."}],"summary":"...","suggested_outcome":"booked|interested|callback|not_interested|voicemail","book_appointment":true|false}. Transcript should be 6-10 turns.',
    prompt: `Call goal: ${goal}
Lead: ${JSON.stringify(lead)}`,
    temperature: 0.6
  });
  try {
    return c.json(JSON.parse(text.replace(/```json|```/g, "").trim()));
  } catch {
    return c.json({ suggested_outcome: "callback", book_appointment: false, summary: text, mock_transcript: [] });
  }
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
function sendNodeResponse(res, response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  response.arrayBuffer().then((buf) => res.end(Buffer.from(buf))).catch((e) => {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  });
}
async function handler(req, res) {
  try {
    const response = await index_default.fetch(await toWebRequest(req));
    if (res) {
      sendNodeResponse(res, response);
    } else {
      return response;
    }
  } catch (e) {
    const body = JSON.stringify({ error: e.message });
    if (res) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
    } else {
      return new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }
}
export {
  handler as default
};
