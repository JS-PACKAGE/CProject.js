import { app, localRepository } from "../data/app";
import { serverOrigin, SyncError, SyncTransport } from "../data/transport";
import { RemoteRepository } from "./repository";

export interface SyncState {
  mode: "local" | "server";
  phase: "starting" | "connecting" | "ready" | "offline";
  serverUrl: string;
  hosted: boolean;
  error: string | null;
  lastSyncedAt: number | null;
  busy: boolean;
}

class SyncController {
  private state: SyncState = {
    mode: "local", phase: "starting", serverUrl: "",
    hosted: false, error: null, lastSyncedAt: null, busy: false,
  };
  private listeners = new Set<(state: SyncState) => void>();
  private initialized: Promise<void> | null = null;
  private remote: RemoteRepository | null = null;
  private timer: number | undefined;
  private refreshing: Promise<void> | null = null;
  getState = (): SyncState => this.state;
  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => { this.listeners.delete(listener); };
  }
  private publish(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
  initialize(): Promise<void> {
    if (!this.initialized) {
      window.addEventListener("online", () => { void this.refresh().catch(() => {}); });
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && this.state.mode === "server") void this.refresh().catch(() => {});
      });
      this.initialized = this.connect();
    }
    return this.initialized;
  }
  private async connect(): Promise<void> {
    const origin = window.location.origin;
    this.publish({ busy: true, phase: "connecting", error: null });
    try {
      const response = await fetch("/api/info", {
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
      });
      let hosted = false;
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const info = await response.json() as { service?: string; version?: number };
        if (info.service === "cproject-sync") {
          if (info.version !== 2) throw new Error("This sync server uses an incompatible protocol. Update the server and reload this page.");
          hosted = true;
        }
      } else if (response.status !== 404 && response.ok === false) {
        throw new Error("The sync server is unavailable. Please try again.");
      }
      if (!hosted) {
        if (localStorage.getItem("cproject-hosted-sync") === "true")
          throw new Error("The shared workspace is unavailable. Please try again.");
        this.publish({ mode: "local", hosted: false, phase: "ready", serverUrl: origin });
        return;
      }
      localStorage.setItem("cproject-hosted-sync", "true");
      this.publish({ mode: "server", hosted: true, serverUrl: serverOrigin(origin) });
      await this.activate(origin);
    } catch (error) {
      // An unavailable hosted API must never silently open an unrelated local workspace.
      this.publish({
        mode: "server", hosted: true, serverUrl: origin, phase: "offline",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally { this.publish({ busy: false }); }
  }
  private fail(error: SyncError, repository: RemoteRepository): void {
    if (this.remote !== repository) return;
    this.publish({
      phase: error.status === 409 && error.code !== "protocol_changed" ? "ready" : "offline",
      error: error.message,
    });
  }
  private async activate(origin: string): Promise<void> {
    const transport = new SyncTransport(origin, (error) => this.fail(error, repository));
    const repository = new RemoteRepository(transport, localRepository, (warning) => {
      if (this.remote === repository)
        this.publish({ phase: "ready", lastSyncedAt: Date.now(), error: warning });
    });
    this.remote = repository;
    await app.setRepository(repository);
    window.clearInterval(this.timer);
    this.timer = window.setInterval(() => {
      if (!document.hidden && !this.state.busy) void this.refresh().catch(() => {});
    }, 10_000);
    await app.load();
  }
  refresh(): Promise<void> {
    if (this.state.busy) return this.refreshing ?? this.initialized ?? Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (this.state.mode === "server" && !this.remote) {
          await this.connect();
          return;
        }
        this.publish({ busy: true });
        try { await app.refresh(); }
        catch (error) {
          if (this.state.mode === "server") this.publish({
            phase: "offline", error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally { this.publish({ busy: false }); }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async uploadLocal(): Promise<void> {
    if (!this.remote || this.state.phase !== "ready") throw new Error("Connect to the shared workspace before uploading local data.");
    if (this.state.busy) throw new Error("Another connection operation is in progress.");
    this.publish({ busy: true, error: null });
    try {
      const { snapshot: destination } = JSON.parse(await app.exportJSON());
      if (this.remote.revision !== 0)
        throw new Error("Local data can only be uploaded to a new, unused shared workspace. Export a backup and use Import for an intentional replacement.");
      const snapshot = await localRepository.load();
      if (!snapshot.work_calendars.length) throw new Error("There is no local workspace to upload.");
      await app.importJSON(JSON.stringify({ format: "cproject-js", version: 1, snapshot }), destination);
    } finally { this.publish({ busy: false }); }
  }
}
export const sync = new SyncController();
