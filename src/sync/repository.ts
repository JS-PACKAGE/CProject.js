import type { Change, Settings, Snapshot } from "../core/types";
import type { Repository } from "../data/repositories";
import { getNotificationSound, setNotificationSound } from "../data/deviceSettings";
import { validateSnapshot } from "../data/validation";
import { SyncTransport } from "../data/transport";

export function sharedSettings(settings: Settings): Settings {
  return { ...settings, notification_sound: true };
}

export class RemoteRepository implements Repository {
  revision = -1;
  private timezone = "";
  constructor(
    private transport: SyncTransport,
    private synced: (warning: string | null) => void,
  ) {}
  get refreshSchedules(): boolean {
    return this.timezone === Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  private get timezoneWarning(): string | null {
    return this.refreshSchedules ? null :
      `This workspace uses ${this.timezone}. Set this device to the same time zone before editing; viewing is still available.`;
  }
  async load(): Promise<Snapshot> {
    const { snapshot, revision, timezone } = await this.transport.request<{
      snapshot: Snapshot; revision: number; timezone: string;
    }>("workspace");
    validateSnapshot(snapshot);
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof timezone !== "string")
      throw new Error("The server returned an invalid workspace.");
    this.revision = revision;
    this.timezone = timezone;
    snapshot.settings.notification_sound = getNotificationSound();
    this.synced(this.timezoneWarning);
    return snapshot;
  }
  async commit(changes: Change[], settings: Settings | null): Promise<void> {
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
    this.revision = result.revision;
    if (settings) setNotificationSound(settings.notification_sound);
    this.synced(null);
  }
  async changes(): Promise<Change[]> {
    const changes = await this.transport.request<Change[]>("changes");
    const sound = getNotificationSound();
    return changes.map((change) => {
      if (change.table !== "settings") return change;
      const before = { ...(change.before as Settings) };
      const payload = { ...(change.payload as Settings) };
      before.notification_sound = payload.notification_sound = sound;
      return { ...change, before, payload };
    });
  }
}
