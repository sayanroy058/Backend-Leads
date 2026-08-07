import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import authRoutes from "./routes/auth";
import leadsRoutes from "./routes/leads";
import messagesRoutes from "./routes/messages";
import aiRoutes from "./routes/ai";
import conversationsRoutes from "./routes/conversations";
import whatsappWebhookRoutes from "./routes/whatsapp-webhook";

const extraOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const app = new Hono();

app.use("/*", cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://rosybrown-pig-742740.hostingersite.com",
    ...extraOrigins,
  ],
  credentials: true,
}));

app.route("/api/auth", authRoutes);
app.route("/api/leads", leadsRoutes);
app.route("/api/messages", messagesRoutes);
app.route("/api/ai", aiRoutes);
app.route("/api/conversations", conversationsRoutes);
app.route("/api/webhooks/whatsapp", whatsappWebhookRoutes); // public — Meta/bridge webhook

app.get("/api/health", (c) => c.json({ status: "ok" }));

export default app;

// Local dev only. On Vercel the app is served as a serverless function via
// api/index.ts (see vercel.json), so no listener may be started here.
if (process.env.NODE_ENV !== "production") {
  const port = parseInt(process.env.PORT ?? "3001");
  console.log(`Backend running on http://localhost:${port}`);
  serve({ fetch: app.fetch, port });
} else {
  console.log("Leadflow backend in serverless mode — no listener started.");
}
