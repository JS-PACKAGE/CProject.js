import { describe, expect, it } from "vitest";
import type { Change, Entity, Settings, Snapshot } from "../core/types";
import { Application } from "./app";
import { initialSnapshot } from "./entity";
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
describe("desktop backup migration", () => {
  it("imports existing workspace data and sound preferences without obsolete native settings", async () => {
    const repository = new MemoryRepository();
    const app = new Application(repository, "browser-one");
    const backup = structuredClone(repository.snapshot);
    backup.work_calendars[0]!.name = "Migrated calendar";
    backup.settings.notification_sound = false;
    const legacy = { ...backup, settings: { ...backup.settings, autostart: true, close_to_tray: true } };
    await app.importJSON(JSON.stringify({ format: "cproject-js", version: 1, snapshot: legacy }));
    const exported = JSON.parse(await app.exportJSON());
    expect(exported.snapshot.work_calendars[0].name).toBe("Migrated calendar");
    expect(exported.snapshot.settings).toEqual(backup.settings);
    await app.undo();
    expect(repository.snapshot.work_calendars[0]!.name).toBe("Standard");
    expect(repository.snapshot.settings.notification_sound).toBe(true);
  });
});
