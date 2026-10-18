import type {
  CalendarContext,
  CalendarEvent,
  Dependency,
  Entity,
  Project,
  Snapshot,
  Task,
} from "./types";
export const stamp = (id: string): Entity => ({
  id,
  version: 1,
  updated_at: 1,
  deleted_at: null,
});
export const at = (
  day: number,
  hour = 9,
  minute = 0,
  month = 0,
  year = 2026,
): number => +new Date(year, month, day, hour, minute);
export const context = (): CalendarContext => ({
  calendar: { ...stamp("cal"), name: "Work", is_default: true },
  rules: Array.from({ length: 7 }, (_, weekday) => ({
    ...stamp(`r${weekday}`),
    calendar_id: "cal",
    weekday,
    is_working: weekday > 0 && weekday < 6,
    segments: [
      { start: "09:00", end: "12:00" },
      { start: "13:00", end: "17:00" },
    ],
  })),
  exceptions: [],
  events: [],
  target: { type: "task", id: "a" },
  project_id: "p",
});
export const project = (patch: Partial<Project> = {}): Project => ({
  ...stamp("p"),
  name: "Project",
  calendar_id: "cal",
  duration_mode: "working_hours",
  start_at: at(5),
  end_at: at(5, 17),
  status: "active",
  color: "#abc",
  notes: "",
  progress_manual: null,
  ...patch,
});
export const task = (id = "a", patch: Partial<Task> = {}): Task => ({
  ...stamp(id),
  project_id: "p",
  parent_id: null,
  name: id,
  start_at: at(5),
  end_at: at(5, 10),
  duration_minutes: 60,
  progress: 0,
  progress_manual: null,
  status: "active",
  order_index: 0,
  milestone: false,
  notes: "",
  ...patch,
});
export const edge = (
  a = "a",
  b = "b",
  patch: Partial<Dependency> = {},
): Dependency => ({
  ...stamp(`${a}-${b}`),
  project_id: "p",
  predecessor_task_id: a,
  successor_task_id: b,
  type: "FS",
  lag_minutes: 0,
  propagate: true,
  ...patch,
});
export const event = (patch: Partial<CalendarEvent> = {}): CalendarEvent => ({
  ...stamp("e"),
  calendar_id: "cal",
  title: "Event",
  start_at: at(5, 10),
  end_at: at(5, 11),
  all_day: false,
  kind: "block",
  rrule: null,
  override: null,
  ...patch,
});
export function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  const c = context();
  return {
    work_calendars: [c.calendar],
    weekday_rules: c.rules,
    calendar_exceptions: [],
    projects: [project()],
    tasks: [task()],
    dependencies: [],
    calendar_events: [],
    reminders: [],
    settings: {
      language: "en",
      week_start: 1,
      notification_sound: true,
      default_reminder_offsets: [0, 60],
    },
    ...patch,
  };
}
