import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Change, Entity, Settings, Snapshot } from "../src/core/types";
import { initialSnapshot, tables, webSettings } from "../src/data/entity";
import { validateSnapshot } from "../src/data/validation";
import { expandEvents } from "../src/core/calendar";

import { ApiError, conflict, invalid } from "./config";
export interface Workspace { snapshot: Snapshot; revision: number; timezone: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const WORKSPACE_BYTES = 5 * 1024 * 1024;
export const LOG_BYTES = 40 * 1024 * 1024;
const LOG_ENTRIES = 100_000;
export function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function cloudSettings(value: unknown): asserts value is Settings {
  if (!record(value) || value.notification_sound !== true || Object.keys(value).some(key => !["language", "notification_sound", "default_reminder_offsets"].includes(key)))
    invalid("Only shared web settings can be synchronized");
}
export class Store {
  readonly db: DatabaseSync;
  constructor(directory: string, legacyAccount?: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "sync.sqlite"));
    try {
      chmodSync(join(directory, "sync.sqlite"), 0o600);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;");
      this.migrate(legacyAccount);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void { this.db.close(); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private migrate(legacyAccount?: string): void {
    this.transaction(() => {
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version === 2) return;
      if (version.user_version > 2) throw new Error("Workspace database was created by a newer server");
      const legacy = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='accounts'").get();
      type LegacyAccount = { id: string; username: string; snapshot: string; timezone: string; revision: number; log_bytes: number; log_count: number };
      const accounts = legacy ? this.db.prepare("SELECT id,username,snapshot,timezone,revision,log_bytes,log_count FROM accounts ORDER BY username").all() as LegacyAccount[] : [];
      const selected = legacyAccount === undefined ? accounts.length === 1 ? accounts[0] : undefined : accounts.find(account => account.username === legacyAccount);
      if (legacyAccount !== undefined && !selected)
        throw new Error("CPROJECT_LEGACY_ACCOUNT does not name an existing legacy account; no workspace data was migrated");
      if (accounts.length > 1 && !selected)
        throw new Error("Multiple legacy accounts found. Set CPROJECT_LEGACY_ACCOUNT to the username whose workspace should become shared; all legacy workspaces and history will be archived");
      const normalize = (value: unknown): Settings => {
        if (!record(value) || typeof value.language !== "string" || !Array.isArray(value.default_reminder_offsets))
          throw new Error("Invalid persisted settings");
        return { ...webSettings(value as unknown as Settings), notification_sound: true };
      };
      const snapshot = selected ? JSON.parse(selected.snapshot) as Snapshot : initialSnapshot();
      snapshot.settings = normalize(snapshot.settings);
      validateSnapshot(snapshot);
      const history = selected ? this.db.prepare("SELECT seq,id,ts,body FROM changes WHERE user_id=? ORDER BY seq").all(selected.id) as { seq: number; id: string; ts: number; body: string }[] : [];
      for (const row of history) {
        const change = JSON.parse(row.body) as Change;
        if (change.table === "settings") {
          change.before = normalize(change.before);
          change.payload = normalize(change.payload);
          row.body = JSON.stringify(change);
        }
      }
      if (legacy) {
        // Archive exact original data, without retaining credentials or a live account path.
        this.db.exec(`CREATE TABLE archived_accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, snapshot TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL, log_bytes INTEGER NOT NULL, log_count INTEGER NOT NULL);
          INSERT INTO archived_accounts SELECT id,username,snapshot,timezone,revision,log_bytes,log_count FROM accounts;
          CREATE TABLE archived_changes(seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES archived_accounts(id), id TEXT NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL, UNIQUE(user_id,id));
          INSERT INTO archived_changes SELECT seq,user_id,id,ts,body FROM changes;
          DROP TABLE IF EXISTS sessions;
          DROP TABLE changes;
          DROP TABLE accounts;`);
      }
      this.db.exec(`CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL, log_bytes INTEGER NOT NULL, log_count INTEGER NOT NULL);
        CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL);`);
      this.db.prepare("INSERT INTO workspace VALUES(1,?,?,?,?,?)").run(JSON.stringify(snapshot), selected?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, selected?.revision ?? 0, history.reduce((sum, row) => sum + Buffer.byteLength(row.body) + 1, 0), history.length);
      const insert = this.db.prepare("INSERT INTO changes(seq,id,ts,body) VALUES(?,?,?,?)");
      for (const row of history) insert.run(row.seq, row.id, row.ts, row.body);
      this.db.exec("PRAGMA user_version=2");
    });
  }
  workspace(): Workspace {
    const row = this.db.prepare("SELECT snapshot,revision,timezone FROM workspace WHERE id=1").get() as { snapshot: string; revision: number; timezone: string };
    return { snapshot: JSON.parse(row.snapshot) as Snapshot, revision: row.revision, timezone: row.timezone };
  }
  changes(): Change[] {
    return (this.db.prepare("SELECT body FROM changes ORDER BY seq").all() as { body: string }[]).map(row => JSON.parse(row.body) as Change);
  }
  commit(input: unknown): { revision: number } {
    if (!record(input) || !Number.isSafeInteger(input.base_revision) || !Array.isArray(input.changes) || !(input.settings === null || record(input.settings))) invalid("Invalid commit");
    const changes = input.changes;
    if (changes.length > 20_000) throw new ApiError(413, "limit", "Too many changes in one transaction");
    return this.transaction(() => {
      const { snapshot, revision } = this.workspace();
      if (input.base_revision !== revision) conflict();
      const ids = new Set<string>();
      let settingsChange: Change | undefined;
      for (const raw of changes) {
        if (!record(raw) || typeof raw.id !== "string" || !uuid.test(raw.id) || typeof raw.device_id !== "string" || !uuid.test(raw.device_id) || typeof raw.ts !== "number" || !Number.isFinite(raw.ts) || !["upsert", "delete"].includes(String(raw.op))) invalid("Invalid change metadata");
        if (ids.has(raw.id) || this.db.prepare("SELECT 1 FROM changes WHERE id=?").get(raw.id)) conflict();
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
      const counts = this.db.prepare("SELECT log_bytes,log_count FROM workspace WHERE id=1").get() as { log_bytes: number; log_count: number };
      if (counts.log_bytes + bytes > LOG_BYTES || counts.log_count + changes.length > LOG_ENTRIES) throw new ApiError(413, "limit", "Workspace history limit reached; export data and contact administrator");
      for (let i = 0; i < changes.length; i++) {
        const c = changes[i] as Change;
        this.db.prepare("INSERT INTO changes(id,ts,body) VALUES(?,?,?)").run(c.id, c.ts, bodies[i]!);
      }
      const nextRevision = revision + (changes.length ? 1 : 0);
      this.db.prepare("UPDATE workspace SET snapshot=?,revision=?,log_bytes=log_bytes+?,log_count=log_count+? WHERE id=1").run(serialized, nextRevision, bytes, changes.length);
      return { revision: nextRevision };
    });
  }
}
