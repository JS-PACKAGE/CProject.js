import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { v7 } from "uuid";
import type { Change, Entity, Settings, Snapshot } from "../src/core/types";
import { initialSnapshot, tables, webSettings } from "../src/data/entity";
import { validateSnapshot } from "../src/data/validation";
import { expandEvents } from "../src/core/calendar";
import { ApiError, conflict, invalid } from "./config";

function derive(password: string, salt: string): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>();
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
    if (error) reject(error); else resolve(key);
  });
  return promise;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKSPACE_BYTES = 5 * 1024 * 1024;
export const LOG_BYTES = 40 * 1024 * 1024;
const LOG_ENTRIES = 100_000;
export type User = { id: string; username: string };
type Account = User & { salt: string; password_hash: string };
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function cloudSettings(value: unknown): asserts value is Settings {
  if (!record(value) || value.notification_sound !== true || Object.keys(value).some(key => !["language", "notification_sound", "default_reminder_offsets"].includes(key)))
    invalid("Only shared web settings can be synchronized");
}
function hash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "sync.sqlite"));
    chmodSync(join(directory, "sync.sqlite"), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, snapshot TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, log_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL, UNIQUE(user_id,id));
      CREATE INDEX IF NOT EXISTS changes_account ON changes(user_id,seq);`);
    this.migrateWebSettings();
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private migrateWebSettings(): void {
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version >= 1) return;
    this.transaction(() => {
      const normalize = (value: unknown): Settings => {
        if (!record(value) || typeof value.language !== "string" || !Array.isArray(value.default_reminder_offsets))
          throw new Error("Invalid persisted settings");
        return { ...webSettings(value as unknown as Settings), notification_sound: true };
      };
      const accounts = this.db.prepare("SELECT id,snapshot FROM accounts").all() as { id: string; snapshot: string }[];
      for (const account of accounts) {
        const snapshot = JSON.parse(account.snapshot) as Snapshot;
        snapshot.settings = normalize(snapshot.settings);
        validateSnapshot(snapshot);
        this.db.prepare("UPDATE accounts SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), account.id);
        const changes = this.db.prepare("SELECT seq,body FROM changes WHERE user_id=? ORDER BY seq").all(account.id) as { seq: number; body: string }[];
        let bytes = 0;
        for (const row of changes) {
          const change = JSON.parse(row.body) as Change;
          if (change.table === "settings") {
            change.before = normalize(change.before);
            change.payload = normalize(change.payload);
            row.body = JSON.stringify(change);
            this.db.prepare("UPDATE changes SET body=? WHERE seq=?").run(row.body, row.seq);
          }
          bytes += Buffer.byteLength(row.body) + 1;
        }
        this.db.prepare("UPDATE accounts SET log_bytes=?,log_count=? WHERE id=?").run(bytes, changes.length, account.id);
      }
      // Keep the historical session schema so existing browser sessions remain valid.
      this.db.prepare("DELETE FROM sessions WHERE kind <> 'web'").run();
      this.db.exec("PRAGMA user_version=1");
    });
  }
  async provision(username: string, password: string, reset = false): Promise<User> {
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username)) invalid("Username must be 1–64 ASCII letters, digits, _, . or -");
    if (password.length < 12 || Buffer.byteLength(password) > 1024) invalid("Password must contain at least 12 characters and at most 1024 bytes");
    const salt = randomBytes(32).toString("hex");
    const passwordHash = (await derive(password, salt)).toString("hex");
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id,username FROM accounts WHERE username=?").get(username) as User | undefined;
      if (existing) {
        if (!reset) throw new ApiError(409, "exists", "Account exists; use --reset-password to rotate its password and revoke sessions");
        this.db.prepare("UPDATE accounts SET salt=?,password_hash=? WHERE id=?").run(salt, passwordHash, existing.id);
        this.db.prepare("DELETE FROM sessions WHERE user_id=?").run(existing.id);
        return existing;
      }
      const user = { id: v7(), username };
      const snapshot = initialSnapshot();
      validateSnapshot(snapshot);
      this.db.prepare("INSERT INTO accounts(id,username,salt,password_hash,snapshot,timezone) VALUES(?,?,?,?,?,?)").run(user.id, username, salt, passwordHash, JSON.stringify(snapshot), Intl.DateTimeFormat().resolvedOptions().timeZone);
      return user;
    });
  }
  async login(username: string, password: string): Promise<{ user: User; token: string }> {
    const account = this.db.prepare("SELECT id,username,salt,password_hash FROM accounts WHERE username=?").get(username) as Account | undefined;
    const salt = account?.salt ?? "00".repeat(32);
    const actual = await derive(password, salt);
    if (!account || !timingSafeEqual(actual, Buffer.from(account.password_hash, "hex")))
      throw new ApiError(401, "credentials", "Invalid username or password");
    // Recheck after async hashing so a concurrent administrator reset cannot issue an old-password session.
    return this.transaction(() => {
      const current = this.db.prepare("SELECT password_hash FROM accounts WHERE id=?").get(account.id) as { password_hash: string } | undefined;
      if (current?.password_hash !== account.password_hash) throw new ApiError(401, "credentials", "Invalid username or password");
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
      const token = randomBytes(32).toString("base64url");
      this.db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,kind) VALUES(?,?,?,'web')").run(hash(token), account.id, Date.now() + SESSION_MS);
      return { user: { id: account.id, username: account.username }, token };
    });
  }
  session(token: string): User {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(401, "auth", "Authentication required");
    const row = this.db.prepare("SELECT a.id,a.username FROM sessions s JOIN accounts a ON a.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.kind='web'").get(hash(token), Date.now()) as User | undefined;
    if (!row) throw new ApiError(401, "auth", "Authentication required");
    return row;
  }
  logout(token: string): void { this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(hash(token)); }
  workspace(userId: string): { snapshot: Snapshot; revision: number; timezone: string } {
    const row = this.db.prepare("SELECT snapshot,revision,timezone FROM accounts WHERE id=?").get(userId) as { snapshot: string; revision: number; timezone: string };
    return { snapshot: JSON.parse(row.snapshot) as Snapshot, revision: row.revision, timezone: row.timezone };
  }
  changes(userId: string): Change[] {
    return (this.db.prepare("SELECT body FROM changes WHERE user_id=? ORDER BY seq").all(userId) as { body: string }[]).map(row => JSON.parse(row.body) as Change);
  }
  commit(userId: string, input: unknown): { revision: number } {
    if (!record(input) || !Number.isSafeInteger(input.base_revision) || !Array.isArray(input.changes) || !(input.settings === null || record(input.settings))) invalid("Invalid commit");
    const changes = input.changes;
    if (changes.length > 20_000) throw new ApiError(413, "limit", "Too many changes in one transaction");
    return this.transaction(() => {
      const { snapshot, revision } = this.workspace(userId);
      if (input.base_revision !== revision) conflict();
      const ids = new Set<string>();
      let settingsChange: Change | undefined;
      for (const raw of changes) {
        if (!record(raw) || typeof raw.id !== "string" || !uuid.test(raw.id) || typeof raw.device_id !== "string" || !uuid.test(raw.device_id) || typeof raw.ts !== "number" || !Number.isFinite(raw.ts) || !["upsert", "delete"].includes(String(raw.op))) invalid("Invalid change metadata");
        if (ids.has(raw.id) || this.db.prepare("SELECT 1 FROM changes WHERE user_id=? AND id=?").get(userId, raw.id)) conflict();
        ids.add(raw.id);
        const change = raw as unknown as Change;
        if (change.table === "settings") {
          if (settingsChange || change.row_id !== "settings" || change.op !== "upsert") invalid("Invalid settings change");
          cloudSettings(change.before); cloudSettings(change.payload);
          if (!isDeepStrictEqual(change.before, snapshot.settings)) conflict();
          settingsChange = change;
          continue;
        }
        if (!tables.includes(change.table)) invalid("Unsupported table");
        if (typeof change.row_id !== "string" || !uuid.test(change.row_id) || !record(change.payload)) invalid("Invalid entity change");
        const rows: Entity[] = snapshot[change.table];
        const index = rows.findIndex(row => row.id === change.row_id);
        const current = rows[index];
        if (!isDeepStrictEqual(change.before, current ?? null)) conflict();
        const next = change.payload as unknown as Entity;
        if (next.id !== change.row_id || next.version !== (current?.version ?? 0) + 1 || !Number.isSafeInteger(next.version) || (change.op === "delete" ? typeof next.deleted_at !== "number" : next.deleted_at !== null)) invalid("Invalid entity version or deletion");
        if (index < 0) rows.push(next); else rows[index] = next;
      }
      if (input.settings !== null) {
        cloudSettings(input.settings);
        if (!settingsChange || !isDeepStrictEqual(settingsChange.payload, input.settings)) invalid("Settings require a matching change record");
        snapshot.settings = input.settings;
      } else if (settingsChange) invalid("Settings payload missing");
      try {
        validateSnapshot(snapshot);
        for (const event of snapshot.calendar_events)
          if (event.deleted_at === null) expandEvents([event], event.start_at, event.start_at + 86_400_000);
      } catch { invalid("Workspace failed domain validation"); }
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized) > WORKSPACE_BYTES) throw new ApiError(413, "limit", "Workspace exceeds 5 MiB limit");
      const bodies = changes.map(change => JSON.stringify(change));
      const bytes = bodies.reduce((n, body) => n + Buffer.byteLength(body) + 1, 0);
      const counts = this.db.prepare("SELECT log_bytes,log_count FROM accounts WHERE id=?").get(userId) as { log_bytes: number; log_count: number };
      if (counts.log_bytes + bytes > LOG_BYTES || counts.log_count + changes.length > LOG_ENTRIES) throw new ApiError(413, "limit", "Account history limit reached; export data and contact administrator");
      for (let i = 0; i < changes.length; i++) {
        const c = changes[i] as Change;
        this.db.prepare("INSERT INTO changes(user_id,id,ts,body) VALUES(?,?,?,?)").run(userId, c.id, c.ts, bodies[i]!);
      }
      const nextRevision = revision + (changes.length ? 1 : 0);
      this.db.prepare("UPDATE accounts SET snapshot=?,revision=?,log_bytes=log_bytes+?,log_count=log_count+? WHERE id=?").run(serialized, nextRevision, bytes, changes.length, userId);
      return { revision: nextRevision };
    });
  }
}
