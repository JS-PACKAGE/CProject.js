import { createServer as nodeServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { ApiError, type Config } from "./config";
import { record, Store } from "./store";

const BODY_BYTES = 10 * 1024 * 1024;
const COOKIE = "cproject_session";
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
class LoginLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  private active = 0;
  enter(ip: string, username: string): () => void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key);
    if (this.active >= 8 || this.entries.size >= 10_000) throw new ApiError(429, "rate_limit", "Too many login attempts; try again later");
    const keys: [string, number][] = [[`ip:${ip}`, 30], [`user:${username}`, 10]];
    for (const [key, limit] of keys) {
      const entry = this.entries.get(key);
      if (entry && entry.count >= limit) throw new ApiError(429, "rate_limit", "Too many login attempts; try again in 15 minutes");
    }
    for (const [key] of keys) {
      const entry = this.entries.get(key) ?? { count: 0, until: now + 15 * 60_000 };
      entry.count++;
      this.entries.set(key, entry);
    }
    this.active++;
    return () => { this.active--; };
  }
}
export function createServer(config: Config, store: Store) {
  const limiter = new LoginLimiter();
  const secure = new URL(config.publicUrl).protocol === "https:";
  const cookie = (token: string, clear = false) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 2_592_000}${secure ? "; Secure" : ""}`;
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
        const origin = req.headers.origin;
        if (origin !== undefined && origin !== config.publicUrl) throw new ApiError(403, "origin", "Untrusted request origin");
        if (req.method !== "GET" && (!origin || origin !== config.publicUrl))
          throw new ApiError(403, "origin", "Same-origin requests required for writes");
        if (req.headers.authorization !== undefined) throw new ApiError(401, "auth", "Cookie authentication required");
        if (path === "/api/info" && req.method === "GET") { json(res, 200, { service: "cproject-sync", version: 1 }); return; }
        if (path === "/api/login" && req.method === "POST") {
          const data = await body(req);
          if (!record(data) || Object.keys(data).some(key => key !== "username" && key !== "password") || typeof data.username !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(data.username) || typeof data.password !== "string" || Buffer.byteLength(data.password) > 1024) throw new ApiError(400, "validation", "Invalid login request");
          const leave = limiter.enter(req.socket.remoteAddress ?? "unknown", data.username);
          try {
            const session = await store.login(data.username, data.password);
            res.setHeader("Set-Cookie", cookie(session.token));
            json(res, 200, { user: session.user });
          } finally { leave(); }
          return;
        }
        const token = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
        const user = store.session(token);
        // A cookie can change in another tab between loading a draft and saving it.
        const expectedAccount = req.headers["x-cproject-account"];
        if (expectedAccount !== undefined && expectedAccount !== user.id)
          throw new ApiError(401, "account_changed", "The account changed in another tab. Sign in again.");
        if (path === "/api/session" && req.method === "GET") json(res, 200, { user });
        else if (path === "/api/logout" && req.method === "POST") { await body(req); store.logout(token); res.setHeader("Set-Cookie", cookie("", true)); json(res, 200, { ok: true }); }
        else if (path === "/api/workspace" && req.method === "GET") json(res, 200, store.workspace(user.id));
        else if (path === "/api/changes" && req.method === "GET") json(res, 200, store.changes(user.id));
        else if (path === "/api/commit" && req.method === "POST") json(res, 200, store.commit(user.id, await body(req)));
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
