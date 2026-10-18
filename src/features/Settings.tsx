import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Language, Reminder } from "../core/types";
import { app, isDesktop } from "../data/app";
import { sync, type SyncState } from "../sync/client";
import { Dialog } from "../components/Editor";
import { useUI } from "./ui";
import { EntityActions, type ViewProps } from "./Projects";
export function Reminders({ snapshot, run }: ViewProps) {
  const { t, i18n } = useTranslation();
  const set = useUI((s) => s.set);
  const [snooze, setSnooze] = useState<Reminder | null>(null);
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{t("reminders")}</h2>
          <p className="muted">{t(isDesktop ? "reminderHint" : "webNotificationLimit")}</p>
        </div>
        <button
          className="primary"
          onClick={() => set({ editor: { table: "reminders" } })}
        >
          + {t("customReminder")}
        </button>
      </div>
      {[...snapshot.reminders]
        .sort(
          (a, b) =>
            (a.snoozed_to ?? a.trigger_at) - (b.snoozed_to ?? b.trigger_at),
        )
        .map((reminder) => {
          const name =
            snapshot.projects.find((p) => p.id === reminder.entity_id)?.name ??
            snapshot.tasks.find((task) => task.id === reminder.entity_id)
              ?.name ??
            snapshot.calendar_events.find((e) => e.id === reminder.entity_id)
              ?.title ??
            reminder.params.name ??
            "";
          const translated = t(reminder.message_key, {
            ...reminder.params,
            name,
            defaultValue: t("reminderTitle", { name }),
          });
          return (
            <div className="reminder-row" key={reminder.id}>
              <span
                className={`reminder-icon ${reminder.fired_at ? "muted" : ""}`}
              >
                {reminder.fired_at ? "✓" : "◷"}
              </span>
              <div>
                <strong>{translated}</strong>
                <small>
                  {format.format(reminder.snoozed_to ?? reminder.trigger_at)} ·{" "}
                  {t(reminder.fired_at ? "fired" : "upcoming")}
                </small>
              </div>
              <div className="toolbar">
                <button onClick={() => setSnooze(reminder)}>
                  {t("snooze")}
                </button>
                {reminder.entity_type === "custom" && (
                  <EntityActions table="reminders" value={reminder} run={run} />
                )}
              </div>
            </div>
          );
        })}
      {!snapshot.reminders.length && (
        <div className="empty-state">
          <span>◷</span>
          <p>{t("empty")}</p>
        </div>
      )}
      {snooze && (
        <Dialog title={t("snooze")} close={() => setSnooze(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const minutes = Number(
                new FormData(e.currentTarget).get("minutes"),
              );
              void run(async () => {
                await app.snooze(snooze.id, minutes);
                setSnooze(null);
              });
            }}
          >
            <label>
              {t("snoozeMinutes")}
              <input
                type="number"
                min="1"
                step="1"
                name="minutes"
                required
                defaultValue="10"
              />
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setSnooze(null)}>
                {t("cancel")}
              </button>
              <button className="primary">{t("save")}</button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
export function Settings({ snapshot, run }: ViewProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState("");
  const settings = snapshot.settings;
  async function exportFile() {
    const json = await app.exportJSON();
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t("exportName")}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="settings-layout">
      <section className="panel">
        <h2>{t("settings")}</h2>
        <p className="muted">{t(isDesktop ? "settingsHint" : "webNotificationLimit")}</p>
        <form
          key={JSON.stringify(settings)}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const raw = String(f.get("offsets")).trim();
            const offsets = raw
              ? raw.split(",").map((v) => Number(v.trim()))
              : [];
            if (offsets.some((v) => !Number.isInteger(v) || v < 0)) {
              setValidation(t("invalidOffsets"));
              return;
            }
            setValidation("");
            setBusy(true);
            void run(() =>
              app.updateSettings({
                language: String(f.get("language")) as Language,
                ...(isDesktop ? {
                  autostart: f.has("autostart"),
                  close_to_tray: f.has("close_to_tray"),
                  notification_sound: f.has("notification_sound"),
                } : {}),
                default_reminder_offsets: offsets,
              }),
            ).finally(() => setBusy(false));
          }}
        >
          <label>
            {t("language")}
            <select name="language" defaultValue={settings.language}>
              <option value="zh-TW">繁體中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
          </label>
          {isDesktop && (["autostart", "close_to_tray", "notification_sound"] as const).map(
            (key) => (
              <label className="check settings-toggle" key={key}>
                <input
                  name={key}
                  type="checkbox"
                  defaultChecked={settings[key]}
                />
                {t(key)}
              </label>
            ),
          )}
          <label>
            {t("offsets")}
            <input
              name="offsets"
              defaultValue={settings.default_reminder_offsets.join(", ")}
            />
          </label>
          {validation && (
            <p className="error" role="alert">
              {validation}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {t("save")}
          </button>
        </form>
      </section>
      <section className="panel">
        <h2>{t("data")}</h2>
        <p className="muted">{t("importWarning")}</p>
        <div className="data-actions">
          <button onClick={() => void run(exportFile)}>↓ {t("export")}</button>
          <label className="file-button">
            ↑ {t("import")}
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file && window.confirm(t("importConfirm")))
                  void run(async () => app.importJSON(await file.text()));
              }}
            />
          </label>
          <button onClick={() => void run(() => app.undo())}>
            ↶ {t("undo")}
          </button>
          <button onClick={() => void run(() => sync.refresh())}>
            ↻ {t("refresh")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function SyncAccess({ state, run }: {
  state: SyncState;
  run: ViewProps["run"];
}) {
  const { t, i18n } = useTranslation();
  const [endpoint, setEndpoint] = useState(state.serverUrl || window.location.origin);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  return (
    <div className="sync-access">
      <h2>{t("syncAccount")}</h2>
      {state.user ? (
        <>
          <p className="sync-identity"><strong>{state.user.username}</strong><br />{state.serverUrl}</p>
          <p role="status">{t(`sync_${state.phase}`)}
            {state.lastSyncedAt && ` · ${t("lastSynced")}: ${new Intl.DateTimeFormat(i18n.language, { dateStyle: "short", timeStyle: "short" }).format(state.lastSyncedAt)}`}
          </p>
          <div className="data-actions">
            <button disabled={state.busy} onClick={() => void run(() => sync.refresh())}>{t("refresh")}</button>
            <button disabled={state.busy} onClick={() => void run(() => sync.logout())}>{t("signOut")}</button>
            <button disabled={state.busy || state.phase !== "ready"} onClick={() => {
              if (window.confirm(t("uploadLocalConfirm"))) void run(() => sync.uploadLocal());
            }}>{t("uploadLocal")}</button>
          </div>
          <p className="muted">{t("uploadLocalHint")}</p>
        </>
      ) : (
        <>
          <p className="muted">{t("syncLoginHint")}</p>
          {!isDesktop && !state.hosted && <p className="muted">{t("webServerHint")}</p>}
          <form onSubmit={(event) => {
            event.preventDefault();
            const secret = password;
            setPassword("");
            void run(() => sync.login(isDesktop ? endpoint : window.location.origin, username.trim(), secret));
          }}>
            {isDesktop && <label>{t("serverUrl")}
              <input type="url" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://planner.example.com" autoComplete="url" />
            </label>}
            <label>{t("username")}
              <input required name="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} />
            </label>
            <label>{t("password")}
              <input required name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </label>
            <button className="primary" disabled={state.busy}>{t(state.busy ? "loading" : "signIn")}</button>
          </form>
        </>
      )}
      {state.error && <p className="error" role="alert">{state.error}</p>}
      {!state.hosted && state.mode === "server" && <button disabled={state.busy} onClick={() => void run(() => sync.useLocal())}>{t("useLocal")}</button>}
    </div>
  );
}
