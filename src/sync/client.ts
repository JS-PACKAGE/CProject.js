import { app, localRepository } from "../data/app";
import { serverOrigin, SyncError, SyncTransport } from "../data/transport";
import { RemoteRepository } from "./repository";

export interface SyncState {
  mode: "local" | "server";
  phase: "starting" | "signed_out" | "connecting" | "ready" | "offline";
  serverUrl: string;
  user: { id: string; username: string } | null;
  hosted: boolean;
  error: string | null;
  lastSyncedAt: number | null;
  busy: boolean;
}
type User = NonNullable<SyncState["user"]>;

class SyncController {
  private state: SyncState = {
    mode: "local", phase: "starting", serverUrl: "", user: null,
    hosted: false, error: null, lastSyncedAt: null, busy: false,
  };
  private listeners = new Set<(state: SyncState) => void>();
  private initialized: Promise<void> | null = null;
  private transport: SyncTransport | null = null;
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
    this.initialized ??= this.start();
    return this.initialized;
  }
  private async start(): Promise<void> {
    window.addEventListener("online", () => { void this.refresh().catch(() => {}); });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && this.state.user) void this.refresh().catch(() => {});
    });
    const origin = window.location.origin;
    let hosted = localStorage.getItem("cproject-hosted-sync") === "true";
    try {
      const response = await fetch("/api/info", {
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
      });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const info = await response.json() as { service?: string; version?: number };
        hosted ||= info.service === "cproject-sync" && info.version === 1;
      } else if (response.status >= 500) {
        throw new Error("The sync server is unavailable. Please try again.");
      }
      if (!hosted) { this.publish({ phase: "ready", serverUrl: origin }); return; }
      localStorage.setItem("cproject-hosted-sync", "true");
      this.publish({ mode: "server", hosted: true, serverUrl: serverOrigin(origin), phase: "signed_out" });
      if (localStorage.getItem("cproject-session-blocked") === "true") return;
      const transport = new SyncTransport(origin);
      const { user } = await transport.request<{ user: User }>("session");
      await this.activate(origin, user);
    } catch (error) {
      // An unavailable hosted API must never silently open an unrelated local workspace.
      this.publish({
        mode: "server", hosted: true, serverUrl: origin, phase: "signed_out", user: null,
        error: error instanceof SyncError && error.status === 401 ? null : String(error instanceof Error ? error.message : error),
      });
    }
  }
  private fail(error: SyncError, repository: RemoteRepository): void {
    if (this.remote !== repository) return;
    if (error.status === 401) {
      repository.stop();
      this.stopPolling();
      localStorage.setItem("cproject-session-blocked", "true");
      this.publish({ phase: "signed_out", user: null, error: error.message, lastSyncedAt: null });
    } else {
      this.publish({
        phase: error.status === 0 || error.status >= 500 ? "offline" : "ready",
        error: error.message,
      });
    }
  }
  private async activate(origin: string, user: User): Promise<void> {
    if (!user || typeof user.id !== "string" || typeof user.username !== "string")
      throw new Error("Invalid sign-in response.");
    const transport = new SyncTransport(origin, (error) => this.fail(error, repository), user.id);
    const repository = new RemoteRepository(transport, localRepository, (warning) => {
      if (this.remote === repository && this.state.user)
        this.publish({ phase: "ready", lastSyncedAt: Date.now(), error: warning });
    });
    this.remote?.stop();
    this.stopPolling();
    this.remote = repository;
    this.transport = transport;
    this.publish({ mode: "server", phase: "connecting", serverUrl: origin, user, error: null, lastSyncedAt: null });
    await app.setRepository(repository);
    try {
      await app.load();
      localStorage.removeItem("cproject-session-blocked");
      this.publish({ phase: "ready" });
      this.timer = window.setInterval(() => {
        if (!document.hidden && this.state.user && !this.state.busy)
          void this.refresh().catch(() => {});
      }, 10_000);
    } catch (error) {
      repository.stop();
      this.publish({ phase: "signed_out", user: null, lastSyncedAt: null });
      throw error;
    }
  }
  async login(serverUrl: string, username: string, password: string): Promise<void> {
    if (this.state.busy) throw new Error("Another connection operation is in progress.");
    const origin = serverOrigin(serverUrl);
    if (origin !== window.location.origin)
      throw new Error("Open the server's web address to sign in. Browser sync uses the same origin.");
    this.publish({ busy: true, phase: "connecting", error: null });
    try {
      const transport = new SyncTransport(origin);
      const result = await transport.request<{ user: User }>("login", {
        username: username.trim(), password,
      });
      await this.activate(origin, result.user);
    } catch (error) {
      this.publish({ phase: "signed_out", user: null, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { this.publish({ busy: false }); }
  }
  private stopPolling(): void {
    window.clearInterval(this.timer);
    this.timer = undefined;
  }
  async logout(): Promise<void> {
    if (this.state.busy) throw new Error("Another connection operation is in progress.");
    this.publish({ busy: true, user: null, phase: "signed_out", lastSyncedAt: null, error: null });
    localStorage.setItem("cproject-session-blocked", "true");
    this.remote?.stop();
    this.stopPolling();
    try {
      if (this.transport) await this.transport.request("logout", {});
      this.transport = null;
    } catch (error) {
      this.publish({ error: "Signed out on this device, but the server could not confirm session revocation. Reconnect and sign out again." });
      throw error;
    } finally { this.publish({ busy: false }); }
  }
  refresh(): Promise<void> {
    if (this.state.mode === "server" && !this.state.user) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = app.refresh().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }
  async uploadLocal(): Promise<void> {
    if (!this.remote || !this.state.user) throw new Error("Sign in before uploading local data.");
    if (this.state.busy) throw new Error("Another connection operation is in progress.");
    this.publish({ busy: true, error: null });
    try {
      const { snapshot: destination } = JSON.parse(await app.exportJSON());
      if (this.remote.revision !== 0)
        throw new Error("Local data can only be uploaded to a new, unused account. Export a backup and use Import for an intentional replacement.");
      const snapshot = await localRepository.load();
      if (!snapshot.work_calendars.length) throw new Error("There is no local workspace to upload.");
      await app.importJSON(JSON.stringify({ format: "cproject-js", version: 1, snapshot }), destination);
    } finally { this.publish({ busy: false }); }
  }
}
export const sync = new SyncController();
