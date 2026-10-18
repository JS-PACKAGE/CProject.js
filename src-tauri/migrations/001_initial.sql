CREATE TABLE IF NOT EXISTS work_calendars (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, is_default INTEGER NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS weekday_rules (
 id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, weekday INTEGER NOT NULL, is_working INTEGER NOT NULL, segments TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_exceptions (
 id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, date TEXT NOT NULL, kind TEXT NOT NULL, is_working INTEGER NOT NULL, segments TEXT, note TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, calendar_id TEXT NOT NULL, duration_mode TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, status TEXT NOT NULL, color TEXT NOT NULL, notes TEXT NOT NULL, progress_manual REAL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, duration_minutes REAL, progress REAL NOT NULL, progress_manual REAL, status TEXT NOT NULL, order_index REAL NOT NULL, milestone INTEGER NOT NULL, notes TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dependencies (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, predecessor_task_id TEXT NOT NULL, successor_task_id TEXT NOT NULL, type TEXT NOT NULL, lag_minutes REAL NOT NULL, propagate INTEGER NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calendar_events (
 id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, title TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, all_day INTEGER NOT NULL, kind TEXT NOT NULL, rrule TEXT, "override" TEXT, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
 id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, trigger_at INTEGER NOT NULL, message_key TEXT NOT NULL, params TEXT NOT NULL, offset_minutes REAL NOT NULL, fired_at INTEGER, snoozed_to INTEGER, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(trigger_at) WHERE fired_at IS NULL AND deleted_at IS NULL AND snoozed_to IS NULL;
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS events_calendar ON calendar_events(calendar_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS change_log (
 id TEXT PRIMARY KEY, "table" TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL, payload TEXT NOT NULL, "before" TEXT, ts INTEGER NOT NULL, device_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_log_order ON change_log(ts, id);
