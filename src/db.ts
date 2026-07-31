import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DB_DIR = join(import.meta.dir, "..", "data");
const DB_PATH = join(DB_DIR, "leadflow.db");

let db: Database;

function ensureDir() {
  if (!existsSync(DB_DIR)) {
    mkdirSync(DB_DIR, { recursive: true });
  }
}

function initDb(database: Database) {
  database.run("PRAGMA journal_mode=WAL");
  database.run("PRAGMA foreign_keys=ON");

  database.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);

  database.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

  database.run(`
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

  database.run(`
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

  database.run(`
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

  database.run(`
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

  database.run(`
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

  database.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      citations TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
}

export function getDb(): Database {
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
