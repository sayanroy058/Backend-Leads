// Gmail SMTP + IMAP mail client — replaces the earlier AgentMail integration.
//
// Sending: nodemailer over Gmail SMTP, authenticated with a Gmail App
// Password (NOT the account password — Gmail requires 2FA + an app-specific
// password for SMTP/IMAP basic auth: https://support.google.com/mail/answer/185833).
//
// Receiving: IMAP (imapflow) against Gmail's IMAP server, since Gmail has no
// lighter REST endpoint for reading mail without full OAuth setup — an app
// password only grants IMAP/SMTP basic auth, not the Gmail REST API.
//
// The exported functions mirror the old lib/agentmail.ts shape
// (sendMessage / listMessages / getMessage) so routes/messages.ts needed
// only minimal changes to switch providers.
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export function mailerConfig(): { user: string; appPassword: string; imapHost: string; smtpHost: string } {
  const user = process.env.GMAIL_USER;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  if (!user || !appPassword) {
    throw new Error("GMAIL_USER and GMAIL_APP_PASSWORD must be set");
  }
  return {
    user,
    appPassword,
    imapHost: process.env.GMAIL_IMAP_HOST ?? "imap.gmail.com",
    smtpHost: process.env.GMAIL_SMTP_HOST ?? "smtp.gmail.com",
  };
}

let transporter: ReturnType<typeof nodemailer.createTransport> | undefined;
function getTransporter() {
  if (!transporter) {
    const { user, appPassword, smtpHost } = mailerConfig();
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: 465,
      secure: true,
      auth: { user, pass: appPassword },
    });
  }
  return transporter;
}

export interface SentMessage {
  message_id: string | null;
  thread_id: string | null;
}

/** One file attached to an outbound email (nodemailer attachment shape). */
export interface MailAttachment {
  filename: string;
  contentType?: string;
  content: Buffer;
}

/** Send an email from the configured Gmail account. */
export async function sendMessage(args: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
}): Promise<SentMessage> {
  const { user } = mailerConfig();
  const info = await getTransporter().sendMail({
    from: user,
    to: args.to,
    subject: args.subject,
    text: args.text,
    ...(args.html ? { html: args.html } : {}),
    ...(args.attachments && args.attachments.length ? { attachments: args.attachments } : {}),
  });
  // Gmail SMTP doesn't return a thread id at send time (that's an IMAP/Gmail
  // API concept) — messageId is what we have to key off for dedupe on sync.
  return { message_id: info.messageId ?? null, thread_id: null };
}

export interface FetchedMessage {
  message_id: string;
  thread_id: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  extracted_text: string | null;
  extracted_html: string | null;
  timestamp: string | null;
  labels: string[];
}

async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const { user, appPassword, imapHost } = mailerConfig();
  const client = new ImapFlow({
    host: imapHost,
    port: 993,
    secure: true,
    auth: { user, pass: appPassword },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/**
 * List the most recent messages across INBOX and Sent (newest first),
 * mirroring the old AgentMail listMessages() shape closely enough for the
 * sync route to consume unchanged. Bodies are included directly — Gmail IMAP
 * has no cheaper "metadata-only" list the way AgentMail's REST API did, so
 * getMessage() below just re-fetches the same message by uid.
 */
export async function listMessages(args: { limit?: number } = {}): Promise<{ messages: FetchedMessage[] }> {
  const limit = args.limit ?? 50;
  const messages = await withImap(async (client) => {
    const out: FetchedMessage[] = [];
    for (const mailbox of ["INBOX", "[Gmail]/Sent Mail"]) {
      let lock;
      try {
        lock = await client.getMailboxLock(mailbox);
      } catch {
        continue; // mailbox name varies by locale/account — skip if missing
      }
      try {
        const box = client.mailbox;
        if (!box || typeof box === "boolean") continue;
        const total = box.exists;
        if (!total) continue;
        const from = Math.max(1, total - limit + 1);
        for await (const msg of client.fetch(`${from}:${total}`, { envelope: true, source: true, uid: true })) {
          if (!msg.source) continue;
          const parsed = await simpleParser(msg.source);
          out.push(toFetchedMessage(parsed, msg.uid, mailbox));
        }
      } finally {
        lock.release();
      }
    }
    out.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    return out.slice(0, limit);
  });
  return { messages };
}

/** Fetch one full message by its message_id (as returned from listMessages). */
export async function getMessage(messageId: string): Promise<FetchedMessage> {
  const [mailbox, uidStr] = messageId.split(":");
  const uid = Number(uidStr);
  return withImap(async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      for await (const msg of client.fetch({ uid }, { source: true, uid: true }, { uid: true })) {
        if (!msg.source) continue;
        const parsed = await simpleParser(msg.source);
        return toFetchedMessage(parsed, msg.uid, mailbox);
      }
      throw new Error(`Message ${messageId} not found`);
    } finally {
      lock.release();
    }
  });
}

function toFetchedMessage(parsed: Awaited<ReturnType<typeof simpleParser>>, uid: number, mailbox: string): FetchedMessage {
  const isSent = mailbox.toLowerCase().includes("sent");
  return {
    message_id: `${mailbox}:${uid}`,
    thread_id: (parsed.headers.get("thread-index") as string | undefined) ?? null,
    from: parsed.from?.text ?? null,
    to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : (parsed.to?.text ?? null),
    subject: parsed.subject ?? null,
    text: parsed.text ?? null,
    html: typeof parsed.html === "string" ? parsed.html : null,
    extracted_text: parsed.text ?? null,
    extracted_html: typeof parsed.html === "string" ? parsed.html : null,
    timestamp: parsed.date ? parsed.date.toISOString() : null,
    labels: isSent ? ["sent"] : [],
  };
}
