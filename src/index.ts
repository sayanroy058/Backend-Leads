import { Hono } from "hono";
import { cors } from "hono/cors";
import authRoutes from "./routes/auth";
import leadsRoutes from "./routes/leads";
import messagesRoutes from "./routes/messages";
import aiRoutes from "./routes/ai";

const app = new Hono();

app.use("/*", cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:3000",
    "https://rosybrown-pig-742740.hostingersite.com",
  ],
  credentials: true,
}));

app.route("/api/auth", authRoutes);
app.route("/api/leads", leadsRoutes);
app.route("/api/messages", messagesRoutes);
app.route("/api/ai", aiRoutes);

app.get("/api/health", (c) => c.json({ status: "ok" }));

const port = parseInt(process.env.PORT ?? "3001");

console.log(`Backend running on http://localhost:${port}`);
export default { port, fetch: app.fetch };
