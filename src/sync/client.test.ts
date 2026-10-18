import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { initialSnapshot } from "../data/entity";
import type { Repository } from "../data/repositories";

const { appMock } = vi.hoisted(() => ({
  appMock: { setRepository: vi.fn(), load: vi.fn(), refresh: vi.fn() },
}));
vi.mock("../data/app", () => ({ app: appMock }));

let storage: Map<string, string>;
let fetchMock: Mock;
let openDatabase: Mock;
const info = () => Response.json({ service: "cproject-sync", version: 2 });
const workspace = () => Response.json({
  snapshot: initialSnapshot(), revision: 0, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
beforeEach(() => {
  // Each case exercises a fresh module-owned controller, as on a page reload.
  vi.resetModules();
  vi.clearAllMocks();
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  openDatabase = vi.fn(() => { throw new Error("Historical databases must remain untouched"); });
  vi.stubGlobal("indexedDB", { open: openDatabase, deleteDatabase: openDatabase });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    location: { origin: "https://workspace.example" }, setInterval: vi.fn(), clearInterval: vi.fn(),
  }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { hidden: false }));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  let repository: Repository;
  appMock.setRepository.mockImplementation(async (next: Repository) => { repository = next; });
  appMock.load.mockImplementation(() => repository.load());
  appMock.refresh.mockImplementation(() => repository.load());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("shared workspace connection", () => {
  it("opens the shared workspace without signing in or touching IndexedDB", async () => {
    fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(workspace());
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ phase: "ready", busy: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/info", "https://workspace.example/api/workspace",
    ]);
    expect(openDatabase).not.toHaveBeenCalled();
  });
  it("retries initial discovery failure without opening local data", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState().phase).toBe("offline");
    expect(appMock.load).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(workspace());
    await sync.refresh();
    expect(sync.getState().phase).toBe("ready");
    expect(openDatabase).not.toHaveBeenCalled();
  });
  it("recovers a failed initial workspace load", async () => {
    fetchMock.mockResolvedValueOnce(info()).mockRejectedValueOnce(new TypeError("offline"));
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState().phase).toBe("offline");
    fetchMock.mockResolvedValueOnce(workspace());
    await sync.refresh();
    expect(sync.getState().phase).toBe("ready");
  });
  it.each([
    ["HTML", () => new Response("<!doctype html>")],
    ["404", () => new Response("Not found", { status: 404 })],
    ["unrelated JSON", () => Response.json({ service: "another-service" })],
    ["null JSON", () => Response.json(null)],
    ["malformed JSON", () => new Response("{", { headers: { "Content-Type": "application/json" } })],
  ])("never opens a local workspace for %s, even on a first visit", async (_label, response) => {
    fetchMock.mockResolvedValueOnce(response());
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ phase: "offline", busy: false });
    expect(sync.getState().error).toBeTruthy();
    expect(appMock.setRepository).not.toHaveBeenCalled();
    expect(appMock.load).not.toHaveBeenCalled();
    expect(appMock.refresh).not.toHaveBeenCalled();
    expect(openDatabase).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(workspace());
    await sync.refresh();
    expect(sync.getState().phase).toBe("ready");
  });
  it("refuses the obsolete account protocol", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ service: "cproject-sync", version: 1 }));
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ phase: "offline" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(appMock.setRepository).not.toHaveBeenCalled();
  });
});
