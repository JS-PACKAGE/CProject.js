import { afterEach, describe, expect, it, vi } from "vitest";
import type { Change, Entity, Reminder, Settings, Snapshot } from "../core/types";
import { Application } from "./app";
import { entity, initialSnapshot } from "./entity";
import type { Repository } from "./repositories";

class MemoryRepository implements Repository {
  snapshot = initialSnapshot();
  history: Change[] = [];
  async load(): Promise<Snapshot> { return structuredClone(this.snapshot); }
  async changes(): Promise<Change[]> { return structuredClone(this.history); }
  async commit(changes: Change[], settings: Settings | null): Promise<void> {
    for (const change of changes) {
      if (change.table === "settings") continue;
      const rows: Entity[] = this.snapshot[change.table];
      const index = rows.findIndex(row => row.id === change.row_id);
      if (index < 0) rows.push(structuredClone(change.payload) as Entity);
      else rows[index] = structuredClone(change.payload) as Entity;
    }
    if (settings) this.snapshot.settings = structuredClone(settings);
    this.history.push(...structuredClone(changes));
  }
}
function reminder(patch: Partial<Reminder> = {}): Reminder {
  const metadata = entity();
  return {
    ...metadata, entity_type: "custom", entity_id: metadata.id,
    trigger_at: Date.now() - 1000, message_key: "reminder.custom", params: { name: "Due" },
    offset_minutes: 0, fired_at: null, snoozed_to: null, ...patch,
  };
}
afterEach(() => vi.useRealTimers());

describe("hosted workspace requirement", () => {
  it("does not initialize calendars or publish data before a repository is connected", async () => {
    const app = new Application(undefined, "browser-one");
    const subscriber = vi.fn();
    app.subscribe(subscriber);
    await expect(app.load()).rejects.toThrow("Connect to the shared workspace");
    await expect(app.exportJSON()).rejects.toThrow("Connect to the shared workspace");
    expect(subscriber).not.toHaveBeenCalled();
    const repository = new MemoryRepository();
    await app.setRepository(repository);
    await app.refresh();
    expect(subscriber).toHaveBeenCalledOnce();
  });
});

describe("browser reminder delivery", () => {
  it("fires only active due reminders and preserves future, snoozed and deleted records", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
    const repository = new MemoryRepository();
    const due = reminder();
    const skipped = [
      reminder({ trigger_at: Date.now() + 1000 }),
      reminder({ fired_at: Date.now() - 2000 }),
      reminder({ snoozed_to: Date.now() + 60_000 }),
      reminder({ deleted_at: Date.now() - 2000 }),
    ];
    repository.snapshot.reminders = [due, ...skipped];
    const app = new Application(repository, "browser-one");
    const delivered: string[] = [];
    await app.deliverReminders(async row => { delivered.push(row.id); return true; });
    expect(delivered).toEqual([due.id]);
    expect(repository.snapshot.reminders[0]).toMatchObject({ fired_at: Date.now(), version: 2 });
    expect(repository.snapshot.reminders.slice(1)).toEqual(skipped);
    expect(repository.history.map(change => change.row_id)).toEqual([due.id]);
    await app.deliverReminders(async row => { delivered.push(row.id); return true; });
    expect(delivered).toEqual([due.id]);
  });
  it("leaves denied or failed notifications pending and retains earlier successful deliveries", async () => {
    const repository = new MemoryRepository();
    const first = reminder(), second = reminder();
    repository.snapshot.reminders = [first, second];
    const app = new Application(repository, "browser-one");
    await app.deliverReminders(async () => false);
    expect(repository.snapshot.reminders).toEqual([first, second]);
    expect(repository.history).toEqual([]);
    await expect(app.deliverReminders(async row => {
      if (row.id === second.id) throw new Error("Browser rejected notification");
      return true;
    })).rejects.toThrow("Browser rejected notification");
    expect(repository.snapshot.reminders[0]!.fired_at).not.toBeNull();
    expect(repository.snapshot.reminders[1]!.fired_at).toBeNull();
    const retried: string[] = [];
    await app.deliverReminders(async row => { retried.push(row.id); return true; });
    expect(retried).toEqual([second.id]);
  });
  it("serializes overlapping delivery checks so each accepted reminder is sent once", async () => {
    const repository = new MemoryRepository();
    const due = reminder();
    repository.snapshot.reminders = [due];
    const app = new Application(repository, "browser-one");
    const delivered: string[] = [];
    const dispatch = async (row: Reminder) => { delivered.push(row.id); return true; };
    await Promise.all([app.deliverReminders(dispatch), app.deliverReminders(dispatch)]);
    expect(delivered).toEqual([due.id]);
    expect(repository.history.map(change => change.row_id)).toEqual([due.id]);
  });
});

describe("desktop backup migration", () => {
  it("imports existing workspace data and sound preferences without obsolete native settings", async () => {
    const repository = new MemoryRepository();
    repository.snapshot.settings.week_start = 0;
    const app = new Application(repository, "browser-one");
    const backup = structuredClone(repository.snapshot);
    backup.work_calendars[0]!.name = "Migrated calendar";
    backup.settings.notification_sound = false;
    const legacy = { ...backup, settings: { ...backup.settings, autostart: true, close_to_tray: true } };
    Reflect.deleteProperty(legacy.settings, "week_start");
    await app.importJSON(JSON.stringify({ format: "cproject-js", version: 1, snapshot: legacy }));
    const exported = JSON.parse(await app.exportJSON());
    expect(exported.snapshot.work_calendars[0].name).toBe("Migrated calendar");
    expect(exported.snapshot.settings).toEqual({ ...backup.settings, week_start: 1 });
    await app.undo();
    expect(repository.snapshot.work_calendars[0]!.name).toBe("Standard");
    expect(repository.snapshot.settings.notification_sound).toBe(true);
    expect(repository.snapshot.settings.week_start).toBe(0);
    expect(repository.history.filter(change => change.table === "settings")[0]).toMatchObject({
      before: { week_start: 0 },
      payload: { week_start: 1 },
    });
  });
  it("preserves Sunday imports and restores them when a later settings edit is undone", async () => {
    const repository = new MemoryRepository();
    const app = new Application(repository, "browser-one");
    const backup = structuredClone(repository.snapshot);
    backup.settings.week_start = 0;
    await app.importJSON(JSON.stringify({ format: "cproject-js", version: 1, snapshot: backup }));
    expect(repository.snapshot.settings.week_start).toBe(0);
    expect(repository.history.filter(change => change.table === "settings")[0]).toMatchObject({
      before: { week_start: 1 },
      payload: { week_start: 0 },
    });
    await app.updateSettings({ week_start: 6 });
    expect(repository.snapshot.settings.week_start).toBe(6);
    await app.undo();
    expect(repository.snapshot.settings.week_start).toBe(0);
  });
  it.each([null, "1", true, -1, 7, 1.5])("rejects an invalid imported week start (%s) without changing data or history", async weekStart => {
    const repository = new MemoryRepository();
    const app = new Application(repository, "browser-one");
    const before = structuredClone(repository.snapshot);
    const backup = structuredClone(before);
    Object.assign(backup.settings, { week_start: weekStart });
    await expect(app.importJSON(JSON.stringify({
      format: "cproject-js", version: 1, snapshot: backup,
    }))).rejects.toThrow();
    expect(repository.snapshot).toEqual(before);
    expect(repository.history).toEqual([]);
  });
  it.each([undefined, null, "1", true, -1, 7, 1.5])("rejects an invalid settings edit (%s) without losing the saved preference", async weekStart => {
    const repository = new MemoryRepository();
    repository.snapshot.settings.week_start = 0;
    const app = new Application(repository, "browser-one");
    const before = structuredClone(repository.snapshot);
    await expect(app.updateSettings({
      week_start: weekStart as number,
    })).rejects.toThrow();
    expect(repository.snapshot).toEqual(before);
    expect(repository.history).toEqual([]);
  });
});
