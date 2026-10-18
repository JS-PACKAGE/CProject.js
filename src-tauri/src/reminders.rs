use crate::{
    db::{self, Database},
    model::{Result, Settings},
    RuntimeState,
};
use rusqlite::TransactionBehavior;
use serde_json::Value;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

pub fn text(language: &str, key: &str, params: &Value) -> String {
    let template = match (language, key) {
        ("zh-TW", "reminder.project") => "專案「{{name}}」即將截止。",
        ("zh-TW", "reminder.task") => "任務「{{name}}」即將到期。",
        ("zh-TW", "reminder.event") => "活動「{{name}}」即將開始。",
        ("zh-TW", _) => "提醒：{{name}}",
        ("ja", "reminder.project") => "プロジェクト「{{name}}」の締め切りが近づいています。",
        ("ja", "reminder.task") => "タスク「{{name}}」の期限が近づいています。",
        ("ja", "reminder.event") => "予定「{{name}}」がまもなく始まります。",
        ("ja", _) => "リマインダー：{{name}}",
        (_, "reminder.project") => "Project “{{name}}” is approaching its deadline.",
        (_, "reminder.task") => "Task “{{name}}” is due soon.",
        (_, "reminder.event") => "Event “{{name}}” starts soon.",
        _ => "Reminder: {{name}}",
    };
    let mut body = template.to_string();
    if let Some(values) = params.as_object() {
        for (key, value) in values {
            if let Some(value) = value.as_str() {
                body = body.replace(&format!("{{{{{key}}}}}"), value);
            }
        }
    }
    body.replace(
        "{{name}}",
        params["message"]
            .as_str()
            .or_else(|| params["title"].as_str())
            .unwrap_or("CProject"),
    )
}
pub(crate) fn notify(app: &AppHandle, settings: &Settings, row: &Value) -> Result<()> {
    let title = match settings.language.as_str() {
        "zh-TW" => "CProject 提醒",
        "ja" => "CProject リマインダー",
        _ => "CProject reminder",
    };
    let mut notification = app.notification().builder().title(title).body(text(
        &settings.language,
        row["message_key"].as_str().unwrap_or("reminder.custom"),
        &row["params"],
    ));
    if settings.notification_sound {
        notification = notification.sound(if cfg!(windows) { "Default" } else { "default" });
    }
    notification.show().map_err(|e| e.to_string())
}
pub fn tick(app: &AppHandle) -> Result<()> {
    let runtime = app.state::<RuntimeState>();
    if runtime.paused.load(Ordering::Relaxed) {
        return Ok(());
    }
    let database = app.state::<Database>();
    let mut connection = database.lock()?;
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let settings = db::read_settings(&tx)?;
    let timestamp = db::now();
    let rows = {
        let mut statement = tx.prepare("SELECT payload FROM reminders WHERE trigger_at<=?1 AND fired_at IS NULL AND snoozed_to IS NULL AND deleted_at IS NULL ORDER BY trigger_at,id LIMIT 100").map_err(|e| e.to_string())?;
        let mut rows = Vec::new();
        for row in statement
            .query_map([timestamp], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            rows.push(
                serde_json::from_str::<Value>(&row.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
        rows
    };
    let mut fired = Vec::new();
    for before in rows {
        // Keep the write lock while dispatching so a racing snooze/edit cannot fire stale data.
        // A crash between OS dispatch and commit can redeliver: at-least-once is intentional.
        if let Err(error) = notify(app, &settings, &before) {
            eprintln!("Notification dispatch failed: {error}");
            continue;
        }
        let mut after = before.clone();
        after["fired_at"] = timestamp.into();
        after["updated_at"] = timestamp.into();
        after["version"] = (before["version"]
            .as_i64()
            .ok_or("Invalid reminder version")?
            + 1)
        .into();
        db::write_row(&tx, "reminders", &after)?;
        let change = database.change("reminders", "upsert", after, before, timestamp);
        fired.push(change.row_id.clone());
        db::log_change(&tx, &change)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(connection);
    if !fired.is_empty() {
        app.emit("reminders-changed", &fired)
            .map_err(|e| e.to_string())?;
        for id in fired {
            app.emit("reminder-fired", id).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn languages_are_dynamic() {
        let params = serde_json::json!({"name":"Release"});
        assert!(text("en", "reminder.task", &params).contains("due soon"));
        assert!(text("ja", "reminder.task", &params).contains("期限"));
        assert!(text("zh-TW", "reminder.task", &params).contains("到期"));
    }
}
