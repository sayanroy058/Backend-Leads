import { Hono } from "hono";
import { z } from "zod";
import { authenticate } from "../middleware/auth";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

const router = new Hono();

const MODEL = process.env.AI_MODEL ?? "google/gemini-2.5-flash";

function gateway() {
  const apiKey = process.env.AI_API_KEY;
  const baseURL = process.env.AI_BASE_URL;
  if (!apiKey || !baseURL) throw new Error("Missing AI_API_KEY or AI_BASE_URL");
  return createOpenAICompatible({ name: "ai-provider", apiKey, baseURL });
}

function leadsBlock(leads: LeadCtx[]) {
  return leads.map((l) => `- [${l.id.slice(0, 8)}] ${l.name} · ${l.company ?? ""} · ${l.city ?? ""} · status=${l.status} · score=${l.score}`).join("\n");
}

type LeadCtx = { id: string; name: string; company: string | null; email: string | null; city: string | null; status: string; score: number; value: number | null; source: string | null; notes: string | null };

router.post("/chat", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { question, leads } = z.object({ question: z.string(), leads: z.array(z.any()) }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: "You are an assistant for a lead management CRM. Answer ONLY using the provided leads data. Be concise. Cite leads as [lead:FULL_ID]. Do not invent leads.",
    prompt: `Leads (${leads.length}):\n${leadsBlock(leads as LeadCtx[])}\n\nUser question: ${question}`,
    temperature: 0.3,
  });
  const ids = Array.from(text.matchAll(/\[lead:([a-z0-9-]{8,})\]/gi)).map((m) => m[1]);
  const cited = Array.from(new Set(ids)).map((short) => (leads as LeadCtx[]).find((l) => l.id.startsWith(short))?.id).filter(Boolean) as string[];
  return c.json({ text, citations: cited });
});

router.post("/email", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, tone, goal, senderName } = z.object({ lead: z.any(), tone: z.string(), goal: z.string(), senderName: z.string().optional() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: `You write short, high-converting sales emails. Reply as strict JSON: {"subject":"...","body":"..."}. Keep body under 110 words. Sign as ${senderName ?? "Jordan"}.`, prompt: `Tone: ${tone}\nGoal: ${goal}\nLead: ${JSON.stringify(lead)}`, temperature: 0.7,
  });
  try { const j = JSON.parse(text.replace(/```json|```/g, "").trim()); return c.json({ subject: j.subject ?? "", body: j.body ?? "" }); } catch { return c.json({ subject: "", body: text }); }
});

router.post("/whatsapp", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, intent } = z.object({ lead: z.any(), intent: z.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: "Write a friendly, concise WhatsApp follow-up (1-3 sentences, max 280 chars). Use the lead's first name. One emoji max. Return ONLY the message body.", prompt: `Intent: ${intent}\nLead: ${JSON.stringify(lead)}`, temperature: 0.7,
  });
  return c.json({ body: text.trim().replace(/^"|"$/g, "") });
});

router.post("/call", async (c) => {
  if (!authenticate(c)) return c.json({ error: "Unauthorized" }, 401);
  const { lead, goal } = z.object({ lead: z.any(), goal: z.string() }).parse(await c.req.json());
  const ai = gateway();
  const { text } = await generateText({
    model: ai(MODEL), system: "Design AI voice agent call flows. Return strict JSON: {\"opening\":\"...\",\"talking_points\":[\"...\"],\"objection_handling\":[\"...\"],\"closing\":\"...\",\"mock_transcript\":[{\"speaker\":\"agent|lead\",\"text\":\"...\"}],\"summary\":\"...\",\"suggested_outcome\":\"booked|interested|callback|not_interested|voicemail\",\"book_appointment\":true|false}. Transcript should be 6-10 turns.", prompt: `Call goal: ${goal}\nLead: ${JSON.stringify(lead)}`, temperature: 0.6,
  });
  try { return c.json(JSON.parse(text.replace(/```json|```/g, "").trim())); } catch { return c.json({ suggested_outcome: "callback", book_appointment: false, summary: text, mock_transcript: [] }); }
});

export default router;
