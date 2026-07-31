import { getDb } from "../db";

export function authenticate(c: { req: { header: (name: string) => string | undefined } }) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const db = getDb();
  const user = db.query(`
    SELECT u.id, u.name, u.email FROM sessions s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?
  `).get(token) as { id: number; name: string | null; email: string } | undefined;

  return user ?? null;
}
