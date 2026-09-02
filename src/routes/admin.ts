import { Hono } from "hono";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { getDb, generateToken } from "../db";
import { authenticateAdmin, type AuthedUser } from "../middleware/auth";

const router = new Hono<{ Variables: { admin: AuthedUser } }>();

// Every route here is admin-only.
router.use("/*", async (c, next) => {
  const admin = await authenticateAdmin(c);
  if (!admin) return c.json({ error: "Forbidden" }, 403);
  c.set("admin", admin);
  await next();
});

const createUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email(),
  password: z.string().min(6),
  is_admin: z.boolean().optional(),
});

const resetPasswordSchema = z.object({ password: z.string().min(6) });

router.get("/users", async (c) => {
  const db = await getDb();
  const rows = (
    await db.execute(
      "SELECT id, name, email, is_admin, disabled, created_at FROM users ORDER BY created_at DESC"
    )
  ).rows as unknown as { id: number; name: string | null; email: string; is_admin: number; disabled: number; created_at: string }[];
  return c.json(rows.map((r) => ({ ...r, is_admin: !!r.is_admin, disabled: !!r.disabled })));
});

router.post("/users", async (c) => {
  try {
    const data = createUserSchema.parse(await c.req.json());
    const db = await getDb();
    const email = data.email.toLowerCase().trim();
    const existing = (await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] })).rows[0];
    if (existing) return c.json({ error: "Email already registered" }, 409);

    const hash = await bcrypt.hash(data.password, 10);
    const result = await db.execute({
      sql: "INSERT INTO users (name, email, password_hash, is_admin) VALUES (?, ?, ?, ?)",
      args: [data.name?.trim() || null, email, hash, data.is_admin ? 1 : 0],
    });
    const userId = Number(result.lastInsertRowid);
    const user = (
      await db.execute({
        sql: "SELECT id, name, email, is_admin, disabled, created_at FROM users WHERE id = ?",
        args: [userId],
      })
    ).rows[0] as unknown as { id: number; name: string | null; email: string; is_admin: number; disabled: number; created_at: string };
    return c.json({ ...user, is_admin: !!user.is_admin, disabled: !!user.disabled });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.delete("/users/:id", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot delete your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "DELETE FROM users WHERE id = ?", args: [id] });
  return c.json({ success: true });
});

router.post("/users/:id/disable", async (c) => {
  const admin = c.get("admin");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  if (id === admin.id) return c.json({ error: "You cannot disable your own account" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 1 WHERE id = ?", args: [id] });
  // Kick any active sessions immediately.
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true });
});

router.post("/users/:id/enable", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  await db.execute({ sql: "UPDATE users SET disabled = 0 WHERE id = ?", args: [id] });
  return c.json({ success: true });
});

router.post("/users/:id/reset-password", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
    const data = resetPasswordSchema.parse(await c.req.json());
    const db = await getDb();
    const hash = await bcrypt.hash(data.password, 10);
    await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
    // Force re-login everywhere with the new password.
    await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
    return c.json({ success: true });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

router.post("/users/:id/generate-password", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) return c.json({ error: "Invalid user id" }, 400);
  const db = await getDb();
  // Random 12-char password using URL-safe hex from the same token generator as sessions.
  const password = generateToken().slice(0, 12);
  const hash = await bcrypt.hash(password, 10);
  await db.execute({ sql: "UPDATE users SET password_hash = ? WHERE id = ?", args: [hash, id] });
  await db.execute({ sql: "DELETE FROM sessions WHERE user_id = ?", args: [id] });
  return c.json({ success: true, password });
});

export default router;
