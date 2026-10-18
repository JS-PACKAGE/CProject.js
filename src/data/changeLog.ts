import { v7 } from "uuid";
import type { Change, Entity, Snapshot } from "../core/types";
import { tables } from "./entity";
function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) => Object.hasOwn(right, key) && equal(left[key], right[key]),
    )
  );
}
function content(row: Entity): unknown {
  const { version: _v, updated_at: _u, ...rest } = row;
  return rest;
}
/** Assign versions once at the transaction boundary, including generated schedule changes. */
export function makeChanges(
  before: Snapshot,
  next: Snapshot,
  deviceId: string,
  now = Date.now(),
): Change[] {
  const changes: Change[] = [];
  for (const table of tables) {
    const old = new Map(before[table].map((row) => [row.id, row]));
    const rows: Entity[] = next[table];
    for (const row of rows) {
      const previous = old.get(row.id);
      old.delete(row.id);
      if (previous && equal(content(previous), content(row))) {
        Object.assign(row, {
          version: previous.version,
          updated_at: previous.updated_at,
        });
        continue;
      }
      row.version = (previous?.version ?? 0) + 1;
      row.updated_at = now;
      changes.push({
        id: v7(),
        table,
        row_id: row.id,
        op: row.deleted_at === null ? "upsert" : "delete",
        payload: structuredClone(row),
        before: previous ?? null,
        ts: now,
        device_id: deviceId,
      });
    }
    // An imported backup can omit newer rows; retain their tombstones for future sync.
    for (const previous of old.values()) {
      if (previous.deleted_at !== null) {
        rows.push(previous);
        continue;
      }
      const row = {
        ...previous,
        deleted_at: now,
        updated_at: now,
        version: previous.version + 1,
      };
      rows.push(row);
      changes.push({
        id: v7(),
        table,
        row_id: row.id,
        op: "delete",
        payload: row,
        before: previous,
        ts: now,
        device_id: deviceId,
      });
    }
  }
  if (!equal(before.settings, next.settings))
    changes.push({
      id: v7(),
      table: "settings",
      row_id: "settings",
      op: "upsert",
      payload: next.settings,
      before: before.settings,
      ts: now,
      device_id: deviceId,
    });
  return changes;
}
