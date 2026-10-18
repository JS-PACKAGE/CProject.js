import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  distDir: string;
  legacyAccount?: string;
}
export function configFromEnv(env = process.env): Config {
  const port = Number(env.CPROJECT_PORT ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid CPROJECT_PORT");
  return { host: env.CPROJECT_HOST ?? "127.0.0.1", port, dataDir: resolve(env.CPROJECT_DATA_DIR ?? "server-data"), distDir: resolve("dist"), legacyAccount: env.CPROJECT_LEGACY_ACCOUNT };
}
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function invalid(message: string): never { throw new ApiError(400, "validation", message); }
export function conflict(): never { throw new ApiError(409, "conflict", "Workspace changed; reload before editing"); }
