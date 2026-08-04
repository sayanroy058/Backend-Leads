import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
// Vercel serverless functions have a read-only filesystem except /tmp, so
// default to /tmp there. NOTE: /tmp is ephemeral — data does not persist
// across cold starts. Point DB_PATH at a hosted DB (e.g. Turso/Neon) for
// real persistence on serverless.
const DB_PATH =
  process.env.DB_PATH ??
  (process.env.VERCEL ? "/tmp/leadflow.db" : join(DB_DIR, "leadflow.db"));

let db: Database.Database;

function ensureDir() {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function initDb(database: Database.Database) {
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

  seedDemoUser(database);
}

// Hardcoded demo account so login works out of the box.
//   email:    testuser@gmail.com
//   password: Str0ng!P9a  (10 chars: upper + lower + digit + symbol)
// INSERT OR IGNORE keeps the seed idempotent across restarts/cold starts.
function seedDemoUser(database: Database.Database) {
  const hash = "$2b$10$/ixfDGIckZ5KISPFS5y7puGhS4MGJkUJHkrdgDMG.si2aBQtWHy2u";
  database
    .prepare("INSERT OR IGNORE INTO users (name, email, password_hash) VALUES (?, ?, ?)")
    .run("Test User", "testuser@gmail.com", hash);
}

export function getDb(): Database.Database {
  if (!db) {
    ensureDir();
    db = new Database(DB_PATH);
    initDb(db);
  }
  return db;
}

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
