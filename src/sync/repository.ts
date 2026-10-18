import { v7 } from "uuid";
import type { Change, Settings, Snapshot } from "../core/types";
import type { Repository } from "../data/repositories";
import { makeChanges } from "../data/changeLog";
import { validateSnapshot } from "../data/validation";
import { SyncTransport } from "../data/transport";

const deviceKeys = ["autostart", "close_to_tray", "notification_sound"] as const;
export function sharedSettings(settings: Settings): Settings {
  return { ...settings, autostart: false, close_to_tray: true, notification_sound: true };
}

export class RemoteRepository implements Repository {
  revision = -1;
  private timezone = "";
  private stopped = false;
  constructor(
    private transport: SyncTransport,
    private local: Repository,
    private synced: (warning: string | null) => void,
  ) {}
  get refreshSchedules(): boolean {
    return this.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  private get timezoneWarning(): string | null {
    return this.refreshSchedules ? null :
      `This workspace uses ${this.timezone}. Set this device to the same time zone before editing; viewing is still available.`;
  }
  stop(): void { this.stopped = true; }
  private ensureActive(): void {
    if (this.stopped) throw new Error("This sync session has ended. Sign in again.");
  }
  async load(): Promise<Snapshot> {
    this.ensureActive();
    const { snapshot, revision, timezone } = await this.transport.request<{
      snapshot: Snapshot; revision: number; timezone: string;
    }>("workspace");
    validateSnapshot(snapshot);
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof timezone !== "string")
      throw new Error("The server returned an invalid workspace.");
    const local = await this.local.load();
    this.ensureActive();
    this.revision = revision;
    this.timezone = timezone;
    for (const key of deviceKeys) snapshot.settings[key] = local.settings[key];
    this.synced(this.timezoneWarning);
    return snapshot;
  }
  async commit(changes: Change[], settings: Settings | null): Promise<void> {
    this.ensureActive();
    if (this.timezoneWarning) throw new Error(this.timezoneWarning);
    if (this.revision < 0) throw new Error("Load the workspace before editing.");
    const remote = changes.flatMap((change): Change[] => {
      if (change.table !== "settings") return [change];
      const before = sharedSettings(change.before as Settings);
      const payload = sharedSettings(change.payload as Settings);
      if (JSON.stringify(before) === JSON.stringify(payload)) return [];
      return [{ ...change, before, payload }];
    });
    const result = await this.transport.request<{ revision: number }>("commit", {
      base_revision: this.revision,
      changes: remote,
      settings: remote.some((c) => c.table === "settings") && settings
        ? sharedSettings(settings) : null,
    });
    this.ensureActive();
    this.revision = result.revision;
    if (settings) {
      const before = await this.local.load();
      const next = structuredClone(before);
      for (const key of deviceKeys) next.settings[key] = settings[key];
      const localChanges = makeChanges(before, next, v7());
      if (localChanges.length) await this.local.commit(localChanges, next.settings);
    }
    this.synced(null);
  }
  async changes(): Promise<Change[]> {
    this.ensureActive();
    const changes = await this.transport.request<Change[]>("changes");
    const local = await this.local.load();
    this.ensureActive();
    return changes.map((change) => {
      if (change.table !== "settings") return change;
      const before = { ...(change.before as Settings) };
      const payload = { ...(change.payload as Settings) };
      for (const key of deviceKeys) before[key] = payload[key] = local.settings[key];
      return { ...change, before, payload };
    });
  }
}
