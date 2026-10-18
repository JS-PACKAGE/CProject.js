import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Server } from "node:http";
import { v7 } from "uuid";
import { Store } from "../../server/store";
import { createServer } from "../../server/http";
import { configFromEnv } from "../../server/config";
import type { Change, Settings, Snapshot } from "../core/types";
import type { Repository } from "../data/repositories";
import { initialSnapshot } from "../data/entity";
import { makeChanges } from "../data/changeLog";
import { serverOrigin, SyncTransport } from "../data/transport";
import { RemoteRepository } from "./repository";

class DeviceRepository implements Repository {
  snapshot = initialSnapshot();
  async load(): Promise<Snapshot> { return structuredClone(this.snapshot); }
  async commit(_changes: Change[], settings: Settings | null): Promise<void> {
    if (settings) this.snapshot.settings = structuredClone(settings);
  }
  async changes(): Promise<Change[]> { return []; }
}
let directory: string;
let store: Store;
let server: Server;
let transport: SyncTransport;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cproject-repository-"));
  store = new Store(directory);
  server = createServer(configFromEnv({}), store);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  const origin = `http://127.0.0.1:${address.port}`;
  const fetchHTTP = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetchHTTP(input, { ...init, headers: { ...init?.headers, Origin: "http://localhost:8787" } }));
  transport = new SyncTransport(origin);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  if (server) {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    server.closeAllConnections();
    await promise;
  }
  store?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("remote repository boundaries", () => {
  it("shares language and week start while keeping notification sound local to each browser", async () => {
    const firstDevice = new DeviceRepository();
    firstDevice.snapshot.settings.notification_sound = false;
    const untouchedCalendars = structuredClone(firstDevice.snapshot.work_calendars);
    const first = new RemoteRepository(transport, firstDevice, () => {});
    const secondDevice = new DeviceRepository();
    const second = new RemoteRepository(transport, secondDevice, () => {});
    const before = await first.load();
    expect(before.settings.notification_sound).toBe(false);
    const next = structuredClone(before);
    next.settings.language = "ja";
    next.settings.week_start = 0;
    await first.commit(makeChanges(before, next, v7()), next.settings);
    const received = await second.load();
    expect(received.settings).toMatchObject({ language: "ja", week_start: 0, notification_sound: true });
    expect(firstDevice.snapshot.settings).toMatchObject({ notification_sound: false });
    expect(firstDevice.snapshot.work_calendars).toEqual(untouchedCalendars);
    const history = await first.changes();
    expect(history[0]!.before).toMatchObject({ language: "zh-TW", week_start: 1, notification_sound: false });
    expect(store.workspace().snapshot.settings).toMatchObject({ week_start: 0, notification_sound: true });
    const localOnly = structuredClone(next);
    localOnly.settings.notification_sound = true;
    await first.commit(makeChanges(next, localOnly, v7()), localOnly.settings);
    expect(store.workspace().revision).toBe(1);
    expect(firstDevice.snapshot.settings.notification_sound).toBe(true);
    expect((await first.load()).settings.week_start).toBe(0);
    expect((await second.load()).settings.week_start).toBe(0);
    expect(store.workspace().snapshot.settings.week_start).toBe(0);
  });
  it("rejects stale writes and disallows mutation from a different calendar time zone", async () => {
    const first = new RemoteRepository(transport, new DeviceRepository(), () => {});
    const second = new RemoteRepository(transport, new DeviceRepository(), () => {});
    const original = await first.load();
    const stale = await second.load();
    const next = structuredClone(original);
    next.work_calendars[0]!.name = "Updated elsewhere";
    await first.commit(makeChanges(original, next, v7()), null);
    const overwritten = structuredClone(stale);
    overwritten.work_calendars[0]!.name = "Old draft";
    await expect(second.commit(makeChanges(stale, overwritten, v7()), null)).rejects.toMatchObject({ status: 409 });
    expect(store.workspace().snapshot.work_calendars[0]!.name).toBe("Updated elsewhere");
    store.db.prepare("UPDATE workspace SET timezone=? WHERE id=1").run("Pacific/Kiritimati");
    let warning: string | null = null;
    const traveling = new RemoteRepository(transport, new DeviceRepository(), (value) => { warning = value; });
    const readable = await traveling.load();
    expect(traveling.refreshSchedules).toBe(false);
    expect(warning).toContain("Pacific/Kiritimati");
    const changed = structuredClone(readable);
    changed.work_calendars[0]!.name = "Wrong zone";
    await expect(traveling.commit(makeChanges(readable, changed, v7()), null)).rejects.toThrow("time zone");
    expect(store.workspace().revision).toBe(1);
  });
});

describe("server endpoint security", () => {
  it("rejects insecure remote endpoints and credential-bearing URLs", () => {
    for (const origin of ["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=secret", "file:///tmp/app", "http://localhost.evil.test"])
      expect(() => serverOrigin(origin)).toThrow();
    expect(serverOrigin("https://example.com/")).toBe("https://example.com");
    expect(serverOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
  });
});
