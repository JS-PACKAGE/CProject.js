import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  publicUrl: string;
  allowedOrigins: string[];
  distDir: string;
}
export const desktopOrigins: Record<string, true> = { "tauri://localhost": true, "http://tauri.localhost": true, "https://tauri.localhost": true };
export function configFromEnv(env = process.env): Config {
  const publicUrl = env.CPROJECT_PUBLIC_URL ?? "http://localhost:8787";
  const url = new URL(publicUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))))
    throw new Error("CPROJECT_PUBLIC_URL must be an HTTPS origin (loopback HTTP is allowed)");
  const allowedOrigins = (env.CPROJECT_ALLOWED_ORIGINS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  for (const origin of allowedOrigins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password)
      throw new Error("CPROJECT_ALLOWED_ORIGINS must contain explicit HTTP(S) origins");
  }
  const port = Number(env.CPROJECT_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CPROJECT_PORT");
  return { host: env.CPROJECT_HOST ?? "127.0.0.1", port, dataDir: resolve(env.CPROJECT_DATA_DIR ?? "server-data"), publicUrl: url.origin, allowedOrigins, distDir: resolve("dist") };
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function invalid(message: string): never { throw new ApiError(400, "validation", message); }
export function conflict(): never { throw new ApiError(409, "conflict", "Workspace changed; reload before editing"); }
