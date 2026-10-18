use crate::model::{self, Change, Result, Settings, Snapshot, TABLES};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{Map, Value};
use std::{
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub struct Database {
    connection: Mutex<Connection>,
    pub device_id: String,
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(error)?;
        connection
            .busy_timeout(Duration::from_secs(10))
            .map_err(error)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
            .map_err(error)?;
        // The SQL plugin runs the versioned migration before application setup. This also
        // makes direct database tests and recovery from an interrupted initial setup safe.
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .map_err(error)?;
        let device_id: Option<String> = connection
            .query_row(
                "SELECT value FROM settings WHERE key='_device_id'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(error)?;
        let device_id = match device_id {
            Some(id) => serde_json::from_str(&id).map_err(error)?,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                connection
                    .execute(
                        "INSERT INTO settings(key,value) VALUES('_device_id',?1)",
                        [serde_json::to_string(&id).map_err(error)?],
                    )
                    .map_err(error)?;
                id
            }
        };
        Ok(Self {
            connection: Mutex::new(connection),
            device_id,
        })
    }
    pub fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| "Database lock poisoned".into())
    }
    pub fn settings(&self) -> Result<Settings> {
        let connection = self.lock()?;
        read_settings(&connection)
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(error)?;
        let snapshot = read_snapshot(&tx)?;
        tx.commit().map_err(error)?;
        Ok(snapshot)
    }
    pub fn changes(&self) -> Result<Vec<Change>> {
        let connection = self.lock()?;
        let mut query = connection.prepare("SELECT id,\"table\",row_id,op,payload,\"before\",ts,device_id FROM change_log ORDER BY ts,id").map_err(error)?;
        let records = query
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, String>(7)?,
                ))
            })
            .map_err(error)?;
        let mut changes = Vec::new();
        for row in records {
            let (id, table, row_id, op, payload, before, ts, device_id) = row.map_err(error)?;
            changes.push(Change {
                id,
                table,
                row_id,
                op,
                payload: serde_json::from_str(&payload).map_err(error)?,
                before: before
                    .map(|s| serde_json::from_str(&s))
                    .transpose()
                    .map_err(error)?
                    .unwrap_or(Value::Null),
                ts,
                device_id,
            });
        }
        Ok(changes)
    }
    pub fn commit(
        &self,
        changes: &[Change],
        settings: Option<&Settings>,
        apply_settings: impl Fn(&Settings) -> Result<()>,
    ) -> Result<()> {
        if changes.len() > 100000 {
            return Err("Too many changes".into());
        }
        for change in changes {
            model::validate_change(change)?;
        }
        if let Some(settings) = settings {
            settings.validate()?;
        }
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let previous = read_settings(&tx)?;
        let mut settings_changes = 0;
        for change in changes {
            if change.table == "settings" {
                settings_changes += 1;
                if change.before != serde_json::to_value(&previous).map_err(error)? {
                    return Err("Settings changed concurrently; reload and retry".into());
                }
                if settings
                    .map(serde_json::to_value)
                    .transpose()
                    .map_err(error)?
                    .as_ref()
                    != Some(&change.payload)
                {
                    return Err("Settings change does not match settings argument".into());
                }
            } else {
                let current = read_row(&tx, &change.table, &change.row_id)?;
                match &current {
                    None if change.before.is_null() => {}
                    Some(value)
                        if !change.before.is_null()
                            && value["version"] == change.before["version"] => {}
                    _ => {
                        return Err(format!(
                            "{} {} changed concurrently; reload and retry",
                            change.table, change.row_id
                        ))
                    }
                }
                let old_version = current
                    .as_ref()
                    .and_then(|v| v["version"].as_i64())
                    .unwrap_or(0);
                if change.payload["version"].as_i64() != Some(old_version + 1) {
                    return Err("Entity version must increment exactly once".into());
                }
                write_row(&tx, &change.table, &change.payload)?;
            }
            log_change(&tx, change)?;
        }
        if settings.is_some() && settings_changes != 1 {
            return Err("Settings require exactly one matching change-log entry".into());
        }
        if let Some(settings) = settings {
            write_settings(&tx, settings)?;
        }
        read_snapshot(&tx)?.validate()?;
        if let Some(settings) = settings {
            apply_settings(settings)?;
        }
        if let Err(e) = tx.commit() {
            if settings.is_some() {
                if let Err(restore) = apply_settings(&previous) {
                    return Err(format!(
                        "Commit failed: {e}; restoring autostart also failed: {restore}"
                    ));
                }
            }
            return Err(error(e));
        }
        Ok(())
    }
    pub fn import(
        &self,
        snapshot: &Snapshot,
        changes: &[Change],
        apply_settings: impl Fn(&Settings) -> Result<()>,
    ) -> Result<()> {
        snapshot.validate()?;
        for change in changes {
            model::validate_change(change)?;
        }
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let previous = read_snapshot(&tx)?;
        // Audit the actual replacement, not untrusted caller-supplied history.
        let timestamp = now();
        for table in TABLES {
            for row in previous.rows(table) {
                if !snapshot.rows(table).iter().any(|r| r["id"] == row["id"]) {
                    let mut tombstone = row.clone();
                    tombstone["deleted_at"] = timestamp.into();
                    tombstone["updated_at"] = timestamp.into();
                    tombstone["version"] = (row["version"].as_i64().unwrap() + 1).into();
                    log_change(
                        &tx,
                        &self.change(table, "delete", tombstone, row.clone(), timestamp),
                    )?;
                }
            }
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(error)?;
            for row in snapshot.rows(table) {
                write_row(&tx, table, row)?;
                let before = previous
                    .rows(table)
                    .iter()
                    .find(|old| old["id"] == row["id"])
                    .cloned()
                    .unwrap_or(Value::Null);
                log_change(
                    &tx,
                    &self.change(
                        table,
                        if row["deleted_at"].is_null() {
                            "upsert"
                        } else {
                            "delete"
                        },
                        row.clone(),
                        before,
                        timestamp,
                    ),
                )?;
            }
        }
        write_settings(&tx, &snapshot.settings)?;
        log_change(
            &tx,
            &Change {
                id: uuid::Uuid::now_v7().to_string(),
                table: "settings".into(),
                row_id: "settings".into(),
                op: "upsert".into(),
                payload: serde_json::to_value(&snapshot.settings).map_err(error)?,
                before: serde_json::to_value(&previous.settings).map_err(error)?,
                ts: timestamp,
                device_id: self.device_id.clone(),
            },
        )?;
        // Preserve supplied history without allowing existing audit entries to be replaced.
        for change in changes {
            let existing: Option<String> = tx
                .query_row(
                    "SELECT payload FROM change_log WHERE id=?1",
                    [&change.id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(error)?;
            if existing.is_none() {
                log_change(&tx, change)?;
            }
        }
        apply_settings(&snapshot.settings)?;
        if let Err(e) = tx.commit() {
            if let Err(restore) = apply_settings(&previous.settings) {
                return Err(format!(
                    "Import commit failed: {e}; restoring autostart also failed: {restore}"
                ));
            }
            return Err(error(e));
        }
        Ok(())
    }
    pub fn change(&self, table: &str, op: &str, payload: Value, before: Value, ts: i64) -> Change {
        Change {
            id: uuid::Uuid::now_v7().to_string(),
            table: table.into(),
            row_id: payload["id"].as_str().unwrap().into(),
            op: op.into(),
            payload,
            before,
            ts,
            device_id: self.device_id.clone(),
        }
    }
}
pub fn read_settings(connection: &Connection) -> Result<Settings> {
    let mut values = serde_json::to_value(Settings::default()).map_err(error)?;
    let mut statement = connection
        .prepare("SELECT key,value FROM settings WHERE key NOT LIKE '\\_%' ESCAPE '\\'")
        .map_err(error)?;
    for row in statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(error)?
    {
        let (key, value) = row.map_err(error)?;
        if values.get(&key).is_some() {
            values[&key] = serde_json::from_str(&value).map_err(error)?;
        }
    }
    let settings: Settings = serde_json::from_value(values).map_err(error)?;
    settings.validate()?;
    Ok(settings)
}
fn write_settings(connection: &Connection, settings: &Settings) -> Result<()> {
    for (key, value) in serde_json::to_value(settings)
        .map_err(error)?
        .as_object()
        .unwrap()
    {
        connection.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value.to_string()]).map_err(error)?;
    }
    Ok(())
}
pub fn read_snapshot(connection: &Connection) -> Result<Snapshot> {
    let mut result = Map::new();
    for table in TABLES {
        let mut statement = connection
            .prepare(&format!("SELECT payload FROM {table} ORDER BY id"))
            .map_err(error)?;
        let mut rows = Vec::new();
        for row in statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(error)?
        {
            rows.push(serde_json::from_str::<Value>(&row.map_err(error)?).map_err(error)?);
        }
        result.insert(table.into(), Value::Array(rows));
    }
    result.insert(
        "settings".into(),
        serde_json::to_value(read_settings(connection)?).map_err(error)?,
    );
    serde_json::from_value(Value::Object(result)).map_err(error)
}
fn read_row(connection: &Connection, table: &str, id: &str) -> Result<Option<Value>> {
    let payload: Option<String> = connection
        .query_row(
            &format!("SELECT payload FROM {table} WHERE id=?1"),
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(error)?;
    payload
        .map(|p| serde_json::from_str(&p).map_err(error))
        .transpose()
}
pub fn write_row(connection: &Connection, table: &str, row: &Value) -> Result<()> {
    model::validate_row(table, row)?;
    let object = row.as_object().ok_or("Entity must be an object")?;
    let mut keys = Vec::with_capacity(object.len() + 1);
    let mut values = Vec::with_capacity(object.len() + 1);
    for (key, value) in object {
        keys.push(format!("\"{key}\""));
        values.push(match value {
            Value::Null => rusqlite::types::Value::Null,
            Value::Bool(b) => i64::from(*b).into(),
            Value::Number(n) => {
                if let Some(i) = n.as_i64() {
                    i.into()
                } else {
                    n.as_f64().ok_or("Invalid number")?.into()
                }
            }
            Value::String(s) => s.clone().into(),
            _ => value.to_string().into(),
        });
    }
    keys.push("payload".into());
    values.push(row.to_string().into());
    let placeholders = vec!["?"; keys.len()].join(",");
    let assignments = keys
        .iter()
        .filter(|k| k.as_str() != "\"id\"")
        .map(|k| format!("{k}=excluded.{k}"))
        .collect::<Vec<_>>()
        .join(",");
    connection.execute(&format!("INSERT INTO {table} ({}) VALUES ({placeholders}) ON CONFLICT(id) DO UPDATE SET {assignments}", keys.join(",")), rusqlite::params_from_iter(values)).map_err(error)?;
    Ok(())
}
pub fn log_change(connection: &Connection, change: &Change) -> Result<()> {
    connection.execute("INSERT INTO change_log(id,\"table\",row_id,op,payload,\"before\",ts,device_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)", params![change.id,change.table,change.row_id,change.op,change.payload.to_string(),if change.before.is_null() { None } else { Some(change.before.to_string()) },change.ts,change.device_id]).map_err(error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn calendar() -> Value {
        serde_json::json!({"id":uuid::Uuid::now_v7().to_string(),"name":"Work","is_default":true,"version":1,"updated_at":now(),"deleted_at":null})
    }
    #[test]
    fn transaction_conflict_does_not_partially_write() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        let a = calendar();
        let b = calendar();
        let first = db.change("work_calendars", "upsert", a.clone(), Value::Null, now());
        db.commit(&[first], None, |_| Ok(())).unwrap();
        let new_row = db.change("work_calendars", "upsert", b, Value::Null, now());
        let conflict = db.change("work_calendars", "upsert", a, Value::Null, now());
        assert!(db.commit(&[new_row, conflict], None, |_| Ok(())).is_err());
        assert_eq!(db.snapshot().unwrap().work_calendars.len(), 1);
        assert_eq!(db.changes().unwrap().len(), 1);
    }
    #[test]
    fn sql_columns_match_payload() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        let row = calendar();
        db.commit(
            &[db.change("work_calendars", "upsert", row.clone(), Value::Null, now())],
            None,
            |_| Ok(()),
        )
        .unwrap();
        let connection = db.lock().unwrap();
        let (name, flag): (String, i64) = connection
            .query_row("SELECT name,is_default FROM work_calendars", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(name, "Work");
        assert_eq!(flag, 1);
    }
    #[test]
    fn failed_autostart_rolls_back_settings_and_log() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        let before = db.settings().unwrap();
        let mut after = before.clone();
        after.autostart = true;
        let change = Change {
            id: uuid::Uuid::now_v7().to_string(),
            table: "settings".into(),
            row_id: "settings".into(),
            op: "upsert".into(),
            payload: serde_json::to_value(&after).unwrap(),
            before: serde_json::to_value(&before).unwrap(),
            ts: now(),
            device_id: db.device_id.clone(),
        };
        assert!(db
            .commit(&[change], Some(&after), |_| Err(
                "OS registration refused".into()
            ))
            .is_err());
        assert!(!db.settings().unwrap().autostart);
        assert!(db.changes().unwrap().is_empty());
    }
    #[test]
    fn failed_import_does_not_destroy_previous_rows() {
        let db = Database::open(Path::new(":memory:")).unwrap();
        let row = calendar();
        db.commit(
            &[db.change("work_calendars", "upsert", row.clone(), Value::Null, now())],
            None,
            |_| Ok(()),
        )
        .unwrap();
        let mut snapshot = model::empty_snapshot();
        snapshot.work_calendars.push(calendar());
        assert!(db
            .import(&snapshot, &[], |_| Err("Settings rejected".into()))
            .is_err());
        assert_eq!(db.snapshot().unwrap().work_calendars, vec![row]);
        assert_eq!(db.changes().unwrap().len(), 1);
    }
}
