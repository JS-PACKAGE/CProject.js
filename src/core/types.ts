export type ID = string;
export type Language = "zh-TW" | "en" | "ja";
export interface Entity {
  id: ID;
  version: number;
  updated_at: number;
  deleted_at: number | null;
}
export interface Segment {
  start: string;
  end: string;
}
export interface WorkCalendar extends Entity {
  name: string;
  is_default: boolean;
}
export interface WeekdayRule extends Entity {
  calendar_id: ID;
  weekday: number;
  is_working: boolean;
  segments: Segment[];
}
export interface CalendarException extends Entity {
  calendar_id: ID;
  date: string;
  kind: "holiday" | "makeup_workday" | "custom";
  is_working: boolean;
  segments: Segment[] | null;
  note: string;
}
export type DurationMode = "working_hours" | "full_days";
export type Status = "planned" | "active" | "on_hold" | "done" | "archived";
export interface Project extends Entity {
  name: string;
  calendar_id: ID;
  duration_mode: DurationMode;
  start_at: number;
  end_at: number;
  status: Status;
  color: string;
  notes: string;
  progress_manual: number | null;
}
export interface Task extends Entity {
  project_id: ID;
  parent_id: ID | null;
  name: string;
  start_at: number;
  end_at: number;
  duration_minutes: number | null;
  progress: number;
  progress_manual: number | null;
  status: Status;
  order_index: number;
  milestone: boolean;
  notes: string;
}
export interface Dependency extends Entity {
  project_id: ID;
  predecessor_task_id: ID;
  successor_task_id: ID;
  type: "FS" | "SS" | "FF" | "SF";
  lag_minutes: number;
  propagate: boolean;
}
export interface EventOverride {
  target_type: "project" | "task";
  target_id: ID;
  mode: "exclude" | "rewrite";
  new_start?: number;
  new_end?: number;
}
export interface CalendarEvent extends Entity {
  calendar_id: ID;
  title: string;
  start_at: number;
  end_at: number;
  all_day: boolean;
  kind: "block" | "leave" | "meeting" | "custom";
  rrule: string | null;
  override: EventOverride | null;
}
export interface Reminder extends Entity {
  entity_type: "project" | "task" | "event" | "custom";
  entity_id: ID;
  trigger_at: number;
  message_key: string;
  params: Record<string, string>;
  offset_minutes: number;
  fired_at: number | null;
  snoozed_to: number | null;
}
export interface Settings {
  language: Language;
  week_start: number;
  notification_sound: boolean;
  default_reminder_offsets: number[];
}
export interface Tables {
  work_calendars: WorkCalendar;
  weekday_rules: WeekdayRule;
  calendar_exceptions: CalendarException;
  projects: Project;
  tasks: Task;
  dependencies: Dependency;
  calendar_events: CalendarEvent;
  reminders: Reminder;
}
export type TableName = keyof Tables;
export type Records = { [K in TableName]: Tables[K][] };
export interface Snapshot extends Records {
  settings: Settings;
}
export interface Change {
  id: ID;
  table: TableName | "settings";
  row_id: ID;
  op: "upsert" | "delete";
  payload: unknown;
  before: unknown;
  ts: number;
  device_id: ID;
}
export interface CalendarContext {
  calendar: WorkCalendar;
  rules: WeekdayRule[];
  exceptions: CalendarException[];
  events: CalendarEvent[];
  target?: { type: "project" | "task"; id: ID };
  project_id?: ID;
}
export interface Interval {
  start_at: number;
  end_at: number;
}
export interface ExtensionResult {
  project: Project;
  tasks: Task[];
}
