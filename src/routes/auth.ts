import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { verify as argon2Verify } from "@node-rs/argon2";
import { getDb, generateToken } from "../db";
import { authenticate } from "../middleware/auth";

const router = new Hono();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

/**
 * Verify a password against a stored hash, supporting both bcrypt and
 * legacy argon2id hashes (created by Bun's `Bun.password.hash` default).
 * Returns true if the password matches; on a successful argon2 match the
 * hash is re-hashed to bcrypt so the account migrates automatically.
 */
async function verifyPassword(db: ReturnType<typeof getDb>, password: string, storedHash: string, userId: number): Promise<boolean> {
  if (storedHash.startsWith("$argon2")) {
    const ok = await argon2Verify(storedHash, password);
    if (ok) {
      const newHash = await bcrypt.hash(password, 10);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run([newHash, userId]);
    }
    return ok;
  }
  return bcrypt.compare(password, storedHash);
}

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
    const valid = await verifyPassword(db, data.password, user.password_hash, user.id);
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
