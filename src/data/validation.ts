import type { Snapshot, Segment, Entity } from "../core/types";
import { activeSnapshot, tables } from "./entity";
import { assertAcyclic } from "../core/dependency";

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function text(value: unknown): value is string {
  return typeof value === "string";
}
function percent(value: unknown): boolean {
  return value === null || (finite(value) && value >= 0 && value <= 100);
}
function segments(value: unknown): asserts value is Segment[] {
  requireValue(Array.isArray(value), "Working segments must be an array");
  let previous = "";
  for (const segment of value) {
    requireValue(
      segment &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(segment.start) &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(segment.end),
      "Invalid working time",
    );
    requireValue(
      segment.start < segment.end && segment.start >= previous,
      "Working segments must be ordered and cannot overlap",
    );
    previous = segment.end;
  }
}
function interval(row: { start_at: number; end_at: number }): void {
  requireValue(
    finite(row.start_at) &&
      finite(row.end_at) &&
      row.end_at >= row.start_at &&
      Math.abs(row.start_at) < 8.64e15 &&
      Math.abs(row.end_at) < 8.64e15,
    "Invalid date interval",
  );
}
export function validateSnapshot(value: unknown): asserts value is Snapshot {
  requireValue(value !== null && typeof value === "object", "Invalid backup");
  const snapshot = value as Snapshot;
  for (const table of tables) {
    requireValue(Array.isArray(snapshot[table]), `Missing table: ${table}`);
    const seen = new Set<string>();
    for (const row of snapshot[table] as Entity[]) {
      requireValue(
        row &&
          text(row.id) &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            row.id,
          ),
        "Entity ID must be UUID v7",
      );
      requireValue(!seen.has(row.id), "Duplicate entity ID");
      seen.add(row.id);
      requireValue(
        Number.isInteger(row.version) &&
          row.version > 0 &&
          finite(row.updated_at) &&
          (row.deleted_at === null || finite(row.deleted_at)),
        "Invalid entity metadata",
      );
    }
  }
  const s = activeSnapshot(snapshot);
  const calendarIds = new Set(s.work_calendars.map((row) => row.id));
  const projects = new Map(s.projects.map((row) => [row.id, row]));
  const tasks = new Map(s.tasks.map((row) => [row.id, row]));
  requireValue(
    s.work_calendars.filter((c) => c.is_default).length <= 1,
    "Only one default calendar is allowed",
  );
  for (const row of s.work_calendars)
    requireValue(
      text(row.name) && row.name.trim() && typeof row.is_default === "boolean",
      "Invalid work calendar",
    );
  const weekdays = new Set<string>();
  for (const row of s.weekday_rules) {
    requireValue(
      calendarIds.has(row.calendar_id) &&
        Number.isInteger(row.weekday) &&
        row.weekday >= 0 &&
        row.weekday <= 6 &&
        typeof row.is_working === "boolean",
      "Invalid weekday rule",
    );
    const key = `${row.calendar_id}:${row.weekday}`;
    requireValue(!weekdays.has(key), "Duplicate weekday rule");
    weekdays.add(key);
    segments(row.segments);
  }
  const exceptions = new Set<string>();
  for (const row of s.calendar_exceptions) {
    requireValue(
      calendarIds.has(row.calendar_id) &&
        /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        new Date(`${row.date}T12:00:00Z`).toISOString().slice(0, 10) ===
          row.date,
      "Invalid exception date",
    );
    const key = `${row.calendar_id}:${row.date}`;
    requireValue(!exceptions.has(key), "Duplicate exception date");
    exceptions.add(key);
    requireValue(
      ["holiday", "makeup_workday", "custom"].includes(row.kind) &&
        typeof row.is_working === "boolean" &&
        text(row.note),
      "Invalid exception",
    );
    if (row.segments !== null) segments(row.segments);
  }
  const statuses = ["planned", "active", "on_hold", "done", "archived"];
  for (const row of s.projects) {
    requireValue(
      text(row.name) &&
        row.name.trim() &&
        calendarIds.has(row.calendar_id) &&
        ["working_hours", "full_days"].includes(row.duration_mode),
      "Invalid project",
    );
    requireValue(
      statuses.includes(row.status) &&
        text(row.notes) &&
        /^#[0-9a-f]{6}$/i.test(row.color) &&
        percent(row.progress_manual),
      "Invalid project properties",
    );
    interval(row);
  }
  for (const row of s.tasks) {
    requireValue(
      projects.has(row.project_id) &&
        text(row.name) &&
        row.name.trim() &&
        text(row.notes) &&
        statuses.includes(row.status),
      "Invalid task",
    );
    interval(row);
    requireValue(
      percent(row.progress) &&
        row.progress !== null &&
        percent(row.progress_manual) &&
        typeof row.milestone === "boolean" &&
        finite(row.order_index),
      "Invalid task properties",
    );
    requireValue(
      row.duration_minutes === null ||
        (finite(row.duration_minutes) && row.duration_minutes >= 0),
      "Invalid task duration",
    );
    if (
      projects.get(row.project_id)?.duration_mode === "full_days" &&
      row.duration_minutes !== null
    )
      requireValue(
        row.duration_minutes % 1440 === 0,
        "Whole-day duration must be an integer number of days",
      );
    if (row.parent_id !== null) {
      const parent = tasks.get(row.parent_id);
      requireValue(
        parent &&
          parent.id !== row.id &&
          parent.project_id === row.project_id &&
          parent.parent_id === null,
        "Tasks support two levels within the same project",
      );
      requireValue(!parent.milestone, "A milestone cannot have subtasks");
    }
  }
  const edges = new Set<string>();
  for (const row of s.dependencies) {
    requireValue(
      projects.has(row.project_id) &&
        tasks.get(row.predecessor_task_id)?.project_id === row.project_id &&
        tasks.get(row.successor_task_id)?.project_id === row.project_id,
      "Dependency tasks must belong to the same project",
    );
    requireValue(
      ["FS", "SS", "FF", "SF"].includes(row.type) &&
        finite(row.lag_minutes) &&
        typeof row.propagate === "boolean",
      "Invalid dependency",
    );
    const key = `${row.predecessor_task_id}:${row.successor_task_id}`;
    requireValue(!edges.has(key), "Duplicate dependency");
    edges.add(key);
  }
  assertAcyclic(s.tasks, s.dependencies);
  for (const row of s.calendar_events) {
    requireValue(
      calendarIds.has(row.calendar_id) &&
        text(row.title) &&
        row.title.trim() &&
        typeof row.all_day === "boolean" &&
        ["block", "leave", "meeting", "custom"].includes(row.kind),
      "Invalid calendar event",
    );
    interval(row);
    requireValue(row.rrule === null || text(row.rrule), "Invalid recurrence");
    if (row.override !== null) {
      const o = row.override;
      requireValue(
        o &&
          ["project", "task"].includes(o.target_type) &&
          ["exclude", "rewrite"].includes(o.mode),
        "Invalid event override",
      );
      const target =
        o.target_type === "project"
          ? projects.get(o.target_id)
          : tasks.get(o.target_id);
      requireValue(target, "Override target does not exist");
      const project =
        o.target_type === "project"
          ? projects.get(o.target_id)
          : projects.get(tasks.get(o.target_id)!.project_id);
      requireValue(
        project?.calendar_id === row.calendar_id,
        "Override target must use the event calendar",
      );
      if (o.mode === "rewrite")
        interval({
          start_at: o.new_start ?? row.start_at,
          end_at: o.new_end ?? row.end_at,
        });
    }
  }
  for (const row of s.reminders) {
    requireValue(
      ["project", "task", "event", "custom"].includes(row.entity_type) &&
        text(row.entity_id) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.entity_id) &&
        finite(row.trigger_at) &&
        finite(row.offset_minutes),
      "Invalid reminder",
    );
    requireValue(
      [
        "reminder.project",
        "reminder.task",
        "reminder.event",
        "reminder.custom",
      ].includes(row.message_key) &&
        row.params &&
        typeof row.params === "object" &&
        !Array.isArray(row.params) &&
        Object.values(row.params).every(text),
      "Invalid reminder message",
    );
    requireValue(
      (row.fired_at === null || finite(row.fired_at)) &&
        (row.snoozed_to === null || finite(row.snoozed_to)),
      "Invalid reminder state",
    );
  }
  const settings = s.settings;
  requireValue(
    settings && ["zh-TW", "en", "ja"].includes(settings.language),
    "Invalid language setting",
  );
  requireValue(
    typeof settings.notification_sound === "boolean",
    "Invalid application settings",
  );
  requireValue(
    Array.isArray(settings.default_reminder_offsets) &&
      settings.default_reminder_offsets.every((n) => finite(n) && n >= 0) &&
      new Set(settings.default_reminder_offsets).size ===
        settings.default_reminder_offsets.length,
    "Reminder offsets must be distinct nonnegative minutes",
  );
}
