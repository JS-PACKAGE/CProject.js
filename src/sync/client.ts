import { app } from "../data/app";
import { serverOrigin, SyncError, SyncTransport } from "../data/transport";
import { RemoteRepository } from "./repository";

export interface SyncState {
  phase: "starting" | "connecting" | "ready" | "offline";
  serverUrl: string;
  error: string | null;
  lastSyncedAt: number | null;
  busy: boolean;
}

class SyncController {
  private state: SyncState = {
    phase: "starting", serverUrl: "",
    error: null, lastSyncedAt: null, busy: false,
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
        if (!document.hidden) void this.refresh().catch(() => {});
      });
      this.initialized = this.connect();
    }
    return this.initialized;
  }
  private async connect(): Promise<void> {
    const origin = window.location.origin;
    this.publish({ busy: true, phase: "connecting", serverUrl: origin, error: null });
    try {
      const response = await fetch("/api/info", {
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
        throw new Error("The shared workspace is unavailable. Please try again.");
      const info = await response.json() as { service?: string; version?: number };
      if (info?.service !== "cproject-sync")
        throw new Error("The shared workspace is unavailable. Please try again.");
      if (info.version !== 2)
        throw new Error("This sync server uses an incompatible protocol. Update the server and reload this page.");
      this.publish({ serverUrl: serverOrigin(origin) });
      await this.activate(origin);
    } catch (error) {
      // An unavailable hosted API must never silently open an unrelated local workspace.
      this.publish({
        serverUrl: origin, phase: "offline",
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
    const repository = new RemoteRepository(transport, (warning) => {
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
        if (!this.remote) {
          await this.connect();
          return;
        }
        this.publish({ busy: true });
        try { await app.refresh(); }
        catch (error) {
          this.publish({
            phase: "offline", error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally { this.publish({ busy: false }); }
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
}
export const sync = new SyncController();
