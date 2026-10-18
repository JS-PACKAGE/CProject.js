// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { Server } from "node:http";
import { v7 } from "uuid";
import { createServer } from "./http";
import { record, Store, LOG_BYTES, WORKSPACE_BYTES, type Workspace } from "./store";
import { configFromEnv } from "./config";
import { makeChanges } from "../src/data/changeLog";
import { entity, initialSnapshot } from "../src/data/entity";
import type { Change, Snapshot } from "../src/core/types";
import { validateSnapshot } from "../src/data/validation";

const origin = "http://localhost:8787";
const device = v7();
let directory: string;
let store: Store;
let server: Server;
let url: string;
function post(path: string, data: unknown, requestOrigin: string | null = origin) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(data) });
}
async function workspace(): Promise<Workspace> {
  const response = await fetch(url + "/api/workspace");
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
  const result = await response.json();
  if (!record(result) || typeof result.revision !== "number" || typeof result.timezone !== "string") throw new Error("Invalid workspace response");
  validateSnapshot(result.snapshot);
  return { snapshot: result.snapshot, revision: result.revision, timezone: result.timezone };
}
function rename(before: Snapshot, name: string) {
  const next = structuredClone(before);
  next.work_calendars[0]!.name = name;
  return makeChanges(before, next, device);
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cproject-server-test-"));
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "dist", "index.html"), "<!doctype html><title>Workspace</title>");
  await writeFile(join(directory, "dist", "app.js"), "console.log('asset')");
  store = new Store(join(directory, "data"));
  server = createServer({ ...configFromEnv({}), distDir: join(directory, "dist") }, store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP test address");
  url = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  if (server) {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    server.closeAllConnections();
    await promise;
  }
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("standalone shared sync", () => {
  it("seeds one anonymous workspace and persists shared ordered history", async () => {
    const before = await workspace();
    expect(before.revision).toBe(0);
    expect(before.snapshot.work_calendars).toHaveLength(1);
    expect(before.snapshot.weekday_rules).toHaveLength(7);
    const first = rename(before.snapshot, "Shared calendar");
    first[0]!.ts = 2000;
    expect((await post("/api/commit", { base_revision: 0, changes: first, settings: null })).status).toBe(200);
    const latest = await workspace();
    const second = rename(latest.snapshot, "Persistent");
    second[0]!.ts = 1000;
    expect((await post("/api/commit", { base_revision: 1, changes: second, settings: null })).status).toBe(200);
    expect(await (await fetch(url + "/api/changes")).json()).toEqual([...first, ...second]);
    const reopened = new Store(join(directory, "data"));
    try {
      expect(reopened.workspace().snapshot.work_calendars[0]!.name).toBe("Persistent");
      expect(reopened.workspace().revision).toBe(2);
      expect(reopened.changes()).toEqual([...first, ...second]);
      expect(reopened.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('accounts','sessions')").all()).toEqual([]);
    } finally { reopened.close(); }
  });
  it("rejects stale, duplicate and partially invalid operations atomically and allows no-ops", async () => {
    const before = await workspace();
    const changes = rename(before.snapshot, "First");
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null })).status).toBe(200);
    expect((await post("/api/commit", { base_revision: 0, changes: rename(before.snapshot, "Stale"), settings: null })).status).toBe(409);
    const latest = await workspace();
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null })).status).toBe(409);
    expect(await (await post("/api/commit", { base_revision: 1, changes: [], settings: null })).json()).toEqual({ revision: 1 });
    const invalid = rename(latest.snapshot, "Must roll back");
    invalid.push({ ...invalid[0]!, id: v7(), table: "unsupported" as never });
    expect((await post("/api/commit", { base_revision: 1, changes: invalid, settings: null })).status).toBe(400);
    expect(await workspace()).toEqual(latest);
    expect(store.changes()).toEqual(changes);
  });
  it("validates complete deletion transactions and retains tombstones", async () => {
    const before = await workspace();
    const next = structuredClone(before.snapshot);
    const now = Date.now();
    next.work_calendars[0]!.deleted_at = now;
    expect((await post("/api/commit", { base_revision: 0, changes: makeChanges(before.snapshot, next, device, now), settings: null })).status).toBe(400);
    expect(await workspace()).toEqual(before);
    for (const rule of next.weekday_rules) rule.deleted_at = now;
    expect((await post("/api/commit", { base_revision: 0, changes: makeChanges(before.snapshot, next, device, now), settings: null })).status).toBe(200);
    const after = await workspace();
    expect(after.snapshot.work_calendars[0]!.deleted_at).toBe(now);
    expect(after.snapshot.weekday_rules.every(rule => rule.deleted_at === now)).toBe(true);
  });
  it("rejects invalid recurrence atomically", async () => {
    const before = await workspace();
    const next = structuredClone(before.snapshot);
    next.work_calendars[0]!.name = "Must not persist";
    next.calendar_events.push({ ...entity(), calendar_id: next.work_calendars[0]!.id, title: "Invalid rule", start_at: Date.now(), end_at: Date.now() + 1000, all_day: false, kind: "custom", rrule: "FREQ=INVALID", override: null });
    expect((await post("/api/commit", { base_revision: 0, changes: makeChanges(before.snapshot, next, device), settings: null })).status).toBe(400);
    expect(await workspace()).toEqual(before);
  });
  it("enforces settings before-images and refuses device flags", async () => {
    const before = await workspace();
    const next = structuredClone(before.snapshot);
    next.settings.language = "en";
    const changes = makeChanges(before.snapshot, next, device);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: { ...next.settings, notification_sound: false } })).status).toBe(400);
    changes[0]!.before = { ...before.snapshot.settings, language: "ja" };
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings })).status).toBe(409);
    changes[0]!.before = before.snapshot.settings;
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings })).status).toBe(200);
  });
  it("rejects missing or invalid week starts without erasing shared preferences", async () => {
    const before = await workspace();
    const sunday = structuredClone(before.snapshot);
    sunday.settings.week_start = 0;
    expect((await post("/api/commit", { base_revision: 0, changes: makeChanges(before.snapshot, sunday, device), settings: sunday.settings })).status).toBe(200);
    const persisted = await workspace();
    for (const value of [undefined, null, -1, 7, 1.5, "1", true]) {
      const settings = { ...sunday.settings, language: "en", week_start: value };
      const change = { id: v7(), device_id: device, ts: Date.now(), table: "settings", row_id: "settings", op: "upsert", before: sunday.settings, payload: settings };
      expect((await post("/api/commit", { base_revision: 1, changes: [change], settings })).status).toBe(400);
      expect(await workspace()).toEqual(persisted);
      const validSettings = { ...sunday.settings, language: "en" };
      expect((await post("/api/commit", { base_revision: 1, changes: [{ ...change, before: settings, payload: validSettings }], settings: validSettings })).status).toBe(400);
      expect(await workspace()).toEqual(persisted);
    }
  });
  it("records reminder delivery through revisioned commits", async () => {
    const before = await workspace();
    const next = structuredClone(before.snapshot);
    const now = Date.now();
    next.reminders.push({ ...entity(), entity_type: "custom", entity_id: v7(), trigger_at: now - 5000, message_key: "reminder.custom", params: {}, offset_minutes: 0, fired_at: null, snoozed_to: null });
    expect((await post("/api/commit", { base_revision: 0, changes: makeChanges(before.snapshot, next, device), settings: null })).status).toBe(200);
    const pending = await workspace();
    const delivered = structuredClone(pending.snapshot);
    delivered.reminders[0]!.fired_at = now;
    const changes = makeChanges(pending.snapshot, delivered, device);
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null })).status).toBe(200);
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null })).status).toBe(409);
    expect((await workspace()).snapshot.reminders[0]).toMatchObject({ fired_at: now, version: 2 });
    expect((await post("/api/reminders/fired", {})).status).toBe(404);
  });
  it("removes account endpoints and rejects legacy clients", async () => {
    expect((await fetch(url + "/api/session")).status).toBe(404);
    for (const path of ["/api/login", "/api/logout"]) expect((await post(path, {})).status).toBe(404);
    const before = await workspace();
    const headers = { Origin: origin, "Content-Type": "application/json", "X-CProject-Account": "legacy" };
    for (const path of ["/api/info", "/api/workspace", "/api/changes"]) {
      const response = await fetch(url + path, { headers });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "protocol_changed" });
    }
    expect((await fetch(url + "/api/commit", { method: "POST", headers, body: JSON.stringify({ base_revision: 0, changes: rename(before.snapshot, "Old tab"), settings: null }) })).status).toBe(409);
    expect(await workspace()).toEqual(before);
  });
  it("serves SPA and assets securely without API fallback", async () => {
    const spa = await fetch(url + "/projects");
    expect(spa.status).toBe(200); expect(await spa.text()).toContain("Workspace");
    const asset = await fetch(url + "/app.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    for (const path of ["/missing.js", "/api/missing", "/%2e%2e%2fsecret", "/.env"]) expect((await fetch(url + path)).status).toBe(404);
    const api = await fetch(url + "/api/info");
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(await api.json()).toEqual({ service: "cproject-sync", version: 2 });
  });
  it("enforces workspace and history quotas atomically", () => {
    const before = store.workspace();
    const changes = rename(before.snapshot, "x".repeat(WORKSPACE_BYTES));
    expect(() => store.commit({ base_revision: 0, changes, settings: null })).toThrow();
    expect(store.workspace()).toEqual(before);
    store.db.prepare("UPDATE workspace SET log_bytes=? WHERE id=1").run(LOG_BYTES);
    expect(() => store.commit({ base_revision: 0, changes: rename(before.snapshot, "Over quota"), settings: null })).toThrow("history limit");
    expect(store.workspace()).toEqual(before);
    expect(store.changes()).toEqual([]);
  });
  it.each(["https://cpj.yustellar.dev", "null", null])("persists events without restricting the request origin (%s)", async requestOrigin => {
    const headers = requestOrigin ? { Origin: requestOrigin } : undefined;
    const response = await fetch(url + "/api/workspace", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const before = await workspace();
    const next = structuredClone(before.snapshot);
    const event = { ...entity(), calendar_id: next.work_calendars[0]!.id, title: "Saved event", start_at: Date.UTC(2026, 9, 18, 2), end_at: Date.UTC(2026, 9, 18, 3), all_day: false, kind: "meeting" as const, rrule: null, override: null };
    next.calendar_events.push(event);
    const saved = await post("/api/commit", { base_revision: before.revision, changes: makeChanges(before.snapshot, next, device), settings: null }, requestOrigin);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("set-cookie")).toBeNull();
    expect(saved.headers.get("access-control-allow-origin")).toBeNull();
    const persisted = await workspace();
    expect(persisted.revision).toBe(before.revision + 1);
    expect(persisted.snapshot.calendar_events).toEqual([expect.objectContaining(event)]);
  });
  it("does not enable cross-origin browser preflights", async () => {
    const response = await fetch(url + "/api/commit", { method: "OPTIONS", headers: { Origin: "https://other.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("returns JSON validation and oversize failures", async () => {
    const invalid = await fetch(url + "/api/commit", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: "{" });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "validation" });
    const tooLarge = await post("/api/commit", { padding: "x".repeat(10 * 1024 * 1024) });
    expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toMatchObject({ code: "limit" });
  });
});

type Legacy = { id: string; username: string; snapshot: Snapshot; changes: Change[] };
async function legacyDatabase(names: string[], version = 0): Promise<{ path: string; accounts: Legacy[] }> {
  const path = join(directory, "legacy");
  await mkdir(path);
  const db = new DatabaseSync(join(path, "sync.sqlite"));
  const accounts: Legacy[] = [];
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE accounts(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, snapshot TEXT NOT NULL, timezone TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, log_bytes INTEGER NOT NULL DEFAULT 0, log_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, kind TEXT NOT NULL);
      CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL, ts REAL NOT NULL, body TEXT NOT NULL, UNIQUE(user_id,id));
      CREATE INDEX changes_account ON changes(user_id,seq); PRAGMA user_version=${version};`);
    for (const username of names) {
      const initial = initialSnapshot();
      const snapshot = structuredClone(initial);
      snapshot.work_calendars[0]!.name = username;
      snapshot.settings.language = "ja";
      const changes = makeChanges(initial, snapshot, device);
      changes.forEach((change, i) => { change.ts = 2000 - i * 1000; });
      const id = v7();
      const legacySettings = (settings: unknown) => {
        const { week_start: _weekStart, ...rest } = settings as Record<string, unknown>;
        return { ...rest, autostart: true, close_to_tray: false, notification_sound: false };
      };
      const rawSnapshot = JSON.stringify({ ...snapshot, settings: legacySettings(snapshot.settings) });
      const bodies = changes.map(change => JSON.stringify(change.table === "settings" ? { ...change, before: legacySettings(change.before), payload: legacySettings(change.payload) } : change));
      db.prepare("INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?,?)").run(id, username, "obsolete-salt", "obsolete-hash", rawSnapshot, "Etc/GMT+3", 7, bodies.reduce((sum, body) => sum + Buffer.byteLength(body) + 1, 0), bodies.length);
      db.prepare("INSERT INTO sessions VALUES(?,?,?,'web')").run(`session-${id}`, id, Date.now() + 60_000);
      for (let i = 0; i < changes.length; i++) db.prepare("INSERT INTO changes(user_id,id,ts,body) VALUES(?,?,?,?)").run(id, changes[i]!.id, changes[i]!.ts, bodies[i]!);
      accounts.push({ id, username, snapshot, changes });
    }
  } finally { db.close(); }
  return { path, accounts };
}
function logicalDatabase(path: string) {
  const db = new DatabaseSync(join(path, "sync.sqlite"));
  try {
    return { schema: db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), version: db.prepare("PRAGMA user_version").get(), accounts: db.prepare("SELECT * FROM accounts ORDER BY username").all(), changes: db.prepare("SELECT * FROM changes ORDER BY seq").all(), sessions: db.prepare("SELECT * FROM sessions ORDER BY token_hash").all() };
  } finally { db.close(); }
}
describe("shared workspace migration", () => {
  it("creates new databases at schema 3 with Monday as the default", () => {
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    expect(store.workspace().snapshot.settings.week_start).toBe(1);
  });
  it.each([undefined, 0])("upgrades schema 2 settings and history without changing archives (week start %s)", async weekStart => {
    const { path } = await legacyDatabase(["alice"]);
    const seeded = new Store(path);
    const legacySettings = (value: unknown) => {
      const { week_start: _weekStart, ...rest } = value as Record<string, unknown>;
      return weekStart === undefined ? rest : { ...rest, week_start: weekStart };
    };
    const legacySnapshot = seeded.workspace().snapshot;
    const rawSnapshot = JSON.stringify({ ...legacySnapshot, settings: legacySettings(legacySnapshot.settings) });
    const rows = seeded.db.prepare("SELECT seq,id,ts,body FROM changes ORDER BY seq").all();
    for (const row of rows) {
      const change = JSON.parse(row.body as string) as Change;
      if (change.table === "settings") {
        seeded.db.prepare("UPDATE changes SET body=? WHERE seq=?").run(JSON.stringify({ ...change, before: legacySettings(change.before), payload: legacySettings(change.payload) }), row.seq!);
      }
    }
    seeded.db.prepare("UPDATE workspace SET snapshot=?,log_bytes=0,log_count=0").run(rawSnapshot);
    seeded.db.exec("PRAGMA user_version=2");
    const archives = {
      accounts: seeded.db.prepare("SELECT * FROM archived_accounts ORDER BY username").all(),
      changes: seeded.db.prepare("SELECT * FROM archived_changes ORDER BY seq").all(),
    };
    const ordered = seeded.db.prepare("SELECT seq,id,ts FROM changes ORDER BY seq").all();
    seeded.close();
    const migrated = new Store(path);
    let updated: Workspace;
    let history: Change[];
    try {
      expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      expect(migrated.workspace()).toEqual({ snapshot: { ...legacySnapshot, settings: { ...legacySnapshot.settings, week_start: weekStart ?? 1 } }, revision: 7, timezone: "Etc/GMT+3" });
      const changes = migrated.changes();
      for (const change of changes.filter(change => change.table === "settings")) {
        expect(change.before).toMatchObject({ week_start: weekStart ?? 1 });
        expect(change.payload).toMatchObject({ week_start: weekStart ?? 1 });
      }
      expect(migrated.db.prepare("SELECT seq,id,ts FROM changes ORDER BY seq").all()).toEqual(ordered);
      expect(migrated.db.prepare("SELECT log_bytes,log_count FROM workspace").get()).toEqual({ log_bytes: changes.reduce((sum, change) => sum + Buffer.byteLength(JSON.stringify(change)) + 1, 0), log_count: changes.length });
      const before = migrated.workspace().snapshot;
      const next = structuredClone(before);
      next.settings.week_start = weekStart === 0 ? 1 : 0;
      expect(migrated.commit({ base_revision: 7, changes: makeChanges(before, next, device), settings: next.settings })).toEqual({ revision: 8 });
      updated = migrated.workspace();
      history = migrated.changes();
    } finally { migrated.close(); }
    const reopened = new Store(path);
    try {
      expect(reopened.workspace()).toEqual(updated!);
      expect(reopened.changes()).toEqual(history!);
      expect(reopened.db.prepare("SELECT * FROM archived_accounts ORDER BY username").all()).toEqual(archives.accounts);
      expect(reopened.db.prepare("SELECT * FROM archived_changes ORDER BY seq").all()).toEqual(archives.changes);
    } finally { reopened.close(); }
  });
  it.each([null, -1, 7, 1.5, "1", true])("rolls back schema 2 migration for invalid present week start %s", async value => {
    const { path } = await legacyDatabase(["alice"]);
    const seeded = new Store(path);
    const snapshot = seeded.workspace().snapshot;
    const validSnapshot = JSON.stringify(snapshot);
    const originalHistory = seeded.db.prepare("SELECT * FROM changes ORDER BY seq").all();
    const originalArchives = seeded.db.prepare("SELECT * FROM archived_accounts ORDER BY username").all();
    seeded.db.exec("PRAGMA user_version=2");
    for (const target of ["snapshot", "before", "payload"]) {
      const rawSnapshot = target === "snapshot" ? JSON.stringify({ ...snapshot, settings: { ...snapshot.settings, week_start: value } }) : validSnapshot;
      seeded.db.prepare("UPDATE workspace SET snapshot=?").run(rawSnapshot);
      if (target !== "snapshot") {
        const row = originalHistory.find(row => (JSON.parse(row.body as string) as Change).table === "settings")!;
        const change = JSON.parse(row.body as string) as Change;
        seeded.db.prepare("UPDATE changes SET body=? WHERE seq=?").run(JSON.stringify({ ...change, [target]: { ...(change[target as "before" | "payload"] as object), week_start: value } }), row.seq!);
      }
      const history = seeded.db.prepare("SELECT * FROM changes ORDER BY seq").all();
      expect(() => new Store(path)).toThrow("Invalid persisted settings");
      expect(seeded.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
      expect(seeded.db.prepare("SELECT snapshot FROM workspace").get()?.snapshot).toBe(rawSnapshot);
      expect(seeded.db.prepare("SELECT * FROM changes ORDER BY seq").all()).toEqual(history);
      expect(seeded.db.prepare("SELECT * FROM archived_accounts ORDER BY username").all()).toEqual(originalArchives);
      for (const row of originalHistory) seeded.db.prepare("UPDATE changes SET body=? WHERE seq=?").run(row.body!, row.seq!);
    }
    seeded.close();
  });
  it("seeds an empty legacy database without inventing an account", async () => {
    const { path } = await legacyDatabase([]);
    const migrated = new Store(path);
    try {
      expect(migrated.workspace().revision).toBe(0);
      expect(migrated.workspace().snapshot.work_calendars).toHaveLength(1);
      expect(migrated.changes()).toEqual([]);
      expect(migrated.db.prepare("SELECT * FROM archived_accounts").all()).toEqual([]);
    } finally { migrated.close(); }
  });
  it("automatically migrates one account and normalizes live settings/history only", async () => {
    const { path, accounts } = await legacyDatabase(["alice"]);
    const original = logicalDatabase(path);
    const migrated = new Store(path);
    try {
      expect(migrated.workspace()).toEqual({ snapshot: accounts[0]!.snapshot, revision: 7, timezone: "Etc/GMT+3" });
      expect(migrated.changes()).toEqual(accounts[0]!.changes);
      expect(migrated.db.prepare("SELECT * FROM archived_changes ORDER BY seq").all()).toEqual(original.changes);
      expect(migrated.db.prepare("SELECT snapshot FROM archived_accounts").get()?.snapshot).toBe(original.accounts[0]!.snapshot);
      expect(migrated.db.prepare("SELECT log_bytes,log_count FROM workspace").get()).toEqual({ log_bytes: accounts[0]!.changes.reduce((sum, change) => sum + Buffer.byteLength(JSON.stringify(change)) + 1, 0), log_count: accounts[0]!.changes.length });
      expect(migrated.db.prepare("SELECT name FROM sqlite_master WHERE name IN ('accounts','sessions')").all()).toEqual([]);
      const columns = migrated.db.prepare("PRAGMA table_info(archived_accounts)").all().map(row => row.name);
      expect(columns).not.toContain("salt"); expect(columns).not.toContain("password_hash");
    } finally { migrated.close(); }
  });
  it("refuses ambiguous or invalid selection without modifying legacy data or schema", async () => {
    const { path } = await legacyDatabase(["alice", "bob"], 1);
    const original = logicalDatabase(path);
    expect(() => new Store(path)).toThrow("CPROJECT_LEGACY_ACCOUNT");
    expect(logicalDatabase(path)).toEqual(original);
    expect(() => new Store(path, "missing")).toThrow("does not name an existing legacy account");
    expect(logicalDatabase(path)).toEqual(original);
    // A successful open immediately afterwards also guards constructor-failure lock leaks.
    const migrated = new Store(path, "alice");
    migrated.close();
  });
  it("archives every account, selects explicitly, and never reruns migration on reopen", async () => {
    const { path, accounts } = await legacyDatabase(["alice", "bob"], 1);
    const original = logicalDatabase(path);
    const migrated = new Store(path, "bob");
    let updated: Workspace;
    try {
      expect(migrated.workspace()).toEqual({ snapshot: accounts[1]!.snapshot, revision: 7, timezone: "Etc/GMT+3" });
      expect(migrated.changes()).toEqual(accounts[1]!.changes);
      expect(migrated.db.prepare("SELECT * FROM archived_changes ORDER BY seq").all()).toEqual(original.changes);
      const archived = migrated.db.prepare("SELECT * FROM archived_accounts ORDER BY username").all();
      expect(archived).toEqual(original.accounts.map(({ salt: _salt, password_hash: _hash, ...account }) => account));
      const changes = rename(migrated.workspace().snapshot, "Updated shared workspace");
      expect(migrated.commit({ base_revision: 7, changes, settings: null })).toEqual({ revision: 8 });
      updated = migrated.workspace();
    } finally { migrated.close(); }
    const reopened = new Store(path, "missing");
    try {
      expect(reopened.workspace()).toEqual(updated!);
      expect(reopened.changes()).toHaveLength(accounts[1]!.changes.length + 1);
      expect(reopened.db.prepare("SELECT * FROM archived_changes ORDER BY seq").all()).toEqual(original.changes);
    } finally { reopened.close(); }
  });
  it("rolls back malformed selected settings and keeps all legacy data", async () => {
    const { path } = await legacyDatabase(["alice"]);
    const db = new DatabaseSync(join(path, "sync.sqlite"));
    db.prepare("UPDATE accounts SET snapshot=?").run(JSON.stringify({ ...initialSnapshot(), settings: {} }));
    db.close();
    const original = logicalDatabase(path);
    expect(() => new Store(path)).toThrow("Invalid persisted settings");
    expect(logicalDatabase(path)).toEqual(original);
  });
  it.each([null, -1, 7, 1.5, "1", true])("rejects invalid legacy account week start %s without archiving or changing data", async value => {
    const { path } = await legacyDatabase(["alice"], 1);
    const db = new DatabaseSync(join(path, "sync.sqlite"));
    const row = db.prepare("SELECT snapshot FROM accounts").get()!;
    const snapshot = JSON.parse(row.snapshot as string) as Snapshot;
    db.prepare("UPDATE accounts SET snapshot=?").run(JSON.stringify({ ...snapshot, settings: { ...snapshot.settings, week_start: value } }));
    db.close();
    const original = logicalDatabase(path);
    expect(() => new Store(path)).toThrow("Invalid persisted settings");
    expect(logicalDatabase(path)).toEqual(original);
  });
});
