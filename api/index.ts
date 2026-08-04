import { handle } from "hono/vercel";
import app from "../src/index";

// Vercel serverless function entry — all routes are served by the Hono app
// (see vercel.json). `handle` wraps app.fetch as a web-standard handler,
// which the @vercel/node runtime invokes with a Request and expects a Response.
export default handle(app);
