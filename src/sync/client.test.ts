import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { initialSnapshot } from "../data/entity";
import type { Repository } from "../data/repositories";

const { appMock, localMock } = vi.hoisted(() => ({
  appMock: {
    setRepository: vi.fn(), load: vi.fn(), refresh: vi.fn(), exportJSON: vi.fn(), importJSON: vi.fn(),
  },
  localMock: { load: vi.fn(), commit: vi.fn(), changes: vi.fn() },
}));
vi.mock("../data/app", () => ({ app: appMock, localRepository: localMock }));

let storage: Map<string, string>;
let fetchMock: Mock;
const info = () => Response.json({ service: "cproject-sync", version: 2 });
const workspace = (revision = 0) => Response.json({
  snapshot: initialSnapshot(), revision, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  localMock.load.mockImplementation(async () => initialSnapshot());
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("shared workspace connection", () => {
  it.each([false, true])("opens the shared workspace without signing in (returning: %s)", async (returning) => {
    if (returning) storage.set("cproject-hosted-sync", "true");
    fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(workspace());
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ mode: "server", phase: "ready", hosted: true, busy: false });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/info", "https://workspace.example/api/workspace",
    ]);
    expect(storage.get("cproject-hosted-sync")).toBe("true");
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
  it("preserves standalone local mode when no hosted API exists", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<!doctype html>"));
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ mode: "local", phase: "ready", hosted: false });
    expect(appMock.setRepository).not.toHaveBeenCalled();
  });
  it("never falls back to local data after a hosted workspace was detected", async () => {
    storage.set("cproject-hosted-sync", "true");
    fetchMock.mockResolvedValueOnce(new Response("Not found", { status: 404 }));
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ mode: "server", phase: "offline" });
    expect(appMock.setRepository).not.toHaveBeenCalled();
  });
  it("refuses the obsolete account protocol", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ service: "cproject-sync", version: 1 }));
    const { sync } = await import("./client");
    await sync.initialize();
    expect(sync.getState()).toMatchObject({ mode: "server", phase: "offline" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retains the revision-zero guard for local uploads", async () => {
    fetchMock.mockResolvedValueOnce(info()).mockResolvedValueOnce(workspace(1));
    const { sync } = await import("./client");
    await sync.initialize();
    appMock.exportJSON.mockResolvedValueOnce(JSON.stringify({ snapshot: initialSnapshot() }));
    await expect(sync.uploadLocal()).rejects.toThrow("new, unused shared workspace");
    expect(appMock.importJSON).not.toHaveBeenCalled();
  });
});
