import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type {
  CalendarEvent,
  Snapshot,
  TableName,
  Tables,
  Task,
} from "../core/types";
import { app } from "../data/app";
import { entity } from "../data/entity";
import { localDate, localInput, useUI } from "../features/ui";

export function Dialog({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = ref.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          type="button"
          onClick={close}
          aria-label={useTranslation().t("close")}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
const tableLabels: Record<TableName, string> = {
  projects: "project",
  tasks: "task",
  dependencies: "dependency",
  work_calendars: "workCalendar",
  weekday_rules: "rules",
  calendar_exceptions: "exception",
  calendar_events: "event",
  reminders: "customReminder",
};
export function Editor({ snapshot, disabled = false }: { snapshot: Snapshot; disabled?: boolean }) {
  const { t, i18n } = useTranslation();
  const { editor, set } = useUI();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const initial = { ...editor?.defaults, ...editor?.value } as Record<
    string,
    unknown
  >;
  const table = editor!.table;
  const now = Date.now();
  const [projectId, setProjectId] = useState(
    String(initial.project_id ?? snapshot.projects[0]?.id ?? ""),
  );
  const [targetType, setTargetType] = useState(
    (initial.override as CalendarEvent["override"])?.target_type ?? "project",
  );
  const [overrideMode, setOverrideMode] = useState(
    (initial.override as CalendarEvent["override"])?.mode ?? "",
  );
  const [freq, setFreq] = useState("");
  const project = snapshot.projects.find((p) => p.id === projectId);
  const mode = project?.duration_mode ?? "working_hours";
  const defaultCalendar =
    snapshot.work_calendars.find((c) => c.is_default)?.id ??
    snapshot.work_calendars[0]?.id ??
    "";
  function text(
    name: string,
    label = name,
    type = "text",
    fallback: unknown = "",
    options: {
      required?: boolean;
      min?: number;
      max?: number;
      step?: string;
    } = {},
  ) {
    const value = initial[name] ?? fallback;
    return (
      <label className={type === "checkbox" ? "check" : ""}>
        {type === "checkbox" ? (
          <>
            <input
              type="checkbox"
              name={name}
              defaultChecked={Boolean(value)}
            />
            {t(label)}
          </>
        ) : (
          <>
            {t(label)}
            <input
              name={name}
              type={type}
              defaultValue={String(value)}
              {...options}
            />
          </>
        )}
      </label>
    );
  }
  function select(
    name: string,
    label: string,
    values: { value: string; label: string }[],
    fallback = "",
    onChange?: (value: string) => void,
  ) {
    return (
      <label>
        {t(label)}
        <select
          required={name !== "parent_id"}
          name={name}
          defaultValue={String(initial[name] ?? fallback)}
          onChange={(e) => onChange?.(e.target.value)}
        >
          {values.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  const choices = (keys: string[]) =>
    keys.map((value) => ({ value, label: t(value) }));
  const calendars = snapshot.work_calendars.map((c) => ({
    value: c.id,
    label: c.name,
  }));
  const projectChoices = snapshot.projects.map((p) => ({
    value: p.id,
    label: p.name,
  }));
  // Datetime inputs use local wall-clock values; persistence uses UTC timestamps.
  for (const key of ["start_at", "end_at", "trigger_at"])
    if (typeof initial[key] === "number")
      initial[key] = localInput(initial[key] as number);
  if (
    table === "tasks" &&
    initial.duration_minutes != null &&
    mode === "full_days"
  )
    initial.duration_minutes = Number(initial.duration_minutes) / 1440;
  if (Array.isArray(initial.segments))
    initial.segments = (initial.segments as { start: string; end: string }[])
      .map((p) => `${p.start}-${p.end}`)
      .join(",");
  const taskChoices = snapshot.tasks
    .filter((task) => task.project_id === projectId)
    .map((task) => ({ value: task.id, label: task.name }));
  const dates = (
    <div className="form-grid">
      {text("start_at", "start", "datetime-local", localInput(now), {
        required: true,
      })}
      {text("end_at", "end", "datetime-local", localInput(now + 3600000), {
        required: true,
      })}
    </div>
  );
  const status = select(
    "status",
    "status",
    choices(["planned", "active", "on_hold", "done", "archived"]),
    "planned",
  );
  const progress = text("progress_manual", "progress_manual", "number", "", {
    min: 0,
    max: 100,
  });
  const notes = (
    <label>
      {t("notes")}
      <textarea
        name="notes"
        defaultValue={String(initial.notes ?? "")}
        rows={3}
      />
    </label>
  );
  function segments() {
    return text("segments", "segments", "text", "09:00-12:00,13:00-18:00");
  }
  async function submit(form: HTMLFormElement) {
    if (disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      const f = new FormData(form);
      const str = (key: string) => String(f.get(key) ?? "").trim();
      const num = (key: string) => Number(str(key));
      const bool = (key: string) => f.has(key);
      const time = (key: string) => new Date(str(key)).getTime();
      const nullable = (key: string) => (str(key) === "" ? null : num(key));
      const base = editor?.value ?? entity();
      let value: Tables[TableName];
      const datesValue = { start_at: time("start_at"), end_at: time("end_at") };
      const common = {
        name: str("name"),
        status: str("status") as Task["status"],
        notes: str("notes"),
        progress_manual: nullable("progress_manual"),
      };
      function parsedSegments() {
        if (!str("segments")) return [];
        return str("segments")
          .split(",")
          .map((part) => {
            const match =
              /^\s*([0-2]\d:[0-5]\d)\s*-\s*([0-2]\d:[0-5]\d)\s*$/.exec(part);
            if (
              !match ||
              match[1]! >= match[2]! ||
              match[1]! > "23:59" ||
              match[2]! > "24:00"
            )
              throw new Error(t("invalidSegments"));
            return { start: match[1]!, end: match[2]! };
          });
      }
      switch (table) {
        case "projects":
          value = {
            ...base,
            ...common,
            ...datesValue,
            calendar_id: str("calendar_id"),
            duration_mode: str("duration_mode") as
              "working_hours" | "full_days",
            color: str("color"),
          };
          break;
        case "tasks":
          value = {
            ...base,
            ...common,
            ...datesValue,
            project_id: projectId,
            parent_id: str("parent_id") || null,
            duration_minutes:
              nullable("duration_minutes") === null
                ? null
                : num("duration_minutes") * (mode === "full_days" ? 1440 : 1),
            progress: num("progress"),
            order_index: num("order_index"),
            milestone: bool("milestone"),
          };
          break;
        case "dependencies":
          value = {
            ...base,
            project_id: projectId,
            predecessor_task_id: str("predecessor_task_id"),
            successor_task_id: str("successor_task_id"),
            type: "FS",
            lag_minutes: num("lag_minutes"),
            propagate: bool("propagate"),
          };
          break;
        case "work_calendars":
          value = {
            ...base,
            name: str("name"),
            is_default: bool("is_default"),
          };
          break;
        case "weekday_rules":
          value = {
            ...base,
            calendar_id: str("calendar_id"),
            weekday: num("weekday"),
            is_working: bool("is_working"),
            segments: parsedSegments(),
          };
          break;
        case "calendar_exceptions":
          value = {
            ...base,
            calendar_id: str("calendar_id"),
            date: str("date"),
            kind: str("kind") as "holiday" | "makeup_workday" | "custom",
            is_working: bool("is_working"),
            segments: str("segments") ? parsedSegments() : null,
            note: str("note"),
          };
          break;
        case "calendar_events": {
          let rrule = str("rrule") || null;
          if (!rrule && freq) {
            rrule = `FREQ=${freq};INTERVAL=${num("interval") || 1}`;
            if (str("count")) rrule += `;COUNT=${num("count")}`;
            if (str("until"))
              rrule += `;UNTIL=${str("until").replaceAll("-", "")}T235959`;
            if (str("byday")) rrule += `;BYDAY=${str("byday").toUpperCase()}`;
          }
          value = {
            ...base,
            ...datesValue,
            calendar_id: str("calendar_id"),
            title: str("title"),
            all_day: bool("all_day"),
            kind: str("kind") as CalendarEvent["kind"],
            rrule,
            override: overrideMode
              ? {
                  mode: overrideMode as "exclude" | "rewrite",
                  target_type: targetType,
                  target_id: str("target_id"),
                  ...(overrideMode === "rewrite"
                    ? { new_start: time("new_start"), new_end: time("new_end") }
                    : {}),
                }
              : null,
          };
          break;
        }
        case "reminders":
          value = {
            ...base,
            entity_type: "custom",
            entity_id: base.id,
            trigger_at: time("trigger_at"),
            message_key: "reminder.custom",
            params: { name: str("message") },
            offset_minutes: 0,
            fired_at: null,
            snoozed_to: null,
          };
          break;
      }
      if (
        "start_at" in value &&
        (!Number.isFinite(value.start_at) ||
          !Number.isFinite(value.end_at) ||
          value.end_at < value.start_at)
      )
        throw new Error(t("invalidDates"));
      await app.save(table, value);
      set({ editor: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const originalOverride = (editor?.value as CalendarEvent | undefined)
    ?.override;
  return (
    <Dialog
      title={`${t(editor?.value ? "edit" : "add")} · ${t(tableLabels[table])}`}
      close={() => !busy && set({ editor: null })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget);
        }}
      >
        {error && (
          <div role="alert" className="error">
            {t("error")}: {error}
          </div>
        )}
        {(table === "projects" ||
          table === "tasks" ||
          table === "work_calendars") &&
          text("name", "name", "text", "", { required: true })}
        {(table === "projects" ||
          table === "calendar_events" ||
          table === "weekday_rules" ||
          table === "calendar_exceptions") &&
          select("calendar_id", "workCalendar", calendars, defaultCalendar)}
        {(table === "tasks" || table === "dependencies") &&
          select(
            "project_id",
            "project",
            projectChoices,
            projectId,
            setProjectId,
          )}
        {table === "projects" && (
          <>
            {dates}
            {select(
              "duration_mode",
              "duration_mode",
              choices(["working_hours", "full_days"]),
              "working_hours",
            )}
            <div className="form-grid">
              {status}
              {text("color", "color", "color", "#6c63e8")}
            </div>
            {progress}
            {notes}
          </>
        )}
        {table === "tasks" && (
          <>
            {select("parent_id", "parent", [
              { value: "", label: t("none") },
              ...snapshot.tasks
                .filter(
                  (task) =>
                    task.project_id === projectId &&
                    !task.parent_id &&
                    task.id !== editor?.value?.id &&
                    !snapshot.tasks.some(
                      (child) => child.parent_id === editor?.value?.id,
                    ),
                )
                .map((task) => ({ value: task.id, label: task.name })),
            ])}
            {dates}
            <div className="form-grid">
              {text(
                "duration_minutes",
                `${"duration"}`,
                "number",
                initial.duration_minutes == null
                  ? ""
                  : Number(initial.duration_minutes) /
                      (mode === "full_days" ? 1440 : 1),
                { min: 0, step: mode === "full_days" ? "1" : "any" },
              )}
              <span className="field-note">
                {t(mode === "full_days" ? "days" : "minutes")}
              </span>
              {status}
              {text("progress", "progress", "number", 0, { min: 0, max: 100 })}
              {text("order_index", "order", "number", snapshot.tasks.length)}
            </div>
            {progress}
            {text("milestone", "milestone", "checkbox", false)}
            {notes}
          </>
        )}
        {table === "dependencies" && (
          <>
            {select("predecessor_task_id", "predecessor", taskChoices)}
            {select("successor_task_id", "successor", taskChoices)}
            <p className="muted">{t("fs")}</p>
            {text("lag_minutes", "lag", "number", 0)}
            {text("propagate", "propagate", "checkbox", true)}
          </>
        )}
        {table === "work_calendars" &&
          text("is_default", "is_default", "checkbox", false)}
        {table === "weekday_rules" && (
          <>
            {select(
              "weekday",
              "weekday",
              Array.from({ length: 7 }, (_, i) => ({
                value: String(i),
                label: new Intl.DateTimeFormat(i18n.language, {
                  weekday: "long",
                }).format(new Date(2024, 0, 7 + i)),
              })),
              "1",
            )}
            {text("is_working", "is_working", "checkbox", true)}
            {segments()}
          </>
        )}
        {table === "calendar_exceptions" && (
          <>
            {text("date", "date", "date", localDate(now), { required: true })}
            {select(
              "kind",
              "kind",
              choices(["holiday", "makeup_workday", "custom"]),
              "holiday",
            )}
            {text("is_working", "is_working", "checkbox", false)}
            {segments()}
            {text("note", "notes")}
          </>
        )}
        {table === "calendar_events" && (
          <>
            {text("title", "title", "text", "", { required: true })}
            {dates}
            {text("all_day", "all_day", "checkbox", false)}
            {select(
              "kind",
              "kind",
              choices(["block", "leave", "meeting", "custom"]),
              "meeting",
            )}
            <fieldset>
              <legend>{t("recurrence")}</legend>
              <label>
                {t("recurrence")}
                <select value={freq} onChange={(e) => setFreq(e.target.value)}>
                  <option value="">{t("once")}</option>
                  {["DAILY", "WEEKLY", "MONTHLY"].map((f, i) => (
                    <option key={f} value={f}>
                      {t(["daily", "weekly", "monthly"][i]!)}
                    </option>
                  ))}
                </select>
              </label>
              {freq && (
                <>
                  <div className="form-grid">
                    {text("interval", "interval", "number", 1, { min: 1 })}
                    {text("count", "count", "number", "", { min: 1 })}
                  </div>
                  {text("until", "until", "date")}
                  {freq === "WEEKLY" && text("byday", "byday")}
                </>
              )}
              {text("rrule", "recurrenceHint", "text", initial.rrule ?? "")}
            </fieldset>
            <fieldset>
              <legend>{t("override")}</legend>
              <label>
                {t("override")}
                <select
                  value={overrideMode}
                  onChange={(e) =>
                    setOverrideMode(
                      e.target.value as "exclude" | "rewrite" | "",
                    )
                  }
                >
                  <option value="">{t("none")}</option>
                  <option value="exclude">{t("exclude")}</option>
                  <option value="rewrite">{t("rewrite")}</option>
                </select>
              </label>
              {overrideMode && (
                <>
                  <label>
                    {t("targetType")}
                    <select
                      value={targetType}
                      onChange={(e) =>
                        setTargetType(e.target.value as "project" | "task")
                      }
                    >
                      <option value="project">{t("project")}</option>
                      <option value="task">{t("task")}</option>
                    </select>
                  </label>
                  {select(
                    "target_id",
                    "target",
                    targetType === "project"
                      ? projectChoices
                      : snapshot.tasks.map((task) => ({
                          value: task.id,
                          label: `${snapshot.projects.find((p) => p.id === task.project_id)?.name} / ${task.name}`,
                        })),
                    originalOverride?.target_id,
                  )}
                  {overrideMode === "rewrite" && (
                    <div className="form-grid">
                      {text(
                        "new_start",
                        "new_start",
                        "datetime-local",
                        localInput(originalOverride?.new_start ?? now),
                        { required: true },
                      )}
                      {text(
                        "new_end",
                        "new_end",
                        "datetime-local",
                        localInput(originalOverride?.new_end ?? now + 3600000),
                        { required: true },
                      )}
                    </div>
                  )}
                </>
              )}
            </fieldset>
          </>
        )}
        {table === "reminders" && (
          <>
            {text(
              "message",
              "message",
              "text",
              (initial.params as Record<string, string> | undefined)?.name ??
                "",
              { required: true },
            )}
            {text(
              "trigger_at",
              "trigger",
              "datetime-local",
              localInput(now + 3600000),
              { required: true },
            )}
          </>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            onClick={() => set({ editor: null })}
            disabled={busy}
          >
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy || disabled}>
            {busy ? t("loading") : t("save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
