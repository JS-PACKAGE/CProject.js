import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  ChartGantt,
  FolderKanban,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sun,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Snapshot } from "./core/types";
import { app, isDesktop } from "./data/app";
import { Editor } from "./components/Editor";
import { Projects, Timeline, ExtendDialog } from "./features/Projects";
import { Calendar } from "./features/Calendar";
import { Reminders, Settings, SyncAccess } from "./features/Settings";
import { sync } from "./sync/client";
import { useUI, type View } from "./features/ui";
import "./i18n";
import { toggleTheme, useTheme } from "./theme";
const navigation: { view: View; icon: LucideIcon }[] = [
  { view: "projects", icon: FolderKanban },
  { view: "calendar", icon: CalendarDays },
  { view: "timeline", icon: ChartGantt },
  { view: "reminders", icon: Bell },
  { view: "settings", icon: SettingsIcon },
];
function ThemeToggle() {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const label = t(theme === "dark" ? "switchToLight" : "switchToDark");
  return (
    <button className="quiet icon-button theme-toggle" onClick={toggleTheme} title={label} aria-label={label}>
      {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}
export default function App() {
  const { t, i18n } = useTranslation();
  const { view, editor, extension, set } = useUI();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);
  const [syncState, setSyncState] = useState(sync.getState);
  const [initialized, setInitialized] = useState(false);
  const identity = `${syncState.mode}:${syncState.serverUrl}:${syncState.user?.id ?? ""}`;
  const snapshotIdentity = useRef("");
  async function run(action: () => Promise<unknown>) {
    setPending((n) => n + 1);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending((n) => n - 1);
    }
  }
  useEffect(() => {
    let active = true;
    let currentIdentity = "";
    const unsubscribeSync = sync.subscribe((state) => {
      const nextIdentity = `${state.mode}:${state.serverUrl}:${state.user?.id ?? ""}`;
      if (nextIdentity !== currentIdentity) {
        currentIdentity = nextIdentity;
        snapshotIdentity.current = "";
        setSnapshot(null);
        setError("");
        set({ editor: null, extension: null, selected: null, query: "" });
      }
      setSyncState(state);
    });
    const unsubscribeApp = app.subscribe((value) => {
      const state = sync.getState();
      if (state.phase === "starting" || state.phase === "signed_out" ||
          (state.mode === "server" && !state.user)) return;
      snapshotIdentity.current = `${state.mode}:${state.serverUrl}:${state.user?.id ?? ""}`;
      setSnapshot(value);
    });
    void run(async () => {
      await sync.initialize();
      if (active) setInitialized(true);
    });
    return () => {
      active = false;
      unsubscribeSync();
      unsubscribeApp();
    };
  }, [set]);
  useEffect(() => {
    if (!initialized || syncState.phase !== "ready" || snapshotIdentity.current === identity) return;
    let active = true;
    void run(async () => {
      const value = await app.load();
      if (active) {
        snapshotIdentity.current = identity;
        setSnapshot(value);
      }
    });
    return () => { active = false; };
  }, [initialized, identity, syncState.phase]);
  useEffect(() => {
    if (snapshot) {
      void i18n.changeLanguage(snapshot.settings.language);
      document.documentElement.lang = snapshot.settings.language;
    }
  }, [snapshot?.settings.language, i18n]);
  const date = new Intl.DateTimeFormat(i18n.language, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const canShowWorkspace = syncState.phase !== "starting" && syncState.phase !== "signed_out" &&
    (syncState.mode === "local" || !!syncState.user);
  if (!canShowWorkspace) {
    return (
      <div className="login-shell">
        <ThemeToggle />
        <section className="panel login-panel">
          <h1>CProject</h1>
          <p className="muted">{t("tagline")}</p>
          {syncState.phase === "starting" ? <p role="status">{t("loading")}</p> :
            <SyncAccess state={syncState} run={run} />}
          {error && error !== syncState.error && <p className="error" role="alert">{error}</p>}
        </section>
      </div>
    );
  }
  const visibleSnapshot = snapshotIdentity.current === identity ? snapshot : null;
  const mutationsDisabled = syncState.busy ||
    (syncState.mode === "server" && syncState.phase !== "ready");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            set({ view: "projects" });
          }}
        >
          <span className="brand-mark">
            C<span>·</span>
          </span>
          <span>
            CProject<small>CALENDAR + PROJECT</small>
          </span>
        </a>
        <div className="nav-label">{t("overview")}</div>
        <nav aria-label={t("overview")}>
          {navigation.map((item) => (
            <button
              key={item.view}
              aria-current={view === item.view ? "page" : undefined}
              className={view === item.view ? "active" : ""}
              onClick={() => set({ view: item.view })}
            >
              <item.icon size={20} />
              {t(item.view)}
              {item.view === "reminders" && snapshot && (
                <small>
                  {snapshot.reminders.filter((r) => !r.fired_at).length}
                </small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="connection-dot" />
          {t("workspace")}
          <small>v0.1.0</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span className="eyebrow">{date.format(Date.now())}</span>
            <h1>{t(view)}</h1>
          </div>
          <div className="header-actions">
            {pending > 0 && (
              <span
                role="status"
                className="saving-dot"
                aria-label={t("loading")}
              />
            )}
            <ThemeToggle />
            <button
              className="quiet icon-button"
              disabled={mutationsDisabled}
              onClick={() => void run(() => app.undo())}
              title={t("undo")}
              aria-label={t("undo")}
            >
              <Undo2 size={20} />
            </button>
            <button
              className="primary"
              disabled={mutationsDisabled}
              onClick={() =>
                set({
                  editor: {
                    table:
                      view === "calendar"
                        ? "calendar_events"
                        : view === "reminders"
                          ? "reminders"
                          : "projects",
                  },
                })
              }
            >
              <Plus size={16} />
              {t(
                view === "calendar"
                  ? "newEvent"
                  : view === "reminders"
                    ? "customReminder"
                    : "newProject",
              )}
            </button>
          </div>
        </header>
        {!isDesktop && syncState.mode === "local" && <div className="preview-banner">{t("preview")}</div>}
        {syncState.mode === "server" && (
          <div className="sync-banner" role="status">
            <span>{syncState.user?.username} · {t(`sync_${syncState.phase}`)}
              {syncState.lastSyncedAt && ` · ${t("lastSynced")}: ${new Intl.DateTimeFormat(i18n.language, { timeStyle: "short" }).format(syncState.lastSyncedAt)}`}
            </span>
            <button disabled={syncState.busy} onClick={() => void run(() => sync.refresh())}>{t("refresh")}</button>
            {syncState.error && <span className="error">{syncState.error}</span>}
          </div>
        )}
        {error && error !== syncState.error && (
          <div className="error global-error" role="alert">
            <span>
              {t("error")}: {error}
            </span>
            <button onClick={() => setError("")} aria-label={t("dismiss")}>
              <X size={18} />
            </button>
          </div>
        )}
        <div className="content" key={view} aria-busy={pending > 0}>
          {view === "settings" && <section className="panel sync-settings"><SyncAccess state={syncState} run={run} /></section>}
          {visibleSnapshot ? (
            <fieldset className="workspace-features" key={identity}
              disabled={mutationsDisabled}>
              {view === "projects" && (
                <Projects snapshot={visibleSnapshot} run={run} />
              )}
              {view === "calendar" && (
                <Calendar snapshot={visibleSnapshot} run={run} />
              )}
              {view === "timeline" && (
                <Timeline snapshot={visibleSnapshot} run={run} />
              )}
              {view === "reminders" && (
                <Reminders snapshot={visibleSnapshot} run={run} />
              )}
              {view === "settings" && (
                <Settings snapshot={visibleSnapshot} run={run} />
              )}
            </fieldset>
          ) : (
            <div className="empty-state">
              <span className="loading-ring" />
              <p>{t("loading")}</p>
              {error && (
                <button
                  onClick={() =>
                    void run(async () => setSnapshot(await app.load()))
                  }
                >
                  {t("retry")}
                </button>
              )}
            </div>
          )}
        </div>
      </main>
      {editor && visibleSnapshot && (
        <Editor
          key={`${editor.table}:${editor.value?.id ?? JSON.stringify(editor.defaults)}`}
          snapshot={visibleSnapshot}
          disabled={mutationsDisabled}
        />
      )}
      {extension && visibleSnapshot && <ExtendDialog run={run} disabled={mutationsDisabled} />}
    </div>
  );
}
