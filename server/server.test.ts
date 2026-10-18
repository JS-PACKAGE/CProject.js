// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
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
function post(path: string, data: unknown, token?: string, requestOrigin?: string) {
  return fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(data) });
}
async function login(username: string) {
  const response = await post("/api/login", { username, password, client: "desktop" });
  expect(response.status).toBe(200);
  const result = await response.json();
  if (!record(result) || typeof result.token !== "string") throw new Error("Missing session token");
  return result.token;
}
async function workspace(token: string): Promise<{ snapshot: Snapshot; revision: number; timezone: string }> {
  const response = await fetch(url + "/api/workspace", { headers: { Authorization: `Bearer ${token}` } });
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
    const log = await fetch(url + "/api/changes", { headers: { Authorization: `Bearer ${second}` } });
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
    const log = await fetch(url + "/api/changes", { headers: { Authorization: `Bearer ${alice}` } });
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
    expect((await post("/api/commit", { base_revision: 0, changes, settings: { ...next.settings, autostart: true } }, alice)).status).toBe(400);
    changes[0]!.before = { ...before.snapshot.settings, language: "ja" };
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings }, alice)).status).toBe(409);
    changes[0]!.before = before.snapshot.settings;
    expect((await post("/api/commit", { base_revision: 0, changes, settings: next.settings }, alice)).status).toBe(200);
  });
  it("acknowledges due reminders exactly once and rejects future or cross-account acknowledgements", async () => {
    const before = await workspace(alice);
    const next = structuredClone(before.snapshot);
    const now = Date.now();
    next.reminders.push({ ...entity(), entity_type: "custom", entity_id: v7(), trigger_at: now - 5000, message_key: "reminder.custom", params: {}, offset_minutes: 0, fired_at: null, snoozed_to: null });
    next.reminders.push({ ...next.reminders[0]!, id: v7(), trigger_at: now + 60_000 });
    next.reminders.push({ ...next.reminders[0]!, id: v7(), snoozed_to: now - 1000 });
    const changes = makeChanges(before.snapshot, next, device);
    expect((await post("/api/commit", { base_revision: 0, changes, settings: null }, alice)).status).toBe(200);
    const input = { id: next.reminders[0]!.id, version: 1, fired_at: now, device_id: device };
    expect((await post("/api/reminders/fired", input, bob)).status).toBe(409);
    expect((await post("/api/reminders/fired", { ...input, id: next.reminders[1]!.id }, alice)).status).toBe(409);
    expect((await post("/api/reminders/fired", { ...input, id: next.reminders[2]!.id }, alice)).status).toBe(409);
    expect((await post("/api/reminders/fired", input, alice)).status).toBe(200);
    expect((await post("/api/reminders/fired", input, alice)).status).toBe(409);
    expect((await workspace(alice)).snapshot.reminders[0]!.version).toBe(2);
  });
  it("protects browser login and writes by origin, hides bearer tokens and revokes sessions", async () => {
    expect((await post("/api/login", { username: "alice", password, client: "web" })).status).toBe(403);
    expect((await post("/api/login", { username: "alice", password, client: "desktop" }, undefined, origin)).status).toBe(403);
    const loginResponse = await post("/api/login", { username: "alice", password, client: "web" }, undefined, origin);
    expect(loginResponse.status).toBe(200);
    expect((await loginResponse.json()) as object).not.toHaveProperty("token");
    const setCookie = loginResponse.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly"); expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0]!;
    const headers = { Cookie: cookie, "Content-Type": "application/json" };
    expect((await fetch(url + "/api/logout", { method: "POST", headers, body: "{}" })).status).toBe(403);
    expect((await fetch(url + "/api/logout", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" })).status).toBe(403);
    expect((await fetch(url + "/api/logout", { method: "POST", headers: { ...headers, Origin: origin }, body: "{}" })).status).toBe(200);
    expect((await fetch(url + "/api/session", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await post("/api/logout", {}, alice)).status).toBe(200);
    expect((await fetch(url + "/api/session", { headers: { Authorization: `Bearer ${alice}` } })).status).toBe(401);
    await store.provision("bob", "a-new-safe-password", true);
    expect((await fetch(url + "/api/session", { headers: { Authorization: `Bearer ${bob}` } })).status).toBe(401);
  });
  it("does not apply an old tab's writes to the account now stored in its cookie", async () => {
    const oldUser = store.session(alice, "desktop");
    const otherLogin = await post("/api/login", { username: "bob", password, client: "web" }, undefined, origin);
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
    for (let i = 0; i < 10; i++) expect((await post("/api/login", { username: "missing", password: "wrong", client: "desktop" })).status).toBe(401);
    const limited = await post("/api/login", { username: "missing", password: "wrong", client: "desktop" });
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
    expect((await fetch(url + "/api/missing", { headers: { Authorization: `Bearer ${alice}` } })).status).toBe(404);
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
    expect(sessionRows.every(row => row.token_hash !== alice && row.token_hash !== bob)).toBe(true);
    expect(sessionRows.every(row => typeof row.token_hash === "string" && row.token_hash.length === 64)).toBe(true);
    const reopened = new Store(join(directory, "data"));
    try {
      const user = reopened.session(alice, "desktop");
      expect(reopened.workspace(user.id).snapshot.work_calendars[0]!.name).toBe("Persistent");
      expect(reopened.changes(user.id)).toEqual(changes);
      reopened.db.prepare("UPDATE accounts SET timezone=? WHERE id=?").run("Etc/GMT+3", user.id);
      expect(reopened.workspace(user.id).timezone).toBe("Etc/GMT+3");
    } finally { reopened.close(); }
    store.db.prepare("UPDATE sessions SET expires_at=0").run();
    expect((await fetch(url + "/api/session", { headers: { Authorization: `Bearer ${alice}` } })).status).toBe(401);
  });
  it("returns JSON validation and oversize failures", async () => {
    const invalid = await fetch(url + "/api/commit", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice}` }, body: "{" });
    expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ code: "validation" });
    const tooLarge = await post("/api/commit", { padding: "x".repeat(10 * 1024 * 1024) }, alice);
    expect(tooLarge.status).toBe(413); expect(await tooLarge.json()).toMatchObject({ code: "limit" });
  });
});
