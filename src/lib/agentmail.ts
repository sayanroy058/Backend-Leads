// Thin AgentMail REST client — https://docs.agentmail.to/api-reference
// The API key lives server-side only; the frontend talks to our own endpoints.
const API_BASE = (process.env.AGENTMAIL_API_BASE ?? "https://api.agentmail.to/v0").replace(/\/+$/, "");

export function agentmailConfig(): { apiKey: string; inbox: string } {
  const apiKey = process.env.AGENTMAIL_API_KEY;
  const inbox = process.env.AGENTMAIL_INBOX;
  if (!apiKey || !inbox) {
    throw new Error("AGENTMAIL_API_KEY and AGENTMAIL_INBOX must be set");
  }
  return { apiKey, inbox };
}

async function agentmailFetch(path: string, init?: RequestInit): Promise<any> {
  const { apiKey } = agentmailConfig();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AgentMail ${init?.method ?? "GET"} ${path} failed (${res.status}): ${detail.slice(0, 500)}`);
  }
  return res.json();
}

/** Send an email from the configured inbox. Returns the AgentMail message. */
export async function sendMessage(args: { to: string; subject: string; text: string; html?: string }) {
  const { inbox } = agentmailConfig();
  return agentmailFetch(`/inboxes/${encodeURIComponent(inbox)}/messages/send`, {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ to: args.to, subject: args.subject, text: args.text, ...(args.html ? { html: args.html } : {}) }),
  });
}

/** List the most recent messages in the configured inbox (newest first). */
export async function listMessages(args: { limit?: number } = {}) {
  const { inbox } = agentmailConfig();
  return agentmailFetch(`/inboxes/${encodeURIComponent(inbox)}/messages?limit=${args.limit ?? 50}`);
}

/** Fetch one full message (includes text/html bodies). */
export async function getMessage(messageId: string) {
  const { inbox } = agentmailConfig();
  return agentmailFetch(`/inboxes/${encodeURIComponent(inbox)}/messages/${encodeURIComponent(messageId)}`);
}
