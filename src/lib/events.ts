import type { Client } from "@libsql/client";

// Unified activity model shared by every channel (email, whatsapp, call).
// One row per meaningful action; the dashboard "Live activity" feed reads this.

export type EventChannel = "email" | "whatsapp" | "call";

export async function insertEvent(
  db: Client,
  e: {
    lead_id?: string | null;
    channel: EventChannel;
    action: string;
    summary?: string | null;
    source_ref?: string | null;
    metadata?: unknown;
    created_at?: string;
  }
): Promise<void> {
  await db.execute({
    sql: "INSERT OR IGNORE INTO events (id, lead_id, channel, action, summary, source_ref, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    args: [
      crypto.randomUUID(),
      e.lead_id ?? null,
      e.channel,
      e.action,
      e.summary ?? null,
      e.source_ref ?? null,
      e.metadata !== undefined ? JSON.stringify(e.metadata) : null,
      e.created_at ?? new Date().toISOString(),
    ],
  });
}
