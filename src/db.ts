import { createClient, type Client } from "@libsql/client";

let client: Client | undefined;
let initPromise: Promise<void> | undefined;

function getClient(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error(
        "TURSO_DATABASE_URL and TURSO_AUTH_TOKEN must be set. " +
          "Add them to your Vercel project environment variables (and locally) " +
          "to connect to the hosted Turso database."
      );
    }
    client = createClient({ url, authToken });
  }
  return client;
}

// Idempotent schema — safe to run on every cold start.
const TABLE_DDL = [
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
    score INTEGER DEFAULT 50,
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
  )`,
];

// Hardcoded demo account so login works out of the box.
//   email:    testuser@gmail.com
//   password: Str0ng!P9a  (10 chars: upper + lower + digit + symbol)
// INSERT OR IGNORE keeps the seed idempotent across restarts/cold starts.
const DEMO_USER_HASH = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";

async function initDb(c: Client) {
  for (const stmt of TABLE_DDL) {
    await c.execute(stmt);
  }
  await c.execute({
    sql: "INSERT OR IGNORE INTO users (name, email, password_hash) VALUES (?, ?, ?)",
    args: ["Test User", "testuser@gmail.com", DEMO_USER_HASH],
  });
}

/**
 * Returns the Turso client, ensuring the schema + demo user exist on first use.
 * Lazily initialized so serverless cold starts stay fast.
 */
export async function getDb(): Promise<Client> {
  const c = getClient();
  if (!initPromise) {
    initPromise = initDb(c).catch((err) => {
      initPromise = undefined; // allow retry on next call
      throw err;
    });
  }
  await initPromise;
  return c;
}

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
