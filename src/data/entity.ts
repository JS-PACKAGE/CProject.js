import { v7 } from "uuid";
import type { Entity, Snapshot, TableName } from "../core/types";
export const tables: TableName[] = [
  "work_calendars",
  "weekday_rules",
  "calendar_exceptions",
  "projects",
  "tasks",
  "dependencies",
  "calendar_events",
  "reminders",
];
export function entity(): Entity {
  return { id: v7(), version: 1, updated_at: Date.now(), deleted_at: null };
}
export function emptySnapshot(): Snapshot {
  return {
    work_calendars: [],
    weekday_rules: [],
    calendar_exceptions: [],
    projects: [],
    tasks: [],
    dependencies: [],
    calendar_events: [],
    reminders: [],
    settings: {
      language: "zh-TW",
      autostart: false,
      close_to_tray: true,
      notification_sound: true,
      default_reminder_offsets: [1440, 120],
    },
  };
}
export function initialSnapshot(): Snapshot {
  const s = emptySnapshot();
  const calendar = { ...entity(), name: "Standard", is_default: true };
  s.work_calendars.push(calendar);
  for (let weekday = 0; weekday < 7; weekday++)
    s.weekday_rules.push({
      ...entity(),
      calendar_id: calendar.id,
      weekday,
      is_working: weekday > 0 && weekday < 6,
      segments: [
        { start: "09:00", end: "12:00" },
        { start: "13:30", end: "18:00" },
      ],
    });
  return s;
}
export function activeSnapshot(s: Snapshot): Snapshot {
  const result = structuredClone(s);
  for (const table of tables)
    (result[table] as Entity[]) = result[table].filter(
      (row) => row.deleted_at === null,
    );
  return result;
}
