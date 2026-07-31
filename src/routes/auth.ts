import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDb, generateToken } from "../db";
import { authenticate } from "../middleware/auth";

const router = new Hono();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

router.post("/register", async (c) => {
  try {
    const data = registerSchema.parse(await c.req.json());
    const db = getDb();
    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(data.email.toLowerCase().trim());
    if (existing) return c.json({ error: "Email already registered" }, 409);

    const hash = await bcrypt.hash(data.password, 10);
    const result = db.prepare("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)").run([data.name.trim() || null, data.email.toLowerCase().trim(), hash]);
    const userId = Number(result.lastInsertRowid);
    const token = generateToken();
    db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run([token, userId]);
    const user = db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(userId);
    return c.json({ token, user });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.post("/login", async (c) => {
  try {
    const data = loginSchema.parse(await c.req.json());
    const db = getDb();
    const user = db.prepare("SELECT id, name, email, password_hash FROM users WHERE email = ?").get(data.email.toLowerCase().trim()) as { id: number; name: string | null; email: string; password_hash: string } | undefined;
    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    const valid = await bcrypt.compare(data.password, user.password_hash);
    if (!valid) return c.json({ error: "Invalid email or password" }, 401);
    const token = generateToken();
    db.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run([token, user.id]);
    return c.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.post("/logout", async (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const authHeader = c.req.header("Authorization")!;
  const token = authHeader.slice(7);
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run([token]);
  return c.json({ success: true });
});

router.get("/me", (c) => {
  const user = authenticate(c);
  if (!user) return c.json({ user: null });
  return c.json({ user: { id: user.id, name: user.name, email: user.email } });
});

export default router;
