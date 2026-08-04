import type { IncomingMessage, ServerResponse } from "node:http";
import app from "./index";

// Vercel's Node bridge invokes the default export with Node-style (req, res),
// NOT a web-standard Request — so hono/vercel's `handle()` (which passes the
// raw req straight to app.fetch) crashes (e.g. `this.raw.headers.get is not a
// function`). Convert explicitly here; this also works if a web Request is
// passed instead.

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  // Let the Request constructor derive these from the actual body.
  headers.delete("content-length");
  headers.delete("transfer-encoding");

  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await readBody(req);
  }

  return new Request(url, { method: req.method ?? "GET", headers, body });
}

function sendNodeResponse(res: ServerResponse, response: Response) {
  res.statusCode = response.status;
  for (const [key, value] of response.headers.entries()) res.setHeader(key, value);
  response
    .arrayBuffer()
    .then((buf) => res.end(Buffer.from(buf)))
    .catch((e) => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    });
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const response = await app.fetch(await toWebRequest(req));
    if (res) {
      sendNodeResponse(res, response);
    } else {
      return response; // web-handler style invocation
    }
  } catch (e) {
    const body = JSON.stringify({ error: (e as Error).message });
    if (res) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(body);
    } else {
      return new Response(body, { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }
}
