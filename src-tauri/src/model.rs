use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

pub const TABLES: [&str; 8] = [
    "work_calendars",
    "weekday_rules",
    "calendar_exceptions",
    "projects",
    "tasks",
    "dependencies",
    "calendar_events",
    "reminders",
];
pub type Result<T, E = String> = std::result::Result<T, E>;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
    pub language: String,
    pub autostart: bool,
    pub close_to_tray: bool,
    pub notification_sound: bool,
    pub default_reminder_offsets: Vec<i64>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "zh-TW".into(),
            autostart: false,
            close_to_tray: true,
            notification_sound: true,
            default_reminder_offsets: vec![1440, 120],
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        choice(&self.language, &["zh-TW", "en", "ja"])?;
        if self.default_reminder_offsets.len() > 100
            || self
                .default_reminder_offsets
                .iter()
                .any(|n| *n < 0 || *n > 5256000)
        {
            return Err("Invalid reminder offsets".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub id: String,
    pub table: String,
    pub row_id: String,
    pub op: String,
    pub payload: Value,
    pub before: Value,
    pub ts: i64,
    pub device_id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub work_calendars: Vec<Value>,
    pub weekday_rules: Vec<Value>,
    pub calendar_exceptions: Vec<Value>,
    pub projects: Vec<Value>,
    pub tasks: Vec<Value>,
    pub dependencies: Vec<Value>,
    pub calendar_events: Vec<Value>,
    pub reminders: Vec<Value>,
    pub settings: Settings,
}
impl Snapshot {
    pub fn rows(&self, table: &str) -> &[Value] {
        match table {
            "work_calendars" => &self.work_calendars,
            "weekday_rules" => &self.weekday_rules,
            "calendar_exceptions" => &self.calendar_exceptions,
            "projects" => &self.projects,
            "tasks" => &self.tasks,
            "dependencies" => &self.dependencies,
            "calendar_events" => &self.calendar_events,
            "reminders" => &self.reminders,
            _ => &[],
        }
    }
    pub fn validate(&self) -> Result<()> {
        self.settings.validate()?;
        for table in TABLES {
            let mut seen = HashSet::new();
            for row in self.rows(table) {
                validate_row(table, row)?;
                if !seen.insert(row["id"].as_str().unwrap()) {
                    return Err(format!("Duplicate ID in {table}"));
                }
            }
        }
        // References to tombstones remain valid for synchronization and undo.
        let exists = |table: &str, id: &Value| self.rows(table).iter().any(|row| row["id"] == *id);
        for table in [
            "weekday_rules",
            "calendar_exceptions",
            "projects",
            "calendar_events",
        ] {
            for row in self.rows(table) {
                if !exists("work_calendars", &row["calendar_id"]) {
                    return Err("Unknown calendar".into());
                }
            }
        }
        for row in &self.tasks {
            if !exists("projects", &row["project_id"]) {
                return Err("Unknown task project".into());
            }
            if !row["parent_id"].is_null() {
                let parent = self
                    .tasks
                    .iter()
                    .find(|p| p["id"] == row["parent_id"])
                    .ok_or("Unknown parent task")?;
                if parent["project_id"] != row["project_id"]
                    || !parent["parent_id"].is_null()
                    || parent["id"] == row["id"]
                {
                    return Err("Invalid task hierarchy".into());
                }
            }
        }
        let mut graph: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for row in &self.dependencies {
            if !exists("projects", &row["project_id"]) {
                return Err("Unknown dependency project".into());
            }
            for key in ["predecessor_task_id", "successor_task_id"] {
                if !self
                    .tasks
                    .iter()
                    .any(|t| t["id"] == row[key] && t["project_id"] == row["project_id"])
                {
                    return Err("Unknown dependency task".into());
                }
            }
            if row["deleted_at"].is_null() {
                graph
                    .entry(row["predecessor_task_id"].as_str().unwrap())
                    .or_default()
                    .push(row["successor_task_id"].as_str().unwrap());
            }
        }
        fn visit<'a>(
            id: &'a str,
            graph: &BTreeMap<&'a str, Vec<&'a str>>,
            active: &mut HashSet<&'a str>,
            done: &mut HashSet<&'a str>,
        ) -> Result<()> {
            if done.contains(id) {
                return Ok(());
            }
            if !active.insert(id) {
                return Err("Dependency cycle".into());
            }
            if let Some(edges) = graph.get(id) {
                for next in edges {
                    visit(next, graph, active, done)?;
                }
            }
            active.remove(id);
            done.insert(id);
            Ok(())
        }
        let mut done = HashSet::new();
        for id in graph.keys() {
            visit(id, &graph, &mut HashSet::new(), &mut done)?;
        }
        for row in &self.calendar_events {
            if !row["override"].is_null() {
                let target = &row["override"];
                if !exists(
                    if target["target_type"] == "project" {
                        "projects"
                    } else {
                        "tasks"
                    },
                    &target["target_id"],
                ) {
                    return Err("Unknown override target".into());
                }
            }
        }
        for row in &self.reminders {
            let table = match row["entity_type"].as_str().unwrap() {
                "project" => "projects",
                "task" => "tasks",
                "event" => "calendar_events",
                _ => continue,
            };
            if !exists(table, &row["entity_id"]) {
                return Err("Unknown reminder target".into());
            }
        }
        Ok(())
    }
}

// Deserialization enforces field presence, JSON types, integer precision, and unknown-field rejection.
macro_rules! record {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        #[allow(dead_code)]
        struct $name { id: String, version: i64, updated_at: i64, deleted_at: Option<i64>, $($field: $ty),* }
    };
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct Segment {
    start: String,
    end: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct Override {
    target_type: String,
    target_id: String,
    mode: String,
    new_start: Option<i64>,
    new_end: Option<i64>,
}
record!(Calendar {
    name: String,
    is_default: bool
});
record!(Rule { calendar_id: String, weekday: u8, is_working: bool, segments: Vec<Segment> });
record!(Exception { calendar_id: String, date: String, kind: String, is_working: bool, segments: Option<Vec<Segment>>, note: String });
record!(Project { name: String, calendar_id: String, duration_mode: String, start_at: i64, end_at: i64, status: String, color: String, notes: String, progress_manual: Option<f64> });
record!(Task { project_id: String, parent_id: Option<String>, name: String, start_at: i64, end_at: i64, duration_minutes: Option<f64>, progress: f64, progress_manual: Option<f64>, status: String, order_index: f64, milestone: bool, notes: String });
record!(Dependency {
    project_id: String,
    predecessor_task_id: String,
    successor_task_id: String,
    r#type: String,
    lag_minutes: f64,
    propagate: bool
});
record!(Event { calendar_id: String, title: String, start_at: i64, end_at: i64, all_day: bool, kind: String, rrule: Option<String>, r#override: Option<Override> });
record!(Reminder { entity_type: String, entity_id: String, trigger_at: i64, message_key: String, params: BTreeMap<String, String>, offset_minutes: f64, fired_at: Option<i64>, snoozed_to: Option<i64> });

pub fn uuid(value: &str) -> Result<()> {
    let id = uuid::Uuid::parse_str(value).map_err(|_| "Invalid UUID")?;
    if id.get_version_num() != 7 {
        return Err("Expected UUIDv7".into());
    }
    Ok(())
}
fn choice(value: &str, values: &[&str]) -> Result<()> {
    if values.contains(&value) {
        Ok(())
    } else {
        Err(format!("Invalid value: {value}"))
    }
}
fn decode<T: serde::de::DeserializeOwned>(row: &Value) -> Result<()> {
    serde_json::from_value::<T>(row.clone())
        .map(|_| ())
        .map_err(|e| e.to_string())
}
pub fn validate_row(table: &str, row: &Value) -> Result<()> {
    match table {
        "work_calendars" => decode::<Calendar>(row)?,
        "weekday_rules" => decode::<Rule>(row)?,
        "calendar_exceptions" => decode::<Exception>(row)?,
        "projects" => decode::<Project>(row)?,
        "tasks" => decode::<Task>(row)?,
        "dependencies" => decode::<Dependency>(row)?,
        "calendar_events" => decode::<Event>(row)?,
        "reminders" => decode::<Reminder>(row)?,
        _ => return Err("Unknown table".into()),
    }
    uuid(row["id"].as_str().ok_or("Missing id")?)?;
    if !(1..=9_007_199_254_740_991).contains(&row["version"].as_i64().unwrap_or(0)) {
        return Err("Invalid entity version".into());
    }
    let nullable: &[&str] = match table {
        "calendar_exceptions" => &["deleted_at", "segments"],
        "projects" => &["deleted_at", "progress_manual"],
        "tasks" => &[
            "deleted_at",
            "parent_id",
            "duration_minutes",
            "progress_manual",
        ],
        "calendar_events" => &["deleted_at", "rrule", "override"],
        "reminders" => &["deleted_at", "fired_at", "snoozed_to"],
        _ => &["deleted_at"],
    };
    if nullable.iter().any(|key| row.get(*key).is_none()) {
        return Err("Missing nullable entity field".into());
    }
    for key in [
        "updated_at",
        "deleted_at",
        "start_at",
        "end_at",
        "trigger_at",
        "fired_at",
        "snoozed_to",
    ] {
        if let Some(n) = row.get(key).and_then(Value::as_i64) {
            if n.unsigned_abs() > 8_640_000_000_000_000 {
                return Err("Date outside supported range".into());
            }
        }
    }
    for key in [
        "calendar_id",
        "project_id",
        "parent_id",
        "predecessor_task_id",
        "successor_task_id",
        "entity_id",
    ] {
        if let Some(id) = row.get(key).and_then(Value::as_str) {
            uuid(id)?;
        }
    }
    if row.get("start_at").is_some() && row["end_at"].as_i64() < row["start_at"].as_i64() {
        return Err("End precedes start".into());
    }
    for key in ["progress", "progress_manual"] {
        if let Some(n) = row.get(key).and_then(Value::as_f64) {
            if !(0.0..=100.0).contains(&n) {
                return Err("Invalid progress".into());
            }
        }
    }
    if let Some(n) = row.get("duration_minutes").and_then(Value::as_f64) {
        if n < 0.0 {
            return Err("Negative duration".into());
        }
    }
    if let Some(status) = row.get("status").and_then(Value::as_str) {
        choice(
            status,
            &["planned", "active", "on_hold", "done", "archived"],
        )?;
    }
    if table == "projects" {
        choice(
            row["duration_mode"].as_str().unwrap(),
            &["working_hours", "full_days"],
        )?;
    }
    if table == "dependencies" {
        choice(row["type"].as_str().unwrap(), &["FS", "SS", "FF", "SF"])?;
    }
    if table == "weekday_rules" && row["weekday"].as_u64().unwrap() > 6 {
        return Err("Invalid weekday".into());
    }
    if table == "calendar_exceptions" {
        choice(
            row["kind"].as_str().unwrap(),
            &["holiday", "makeup_workday", "custom"],
        )?;
        chrono::NaiveDate::parse_from_str(row["date"].as_str().unwrap(), "%Y-%m-%d")
            .map_err(|_| "Invalid exception date")?;
    }
    if let Some(segments) = row.get("segments").and_then(Value::as_array) {
        let mut end = 0;
        for segment in segments {
            let time = |key: &str| -> Result<u32> {
                let text = segment[key].as_str().ok_or("Invalid segment")?;
                let (h, m) = text.split_once(':').ok_or("Invalid segment time")?;
                let h: u32 = h.parse().map_err(|_| "Invalid hours")?;
                let m: u32 = m.parse().map_err(|_| "Invalid minutes")?;
                if text.len() != 5 || h > 24 || m > 59 || (h == 24 && m != 0) {
                    return Err("Invalid segment time".into());
                }
                Ok(h * 60 + m)
            };
            let start = time("start")?;
            let next = time("end")?;
            if start < end || next <= start {
                return Err("Overlapping or invalid segments".into());
            }
            end = next;
        }
    }
    if table == "calendar_events" {
        choice(
            row["kind"].as_str().unwrap(),
            &["block", "leave", "meeting", "custom"],
        )?;
        if !row["override"].is_null() {
            let o = &row["override"];
            choice(o["target_type"].as_str().unwrap(), &["project", "task"])?;
            uuid(o["target_id"].as_str().unwrap())?;
            choice(o["mode"].as_str().unwrap(), &["exclude", "rewrite"])?;
            if o["mode"] == "rewrite"
                && (o["new_start"].as_i64().is_none()
                    || o["new_end"].as_i64().is_none()
                    || o["new_end"].as_i64() < o["new_start"].as_i64())
            {
                return Err("Invalid rewrite interval".into());
            }
        }
    }
    if table == "reminders" {
        choice(
            row["entity_type"].as_str().unwrap(),
            &["project", "task", "event", "custom"],
        )?;
    }
    Ok(())
}
pub fn validate_change(change: &Change) -> Result<()> {
    uuid(&change.id)?;
    uuid(&change.device_id)?;
    choice(&change.op, &["upsert", "delete"])?;
    if change.table == "settings" {
        let settings: Settings =
            serde_json::from_value(change.payload.clone()).map_err(|e| e.to_string())?;
        settings.validate()?;
    } else {
        uuid(&change.row_id)?;
        validate_row(&change.table, &change.payload)?;
        if change.payload["id"] != change.row_id {
            return Err("Change row ID mismatch".into());
        }
        if !change.before.is_null() {
            validate_row(&change.table, &change.before)?;
            if change.before["id"] != change.row_id {
                return Err("Before row ID mismatch".into());
            }
        }
        if change.op == "delete" && change.payload["deleted_at"].is_null() {
            return Err("Deletion must contain tombstone".into());
        }
    }
    Ok(())
}
#[cfg(test)]
pub fn empty_snapshot() -> Snapshot {
    serde_json::from_value(json!({"work_calendars":[],"weekday_rules":[],"calendar_exceptions":[],"projects":[],"tasks":[],"dependencies":[],"calendar_events":[],"reminders":[],"settings":Settings::default()})).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_table() {
        assert!(validate_row("tasks; DROP TABLE tasks", &json!({})).is_err());
    }
    #[test]
    fn rejects_bad_settings() {
        let mut s = Settings::default();
        s.language = "unknown".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn empty_snapshot_validates() {
        assert!(empty_snapshot().validate().is_ok());
    }
}
