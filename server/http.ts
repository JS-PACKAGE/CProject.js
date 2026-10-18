import { createServer as nodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { ApiError, type Config } from "./config";
import { record, Store } from "./store";

const BODY_BYTES = 10 * 1024 * 1024;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json" };
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (req.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") throw new ApiError(400, "validation", "Expected application/json");
  if (Number(req.headers["content-length"]) > BODY_BYTES) { req.resume(); throw new ApiError(413, "limit", "Request exceeds 10 MiB"); }
  const { promise, resolve: resolveBody, reject } = Promise.withResolvers<unknown>();
  let size = 0;
  let exceeded = false;
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_BYTES) {
      if (!exceeded) { exceeded = true; chunks.length = 0; reject(new ApiError(413, "limit", "Request exceeds 10 MiB")); }
    } else if (!exceeded) chunks.push(chunk);
  });
  req.on("end", () => {
    if (exceeded) return;
    try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { reject(new ApiError(400, "validation", "Invalid JSON body")); }
  });
  req.on("error", reject);
  req.on("aborted", () => reject(new ApiError(400, "validation", "Request aborted")));
  return promise;
}
export function createServer(config: Config, store: Store) {
  const server = nodeServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const rawPath = (req.url ?? "/").split("?")[0]!;
      if (rawPath === "/api" || rawPath.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
      const path = decodeURIComponent(rawPath);
      if (path === "/api" || path.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
        if (req.headers["x-cproject-account"] !== undefined)
          throw new ApiError(409, "protocol_changed", "This server now uses one shared workspace. Reload the site before continuing.");
        if (path === "/api/info" && req.method === "GET") json(res, 200, { service: "cproject-sync", version: 2 });
        else if (path === "/api/workspace" && req.method === "GET") json(res, 200, store.workspace());
        else if (path === "/api/changes" && req.method === "GET") json(res, 200, store.changes());
        else if (path === "/api/commit" && req.method === "POST") json(res, 200, store.commit(await body(req)));
        else throw new ApiError(404, "not_found", "API endpoint not found");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError(405, "method", "Method not allowed");
      if (path.includes("\0") || path.includes("\\") || path.split("/").some(part => part === ".." || part.startsWith("."))) throw new ApiError(404, "not_found", "Not found");
      const root = await realpath(config.distDir);
      let file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(root + sep)) throw new ApiError(404, "not_found", "Not found");
      try { if (!(await stat(file)).isFile()) file = resolve(root, "index.html"); }
      catch { if (extname(path) || path.startsWith("/assets/")) throw new ApiError(404, "not_found", "Asset not found"); file = resolve(root, "index.html"); }
      file = await realpath(file);
      if (!file.startsWith(root + sep)) throw new ApiError(404, "not_found", "Not found");
      const content = await readFile(file);
      res.setHeader("Content-Type", MIME[extname(file)] ?? "application/octet-stream");
      res.setHeader("Cache-Control", file.endsWith("index.html") ? "no-cache" : "public, max-age=3600");
      res.setHeader("Content-Length", content.length);
      res.writeHead(200); res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof ApiError;
      const malformed = error instanceof URIError;
      const missing = record(error) && error.code === "ENOENT";
      json(res, known ? error.status : malformed ? 400 : missing ? 404 : 500, { error: known ? error.message : malformed ? "Invalid URL" : missing ? "Web assets not found; build the frontend first" : "Internal server error", code: known ? error.code : malformed ? "validation" : missing ? "not_found" : "internal" });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
