import { handle } from "hono/vercel";
import app from "./index";

// Vercel serverless entry. `npm run build` bundles this file (with the whole
// app) into a single api/index.js, so the function has no relative imports at
// runtime — @vercel/node does not bundle or rewrite extensionless imports.
export default handle(app);
