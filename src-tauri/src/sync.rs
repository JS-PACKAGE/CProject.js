//! Cloud reminder credentials live only in this process, never in the local database.
use crate::{db::{self, Database}, model::{self, Result, Snapshot}, reminders, RuntimeState};
use reqwest::{blocking::{Client, Response}, header::{HeaderValue, AUTHORIZATION}, StatusCode, Url};
use serde::Deserialize;
use serde_json::json;
use std::{io::Read, net::IpAddr, sync::{atomic::Ordering, Mutex}, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

const MAX_BODY: u64 = 10 * 1024 * 1024;

#[derive(Clone)]
struct Config {
    url: Url,
    authorization: HeaderValue,
}
#[derive(Default)]
struct Session {
    generation: u64,
    config: Option<Config>,
    expired: bool,
    last_error: Option<&'static str>,
}
pub struct SyncState {
    session: Mutex<Session>,
    client: Client,
}
impl SyncState {
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| "Cannot initialize reminder synchronization".to_string())?;
        Ok(Self { session: Mutex::new(Session::default()), client })
    }

    pub fn configure(&self, url: Option<String>, token: Option<String>) -> Result<()> {
        // Validate before replacing a working session, and never format token-bearing errors.
        let config = match (url, token) {
            (None, None) => None,
            (Some(url), Some(token)) => {
                let url = endpoint(&url)?;
                if token.is_empty() || token.len() > 4096 || token.bytes().any(|b| !b.is_ascii_graphic()) {
                    return Err("Invalid synchronization token".into());
                }
                let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
                    .map_err(|_| "Invalid synchronization token".to_string())?;
                authorization.set_sensitive(true);
                Some(Config { url, authorization })
            }
            _ => return Err("Synchronization requires both endpoint and token".into()),
        };
        let mut session = self.session.lock().map_err(|_| "Reminder synchronization unavailable")?;
        session.generation = session.generation.wrapping_add(1);
        session.config = config;
        session.expired = false;
        session.last_error = None;
        Ok(())
    }
}

fn endpoint(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "Invalid synchronization endpoint")?;
    let host = url.host_str().ok_or("Invalid synchronization endpoint")?;
    let loopback = host == "localhost"
        || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
        || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
    {
        return Err("Use an HTTPS server origin (HTTP is allowed only on loopback)".into());
    }
    Ok(url)
}

#[derive(Clone, Copy)]
enum Failure { Auth, Conflict, Request, Response, Notification, Settings }
impl Failure {
    fn message(self) -> &'static str {
        match self {
            Self::Auth => "Reminder session expired. Sign in again.",
            Self::Conflict => "Reminder changed on the server; it will be refreshed.",
            Self::Request => "Cannot reach the reminder server.",
            Self::Response => "The reminder server returned an invalid response.",
            Self::Notification => "Cannot dispatch a system reminder notification.",
            Self::Settings => "Cannot read local reminder preferences.",
        }
    }
}
fn response_json<T: serde::de::DeserializeOwned>(response: Response) -> std::result::Result<T, Failure> {
    match response.status() {
        StatusCode::UNAUTHORIZED => return Err(Failure::Auth),
        StatusCode::CONFLICT => return Err(Failure::Conflict),
        status if !status.is_success() => return Err(Failure::Request),
        _ => {}
    }
    if response.content_length().is_some_and(|length| length > MAX_BODY) {
        return Err(Failure::Response);
    }
    let mut bytes = Vec::new();
    response.take(MAX_BODY + 1).read_to_end(&mut bytes).map_err(|_| Failure::Response)?;
    if bytes.len() as u64 > MAX_BODY { return Err(Failure::Response); }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Response)
}
#[derive(Deserialize)]
struct Workspace { snapshot: Snapshot, revision: u64 }
#[derive(Deserialize)]
struct Marked { revision: u64 }

fn current(session: &Session, generation: u64) -> bool {
    session.generation == generation && session.config.is_some() && !session.expired
}
fn report(app: &AppHandle, state: &SyncState, generation: u64, failure: Option<Failure>) -> Result<()> {
    let mut session = state.session.lock().map_err(|_| "Reminder synchronization unavailable")?;
    if !current(&session, generation) { return Ok(()); }
    let message = failure.map(Failure::message);
    if matches!(failure, Some(Failure::Auth)) { session.expired = true; }
    if session.last_error != message {
        session.last_error = message;
        if let Some(message) = message {
            app.emit("sync-error", message).map_err(|_| "Cannot report reminder synchronization error")?;
        }
    }
    Ok(())
}

pub fn tick(app: &AppHandle) -> Result<()> {
    let state = app.state::<SyncState>();
    let session = state.session.lock().map_err(|_| "Reminder synchronization unavailable")?;
    if session.config.is_none() {
        // Serialize local dispatch with mode switching; this branch never performs network I/O.
        return reminders::tick(app);
    }
    if session.expired || app.state::<RuntimeState>().paused.load(Ordering::Relaxed) {
        return Ok(());
    }
    let generation = session.generation;
    let config = session.config.clone().ok_or("Missing reminder synchronization configuration")?;
    drop(session);
    let result = cloud_tick(app, &state, generation, &config);
    report(app, &state, generation, result.err())
}

fn cloud_tick(app: &AppHandle, state: &SyncState, generation: u64, config: &Config) -> std::result::Result<(), Failure> {
    let response = state.client.get(config.url.join("api/workspace").map_err(|_| Failure::Request)?)
        .header(AUTHORIZATION, config.authorization.clone()).send().map_err(|_| Failure::Request)?;
    let workspace: Workspace = response_json(response)?;
    let _revision = workspace.revision;
    let snapshot = workspace.snapshot;
    snapshot.settings.validate().map_err(|_| Failure::Response)?;
    for row in &snapshot.reminders {
        model::validate_row("reminders", row).map_err(|_| Failure::Response)?;
    }
    // Read device preferences briefly, before any network requests or notifications.
    let database = app.state::<Database>();
    let mut settings = database.settings().map_err(|_| Failure::Settings)?;
    settings.language = snapshot.settings.language;
    let timestamp = db::now();
    let mut due: Vec<_> = snapshot.reminders.iter().filter(|row| due(row, timestamp)).collect();
    due.sort_unstable_by(|a, b| a["trigger_at"].as_i64().cmp(&b["trigger_at"].as_i64()).then_with(|| a["id"].as_str().cmp(&b["id"].as_str())));
    for row in due.into_iter().take(100) {
        {
            // Logout waits only for OS dispatch, never for an HTTP request. An old in-flight
            // fetch cannot dispatch after logout or a switch to another account completes.
            let session = state.session.lock().map_err(|_| Failure::Request)?;
            if !current(&session, generation) { return Ok(()); }
            if app.state::<RuntimeState>().paused.load(Ordering::Relaxed) { return Ok(()); }
            reminders::notify(app, &settings, row).map_err(|_| Failure::Notification)?;
        }
        // Dispatch then CAS mark: interruption may redeliver (intentional at-least-once).
        let response = state.client.post(config.url.join("api/reminders/fired").map_err(|_| Failure::Request)?)
            .header(AUTHORIZATION, config.authorization.clone())
            .json(&json!({"id": row["id"], "version": row["version"], "fired_at": timestamp, "device_id": database.device_id}))
            .send().map_err(|_| Failure::Request)?;
        match response_json::<Marked>(response) {
            Ok(marked) => {
                let _revision = marked.revision;
                let session = state.session.lock().map_err(|_| Failure::Request)?;
                if !current(&session, generation) { return Ok(()); }
                app.emit("reminders-changed", vec![&row["id"]]).map_err(|_| Failure::Request)?;
                app.emit("reminder-fired", &row["id"]).map_err(|_| Failure::Request)?;
            }
            // Another device/edit won the optimistic version; never overwrite it.
            Err(Failure::Conflict) => continue,
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
fn due(row: &serde_json::Value, timestamp: i64) -> bool {
    row["trigger_at"].as_i64().is_some_and(|at| at <= timestamp)
        && row["fired_at"].is_null() && row["snoozed_to"].is_null() && row["deleted_at"].is_null()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_requires_secure_origin() {
        for value in ["https://example.com", "https://example.com:8443/", "http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"] {
            assert!(endpoint(value).is_ok(), "{value}");
        }
        for value in ["http://example.com", "http://localhost.example.com", "https://user:secret@example.com", "https://example.com/path", "https://example.com/?token=secret", "https://example.com/#fragment", "file:///tmp/api"] {
            assert!(endpoint(value).is_err(), "{value}");
        }
    }
    #[test]
    fn reminder_due_filters_terminal_states() {
        let row = json!({"trigger_at":10,"fired_at":null,"snoozed_to":null,"deleted_at":null});
        assert!(due(&row, 10));
        assert!(!due(&row, 9));
        for field in ["fired_at", "snoozed_to", "deleted_at"] {
            let mut changed = row.clone();
            changed[field] = 10.into();
            assert!(!due(&changed, 20));
        }
    }
    #[test]
    fn session_generation_and_expiry_cancel_dispatch() {
        let config = Config { url: endpoint("https://example.com").unwrap(), authorization: HeaderValue::from_static("Bearer test") };
        let mut session = Session { generation: 3, config: Some(config), ..Session::default() };
        assert!(current(&session, 3));
        assert!(!current(&session, 2));
        session.expired = true;
        assert!(!current(&session, 3));
        session.expired = false;
        session.config = None;
        assert!(!current(&session, 3));
    }
}
