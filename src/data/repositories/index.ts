import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Change, Entity, Settings, Snapshot } from "../../core/types";
import { emptySnapshot } from "../entity";

export interface Repository {
  readonly refreshSchedules?: boolean;
  load(): Promise<Snapshot>;
  commit(changes: Change[], settings: Settings | null): Promise<void>;
  changes(): Promise<Change[]>;
}
export const isDesktop = isTauri();
export class DesktopRepository implements Repository {
  load(): Promise<Snapshot> {
    return invoke("load_snapshot");
  }
  commit(changes: Change[], settings: Settings | null): Promise<void> {
    return invoke("commit_changes", { changes, settings });
  }
  changes(): Promise<Change[]> {
    return invoke("load_changes");
  }
}
interface Stored {
  snapshot: Snapshot;
  changes: Change[];
}
/** Browser preview storage is isolated from the native application's SQLite database. */
export class BrowserRepository implements Repository {
  private connection: Promise<IDBDatabase> | null = null;
  private db(): Promise<IDBDatabase> {
    if (this.connection) return this.connection;
    const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
    const request = indexedDB.open("cproject-preview", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      this.connection = null;
      reject(request.error);
    };
    this.connection = promise;
    return promise;
  }
  private async stored(): Promise<Stored> {
    const db = await this.db();
    const { promise, resolve, reject } = Promise.withResolvers<Stored>();
    const request = db.transaction("state").objectStore("state").get("current");
    request.onsuccess = () =>
      resolve(request.result ?? { snapshot: emptySnapshot(), changes: [] });
    request.onerror = () => reject(request.error);
    return promise;
  }
  async load(): Promise<Snapshot> {
    return (await this.stored()).snapshot;
  }
  async changes(): Promise<Change[]> {
    return (await this.stored()).changes;
  }
  async commit(changes: Change[], settings: Settings | null): Promise<void> {
    const db = await this.db();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const tx = db.transaction("state", "readwrite");
    const store = tx.objectStore("state");
    const request = store.get("current");
    let failure: unknown;
    request.onsuccess = () => {
      try {
        const state: Stored = request.result ?? {
          snapshot: emptySnapshot(),
          changes: [],
        };
        for (const change of changes) {
          if (change.table === "settings") {
            const before = change.before as Settings;
            if (
              (Object.keys(state.snapshot.settings) as (keyof Settings)[]).some(
                (key) =>
                  JSON.stringify(state.snapshot.settings[key]) !==
                  JSON.stringify(before[key]),
              )
            )
              throw new Error(
                "Settings changed in another window. Reload before editing.",
              );
            continue;
          }
          const rows: Entity[] = state.snapshot[change.table];
          const index = rows.findIndex((row) => row.id === change.row_id);
          const current = rows[index];
          const before = change.before as Entity | null;
          if ((current?.version ?? null) !== (before?.version ?? null))
            throw new Error(
              "Data changed in another window. Reload before editing.",
            );
          const value = structuredClone(change.payload) as Entity;
          if (index === -1) rows.push(value);
          else rows[index] = value;
        }
        if (settings) state.snapshot.settings = structuredClone(settings);
        state.changes.push(...structuredClone(changes));
        store.put(state, "current");
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(failure ?? tx.error);
    tx.onabort = () =>
      reject(failure ?? tx.error ?? new Error("Storage transaction aborted"));
    return promise;
  }
}
export function createRepository(): Repository {
  return isDesktop ? new DesktopRepository() : new BrowserRepository();
}
