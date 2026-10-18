// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { v7 } from "uuid";
import { createServer } from "./http";
import { record, Store } from "./store";
import { configFromEnv } from "./config";
import { makeChanges } from "../src/data/changeLog";
import { entity } from "../src/data/entity";
import type { Snapshot } from "../src/core/types";
import { validateSnapshot } from "../src/data/validation";

const origin = "http://localhost:8787";
const password = "correct-horse-test-password";
const device = v7();
let directory: string;
let store: Store;
let server: Server;
let url: string;
let alice: string;
let bob: string;
function post(path: string, data: unknown, cookie?: string, requestOrigin: string | null = origin) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(data) });
}
async function login(username: string) {
  const response = await post("/api/login", { username, password });
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result).toMatchObject({ user: { username } });
  expect(result).not.toHaveProperty("token");
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";")[0]!;
}
function token(cookie: string): string { return cookie.slice("cproject_session=".length); }
async function workspace(cookie: string): Promise<{ snapshot: Snapshot; revision: number; timezone: string }> {
  const response = await fetch(url + "/api/workspace", { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  const result = await response.json();
  if (!record(result) || typeof result.revision !== "number" || typeof result.timezone !== "string")
    throw new Error("Invalid workspace response");
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
  await store.provision("alice", password);
  await store.provision("bob", password);
  server = createServer({ ...configFromEnv({}), distDir: join(directory, "dist") }, store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP test address");
  url = `http://127.0.0.1:${address.port}`;
  alice = await login("alice");
  bob = await login("bob");
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

describe("standalone authenticated sync", () => {
  it("seeds accounts once, shares changes across two sessions, and isolates accounts", async () => {
    const second = await login("alice");
    const before = await workspace(alice);
    expect(before.revision).toBe(0);
    expect(before.timezone).toBeTypeOf("string");
    expect(before.snapshot.work_calendars).toHaveLength(1);
    expect(before.snapshot.weekday_rules).toHaveLength(7);
    const isolated = await workspace(bob);
    expect(isolated.snapshot.work_calendars[0]!.id).not.toBe(before.snapshot.work_calendars[0]!.id);
    const changes = rename(before.snapshot, "Shared calendar");
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, alice)).status).toBe(200);
    expect((await workspace(second)).snapshot.work_calendars[0]!.name).toBe("Shared calendar");
    expect(await workspace(bob)).toEqual(isolated);
    const log = await fetch(url + "/api/changes", { headers: { Cookie: second } });
    expect(await log.json()).toEqual(changes);
    expect((await fetch(url + "/api/workspace")).status).toBe(401);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, bob)).status).toBe(409);
    expect(await workspace(bob)).toEqual(isolated);
  });
  it("rejects stale and duplicate operations atomically and allows authenticated no-ops", async () => {
    const before = await workspace(alice);
    const changes = rename(before.snapshot, "First");
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, alice)).status).toBe(200);
    expect((await post("/api/commit", { base_revision: 0, changes: rename(before.snapshot, "Stale"), settings: null }, alice)).status).toBe(409);
    const latest = await workspace(alice);
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null }, alice)).status).toBe(409);
    const noop = await post("/api/commit", { base_revision: 1, changes: [], settings: null }, alice);
    expect(await noop.json()).toEqual({ revision: 1 });
    expect(await workspace(alice)).toEqual(latest);
    const invalid = rename(latest.snapshot, "Must roll back");
    invalid.push({ ...invalid[0]!, id: v7(), table: "unsupported" as never });
    expect((await post("/api/commit", { base_revision: 1, changes: invalid, settings: null }, alice)).status).toBe(400);
    expect(await workspace(alice)).toEqual(latest);
  });
  it("validates the complete deletion transaction and retains tombstones", async () => {
    const before = await workspace(alice);
    const next = structuredClone(before.snapshot);
    const now = Date.now();
    next.work_calendars[0]!.deleted_at = now;
    let changes = makeChanges(before.snapshot, next, device, now);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, alice)).status).toBe(400);
    expect(await workspace(alice)).toEqual(before);
    for (const rule of next.weekday_rules) rule.deleted_at = now;
    changes = makeChanges(before.snapshot, next, device, now);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, alice)).status).toBe(200);
    const after = await workspace(alice);
    expect(after.snapshot.work_calendars[0]!.deleted_at).toBe(now);
    expect(after.snapshot.weekday_rules.every(rule => rule.deleted_at === now)).toBe(true);
  });
  it("rejects invalid recurrence atomically and preserves commit order despite clock skew", async () => {
    const before = await workspace(alice);
    const next = structuredClone(before.snapshot);
    next.work_calendars[0]!.name = "Must not persist";
    next.calendar_events.push({ ...entity(), calendar_id: next.work_calendars[0]!.id, title: "Invalid rule", start_at: Date.now(), end_at: Date.now() + 1000, all_day: false, kind: "custom", rrule: "FREQ=INVALID", override: null });
    const invalidChanges = makeChanges(before.snapshot, next, device);
    expect((await post("/api/commit", { base_revision: 0, changes: invalidChanges, settings: null }, alice)).status).toBe(400);
    expect(await workspace(alice)).toEqual(before);
    const first = rename(before.snapshot, "First commit");
    first[0]!.ts = 2000;
    expect((await post("/api/commit", { base_revision: 0, changes: first, settings: null }, alice)).status).toBe(200);
    const latest = await workspace(alice);
    const second = rename(latest.snapshot, "Second commit");
    second[0]!.ts = 1000;
    expect((await post("/api/commit", { base_revision: 1, changes: second, settings: null }, alice)).status).toBe(200);
    const log = await fetch(url + "/api/changes", { headers: { Cookie: alice } });
    const history = await log.json();
    if (!Array.isArray(history)) throw new Error("Invalid change history");
    expect(history.map((change) => {
      if (!record(change) || typeof change.id !== "string") throw new Error("Invalid change identifier");
      return change.id;
    })).toEqual([first[0]!.id, second[0]!.id]);
  });
  it("enforces settings before-images and refuses cloud device flags", async () => {
    const before = await workspace(alice);
    const next = structuredClone(before.snapshot);
    next.settings.language = "en";
    const changes = makeChanges(before.snapshot, next, device);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: { ...next.settings, notification_sound: false } }, alice)).status).toBe(400);
    changes[0]!.before = { ...before.snapshot.settings, language: "ja" };
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings }, alice)).status).toBe(409);
    changes[0]!.before = before.snapshot.settings;
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings }, alice)).status).toBe(200);
  });
  it("records browser reminder delivery through ordinary revisioned commits", async () => {
    const before = await workspace(alice);
    const next = structuredClone(before.snapshot);
    const now = Date.now();
    next.reminders.push({ ...entity(), entity_type: "custom", entity_id: v7(), trigger_at: now - 5000, message_key: "reminder.custom", params: {}, offset_minutes: 0, fired_at: null, snoozed_to: null });
    expect((await post("/api/commit", { base_revision: 0, changes: makeChanges(before.snapshot, next, device), settings: null }, alice)).status).toBe(200);
    const pending = await workspace(alice);
    const delivered = structuredClone(pending.snapshot);
    delivered.reminders[0]!.fired_at = now;
    const changes = makeChanges(pending.snapshot, delivered, device);
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null }, bob)).status).toBe(409);
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null }, alice)).status).toBe(200);
    expect((await post("/api/commit", { base_revision: 1, changes, settings: null }, alice)).status).toBe(409);
    expect((await workspace(alice)).snapshot.reminders[0]).toMatchObject({ fired_at: now, version: 2 });
    expect((await post("/api/reminders/fired", {}, alice)).status).toBe(404);
  });
  it("protects cookie login and writes by origin, rejects bearer auth and revokes sessions", async () => {
    expect((await post("/api/login", { username: "alice", password }, undefined, null)).status).toBe(403);
    expect((await post("/api/login", { username: "alice", password }, undefined, "tauri://localhost")).status).toBe(403);
    expect((await post("/api/login", { username: "alice", password, client: "desktop" })).status).toBe(400);
    const loginResponse = await post("/api/login", { username: "alice", password });
    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.json()).toEqual({ user: store.session(token(alice)) });
    const setCookie = loginResponse.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";")[0]!;
    expect((await post("/api/logout", {}, cookie, null)).status).toBe(403);
    expect((await post("/api/logout", {}, cookie, "https://evil.example")).status).toBe(403);
    expect((await fetch(url + "/api/session", { headers: { Authorization: `Bearer ${token(cookie)}` } })).status).toBe(401);
    expect((await fetch(url + "/api/session", { headers: { Cookie: cookie, Authorization: `Bearer ${token(cookie)}` } })).status).toBe(401);
    const logout = await post("/api/logout", {}, cookie);
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await fetch(url + "/api/session", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await post("/api/logout", {}, alice)).status).toBe(200);
    expect((await fetch(url + "/api/session", { headers: { Cookie: alice } })).status).toBe(401);
    await store.provision("bob", "a-new-safe-password", true);
    expect((await fetch(url + "/api/session", { headers: { Cookie: bob } })).status).toBe(401);
  });
  it("does not apply an old tab's writes to the account now stored in its cookie", async () => {
    const oldUser = store.session(token(alice));
    const otherLogin = await post("/api/login", { username: "bob", password });
    const cookie = otherLogin.headers.get("set-cookie")!.split(";")[0]!;
    const headers = { Cookie: cookie, Origin: origin, "Content-Type": "application/json", "X-CProject-Account": oldUser.id };
    const isolated = await workspace(bob);
    const read = await fetch(url + "/api/workspace", { headers });
    expect(read.status).toBe(401);
    expect(await read.json()).toMatchObject({ code: "account_changed" });
    const write = await fetch(url + "/api/commit", {
      method: "POST", headers,
      body: JSON.stringify({ base_revision: isolated.revision, changes: rename(isolated.snapshot, "Stale tab write"), settings: null }),
    });
    expect(write.status).toBe(401);
    expect(await workspace(bob)).toEqual(isolated);
  });
  it("rate limits password guessing and does not expose auth errors", async () => {
    for (let i = 0; i < 10; i++) expect((await post("/api/login", { username: "missing", password: "wrong" })).status).toBe(401);
    const limited = await post("/api/login", { username: "missing", password: "wrong" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limit" });
  }, 15_000);
  it("serves SPA and assets securely without API fallback", async () => {
    const spa = await fetch(url + "/projects");
    expect(spa.status).toBe(200); expect(await spa.text()).toContain("Workspace");
    const asset = await fetch(url + "/app.js");
    expect(asset.headers.get("content-type")).toContain("javascript");
    expect(asset.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect((await fetch(url + "/missing.js")).status).toBe(404);
    expect((await fetch(url + "/api/missing", { headers: { Cookie: alice } })).status).toBe(404);
    const api = await fetch(url + "/api/info");
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(await api.json()).toEqual({ service: "cproject-sync", version: 1 });
    expect((await fetch(url + "/%2e%2e%2fsecret")).status).toBe(404);
    expect((await fetch(url + "/.env")).status).toBe(404);
  });
  it("persists account data and stores only expiring hashed session secrets", async () => {
    const before = await workspace(alice);
    const changes = rename(before.snapshot, "Persistent");
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, alice)).status).toBe(200);
    const sessionRows = store.db.prepare("SELECT token_hash,expires_at FROM sessions").all();
    expect(sessionRows.every(row => row.token_hash !== token(alice) && row.token_hash !== token(bob))).toBe(true);
    expect(sessionRows.every(row => typeof row.token_hash === "string" && row.token_hash.length === 64)).toBe(true);
    const reopened = new Store(join(directory, "data"));
    try {
      const user = reopened.session(token(alice));
      expect(reopened.workspace(user.id).snapshot.work_calendars[0]!.name).toBe("Persistent");
      expect(reopened.changes(user.id)).toEqual(changes);
      reopened.db.prepare("UPDATE accounts SET timezone=? WHERE id=?").run("Etc/GMT+3", user.id);
      expect(reopened.workspace(user.id).timezone).toBe("Etc/GMT+3");
    } finally { reopened.close(); }
    store.db.prepare("UPDATE sessions SET expires_at=0").run();
    expect((await fetch(url + "/api/session", { headers: { Cookie: alice } })).status).toBe(401);
  });
  it("migrates persisted settings and history without losing accounts, browser sessions or workspace data", async () => {
    const before = await workspace(alice);
    const next = structuredClone(before.snapshot);
    const now = Date.now();
    next.settings.language = "ja";
    next.projects.push({ ...entity(), name: "Keep project", calendar_id: next.work_calendars[0]!.id, duration_mode: "full_days", start_at: now, end_at: now + 86_400_000, status: "planned", color: "#123456", notes: "Keep notes", progress_manual: null });
    next.calendar_events.push({ ...entity(), calendar_id: next.work_calendars[0]!.id, title: "Keep event", start_at: now, end_at: now + 60_000, all_day: false, kind: "custom", rrule: null, override: null });
    const changes = makeChanges(before.snapshot, next, device);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings }, alice)).status).toBe(200);
    const persisted = await workspace(alice);
    const user = store.session(token(alice));
    const legacySettings = (settings: unknown) => ({ ...(settings as object), autostart: true, close_to_tray: false, notification_sound: false });
    store.db.prepare("UPDATE accounts SET snapshot=? WHERE id=?").run(JSON.stringify({ ...persisted.snapshot, settings: legacySettings(persisted.snapshot.settings) }), user.id);
    for (const change of changes) {
      if (change.table !== "settings") continue;
      store.db.prepare("UPDATE changes SET body=? WHERE user_id=? AND id=?").run(JSON.stringify({ ...change, before: legacySettings(change.before), payload: legacySettings(change.payload) }), user.id, change.id);
    }
    store.db.exec(`ALTER TABLE sessions RENAME TO old_sessions;
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('web','desktop')));
      INSERT INTO sessions SELECT * FROM old_sessions;
      DROP TABLE old_sessions;
      PRAGMA user_version=0;`);
    const nativeToken = "n".repeat(43);
    store.db.prepare("INSERT INTO sessions VALUES(?,?,?,'desktop')").run(createHash("sha256").update(nativeToken).digest("hex"), user.id, Date.now() + 60_000);
    const reopened = new Store(join(directory, "data"));
    try {
      expect(reopened.session(token(alice))).toEqual(user);
      expect(reopened.session(token(bob)).username).toBe("bob");
      expect(() => reopened.session(nativeToken)).toThrow("Authentication required");
      expect(reopened.workspace(user.id)).toEqual(persisted);
      expect(reopened.changes(user.id)).toEqual(changes);
      const counts = reopened.db.prepare("SELECT log_bytes,log_count FROM accounts WHERE id=?").get(user.id);
      expect(counts).toEqual({ log_bytes: changes.reduce((sum, change) => sum + Buffer.byteLength(JSON.stringify(change)) + 1, 0), log_count: changes.length });
      const storedAccount = reopened.db.prepare("SELECT snapshot FROM accounts WHERE id=?").get(user.id);
      expect(JSON.parse(String(storedAccount?.snapshot)).settings).toEqual(persisted.snapshot.settings);
      expect(reopened.db.prepare("SELECT kind FROM sessions WHERE kind <> 'web'").all()).toHaveLength(0);
      const settings = { ...persisted.snapshot.settings, language: "en" };
      const change = { id: v7(), table: "settings", row_id: "settings", op: "upsert", before: persisted.snapshot.settings, payload: settings, ts: now, device_id: device };
      expect(reopened.commit(user.id, { base_revision: persisted.revision, changes: [change], settings })).toEqual({ revision: persisted.revision + 1 });
    } finally { reopened.close(); }
    expect((await login("alice")).startsWith("cproject_session=")).toBe(true);
    const again = new Store(join(directory, "data"));
    try {
      expect(again.workspace(user.id).snapshot.projects).toEqual(persisted.snapshot.projects);
      expect(again.workspace(user.id).snapshot.calendar_events).toEqual(persisted.snapshot.calendar_events);
      expect(again.changes(user.id)).toHaveLength(changes.length + 1);
    } finally { again.close(); }
  });
  it("sets secure cookies for HTTPS hosting and provides no cross-origin API access", async () => {
    const secureOrigin = "https://projects.example";
    const httpsConfigured = createServer({ ...configFromEnv({ CPROJECT_PUBLIC_URL: secureOrigin }), distDir: join(directory, "dist") }, store);
    httpsConfigured.listen(0, "127.0.0.1");
    await once(httpsConfigured, "listening");
    try {
      const address = httpsConfigured.address();
      if (!address || typeof address === "string") throw new Error("Missing TCP test address");
      const endpoint = `http://127.0.0.1:${address.port}`;
      const response = await fetch(endpoint + "/api/login", { method: "POST", headers: { Origin: secureOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ username: "alice", password }) });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("; Secure");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      const rejected = await fetch(endpoint + "/api/workspace", { headers: { Cookie: alice, Origin: "https://evil.example" } });
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
      expect((await fetch(endpoint + "/api/commit", { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } })).status).toBe(403);
    } finally {
      const { promise, resolve } = Promise.withResolvers<void>();
      httpsConfigured.close(() => resolve());
      httpsConfigured.closeAllConnections();
      await promise;
    }
  });
  it("requires an HTTPS public origin except on loopback", () => {
    expect(configFromEnv({ CPROJECT_PUBLIC_URL: "https://projects.example" }).publicUrl).toBe("https://projects.example");
    expect(configFromEnv({ CPROJECT_PUBLIC_URL: "http://127.0.0.1:8787" }).publicUrl).toBe("http://127.0.0.1:8787");
    for (const invalid of ["http://projects.example", "tauri://localhost", "https://projects.example/path", "https://user:secret@projects.example", "https://projects.example?redirect=elsewhere"])
      expect(() => configFromEnv({ CPROJECT_PUBLIC_URL: invalid })).toThrow("CPROJECT_PUBLIC_URL");
  });
  it("returns JSON validation and oversize failures", async () => {
    const invalid = await fetch(url + "/api/commit", { method: "POST", headers: { "Content-Type": "application/json", Cookie: alice, Origin: origin }, body: "{" });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "validation" });
    const tooLarge = await post("/api/commit", { padding: "x".repeat(10 * 1024 * 1024) }, alice);
    expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toMatchObject({ code: "limit" });
  });
});
