import { getDb } from "../db";

export async function authenticate(c: { req: { header: (name: string) => string | undefined } }) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);

  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT u.id, u.name, u.email FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    args: [token],
  });
  const user = result.rows[0] as unknown as { id: number; name: string | null; email: string } | undefined;

  return user ?? null;
}
