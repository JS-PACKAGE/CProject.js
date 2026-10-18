import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { Project, Snapshot, TableName, Tables } from "../core/types";
import { taskProgress, projectProgress } from "../core/progress";
import { dependencyConflicts } from "../core/dependency";
import { app } from "../data/app";
import { Dialog } from "../components/Editor";
import { addDays, day, dayStart, localInput, useUI } from "./ui";
export interface ViewProps {
  snapshot: Snapshot;
  run: (action: () => Promise<unknown>) => Promise<void>;
}
export function EntityActions({
  table,
  value,
  run,
}: {
  table: TableName;
  value: Tables[TableName];
  run: ViewProps["run"];
}) {
  const { t } = useTranslation();
  const set = useUI((s) => s.set);
  return (
    <span className="entity-actions">
      <button onClick={() => set({ editor: { table, value } })}>
        {t("edit")}
      </button>
      <button
        className="danger-text"
        onClick={() => {
          if (window.confirm(t("deleteConfirm")))
            void run(() => app.remove(table, value.id));
        }}
      >
        {t("delete")}
      </button>
    </span>
  );
}
export function Projects({ snapshot, run }: ViewProps) {
  const { t, i18n } = useTranslation();
  const { selected, query, set } = useUI();
  const date = new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
  });
  const projects = snapshot.projects.filter((p) =>
    `${p.name} ${p.notes} ${snapshot.tasks
      .filter((task) => task.project_id === p.id)
      .map((task) => task.name)
      .join(" ")}`
      .toLocaleLowerCase()
      .includes(query.toLocaleLowerCase()),
  );
  const project =
    snapshot.projects.find((p) => p.id === selected) ?? projects[0];
  const tasks = snapshot.tasks
    .filter((task) => task.project_id === project?.id)
    .sort((a, b) => a.order_index - b.order_index);
  const dependencies = snapshot.dependencies.filter(
    (d) => d.project_id === project?.id,
  );
  const workCalendar = snapshot.work_calendars.find(
    (c) => c.id === project?.calendar_id,
  );
  const conflicts = new Set(
    dependencyConflicts(
      tasks,
      dependencies,
      workCalendar
        ? (task) => ({
            calendar: workCalendar,
            rules: snapshot.weekday_rules.filter(
              (r) => r.calendar_id === workCalendar.id,
            ),
            exceptions: snapshot.calendar_exceptions.filter(
              (e) => e.calendar_id === workCalendar.id,
            ),
            events: snapshot.calendar_events.filter(
              (e) => e.calendar_id === workCalendar.id,
            ),
            target: { type: "task", id: task.id },
            project_id: task.project_id,
          })
        : undefined,
      project?.duration_mode,
    ),
  );
  function taskRow(task: Snapshot["tasks"][number]) {
    const progress = taskProgress(task, snapshot.tasks);
    return (
      <div
        className={`task-row ${task.parent_id ? "child" : ""}`}
        key={task.id}
      >
        <span className={`task-symbol ${task.milestone ? "milestone" : ""}`}>
          {task.milestone ? "◆" : task.status === "done" ? "✓" : "○"}
        </span>
        <button
          className="task-name"
          onClick={() => set({ editor: { table: "tasks", value: task } })}
        >
          <strong>{task.name}</strong>
          <small>
            {t(task.status)} · {date.format(task.start_at)} —{" "}
            {date.format(task.end_at)}
          </small>
        </button>
        <span className="task-progress">
          <progress value={progress} max="100" aria-label={t("progress")} />
          {Math.round(progress)}%
        </span>
        <span className="task-tools">
          {!task.parent_id && (
            <button
              onClick={() =>
                set({
                  editor: {
                    table: "tasks",
                    defaults: {
                      project_id: task.project_id,
                      parent_id: task.id,
                      start_at: task.start_at,
                      end_at: task.end_at,
                    },
                  },
                })
              }
            >
              + {t("subtask")}
            </button>
          )}
          <EntityActions table="tasks" value={task} run={run} />
        </span>
      </div>
    );
  }
  return (
    <div className="projects-layout">
      <section className="project-list">
        <input
          className="search"
          aria-label={t("search")}
          placeholder={t("search")}
          value={query}
          onChange={(e) => set({ query: e.target.value })}
        />
        <button
          className="primary full"
          onClick={() => set({ editor: { table: "projects" } })}
        >
          + {t("newProject")}
        </button>
        {projects.map((p) => (
          <button
            key={p.id}
            className={`project-card ${p.id === project?.id ? "selected" : ""}`}
            onClick={() => set({ selected: p.id })}
          >
            <span className="project-dot" style={{ background: p.color }} />
            <span>
              <strong>{p.name}</strong>
              <small>
                {t(p.status)} · {date.format(p.end_at)}
              </small>
              <progress
                value={projectProgress(p, snapshot.tasks)}
                max="100"
                aria-label={t("progress")}
              />
            </span>
            <b>{Math.round(projectProgress(p, snapshot.tasks))}%</b>
          </button>
        ))}
        {!projects.length && (
          <p className="muted empty-small">
            {t(snapshot.projects.length ? "noMatches" : "noProjects")}
          </p>
        )}
      </section>
      <section className="project-detail">
        {project ? (
          <>
            <div className="detail-heading">
              <div>
                <span className="eyebrow">
                  {t("project")} / {t(project.status)}
                </span>
                <h2>
                  <span
                    className="project-dot"
                    style={{ background: project.color }}
                  />
                  {project.name}
                </h2>
                <p className="muted">
                  {date.format(project.start_at)} —{" "}
                  {date.format(project.end_at)} · {t(project.duration_mode)}
                </p>
              </div>
              <EntityActions table="projects" value={project} run={run} />
            </div>
            <div className="project-overview">
              <div>
                <span className="metric">
                  {Math.round(projectProgress(project, snapshot.tasks))}
                  <small>%</small>
                </span>
                <span className="muted">{t("progress")}</span>
              </div>
              <div>
                <span className="metric">{tasks.length}</span>
                <span className="muted">{t("tasks")}</span>
              </div>
              <button
                onClick={() =>
                  set({
                    extension: {
                      id: project.id,
                      end: addDays(project.end_at, 1),
                    },
                  })
                }
              >
                {t("extend")} ↗
              </button>
            </div>
            {project.notes && <p className="notes">{project.notes}</p>}
            <div className="section-heading">
              <h3>{t("tasks")}</h3>
              <button
                onClick={() =>
                  set({
                    editor: {
                      table: "tasks",
                      defaults: {
                        project_id: project.id,
                        start_at: project.start_at,
                        end_at: project.end_at,
                      },
                    },
                  })
                }
              >
                + {t("newTask")}
              </button>
            </div>
            {tasks
              .filter((task) => !task.parent_id)
              .map((task) => (
                <div key={task.id}>
                  {taskRow(task)}
                  {tasks
                    .filter((child) => child.parent_id === task.id)
                    .map(taskRow)}
                </div>
              ))}
            {!tasks.length && (
              <div className="empty-state compact">
                <span>＋</span>
                <p>{t("empty")}</p>
              </div>
            )}
            <div className="section-heading">
              <h3>{t("dependencies")}</h3>
              <button
                disabled={tasks.length < 2}
                onClick={() =>
                  set({
                    editor: {
                      table: "dependencies",
                      defaults: { project_id: project.id },
                    },
                  })
                }
              >
                + {t("add")}
              </button>
            </div>
            {dependencies.map((d) => (
              <div className="dependency-row" key={d.id}>
                <div>
                  <strong>
                    {
                      tasks.find((task) => task.id === d.predecessor_task_id)
                        ?.name
                    }{" "}
                    →{" "}
                    {
                      tasks.find((task) => task.id === d.successor_task_id)
                        ?.name
                    }
                  </strong>
                  <small>
                    {d.type} · {d.lag_minutes} {t("minutes")} ·{" "}
                    {t(d.propagate ? "propagate" : "on_hold")}
                    {conflicts.has(d.id) && (
                      <span className="danger-text"> · {t("conflict")}</span>
                    )}
                  </small>
                </div>
                <EntityActions table="dependencies" value={d} run={run} />
              </div>
            ))}
          </>
        ) : (
          <div className="empty-state">
            <span>◈</span>
            <h2>{t("tagline")}</h2>
            <p>{t("noProjects")}</p>
          </div>
        )}
      </section>
    </div>
  );
}
function EndHandle({ project, left }: { project: Project; left: number }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: project.id,
  });
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-label={`${t("projectEnd")}: ${project.name}`}
      className="end-handle"
      style={{
        left,
        transform: transform ? `translateX(${transform.x}px)` : undefined,
      }}
    >
      ↔
    </button>
  );
}
export function Timeline({ snapshot }: ViewProps) {
  const { t, i18n } = useTranslation();
  const { date, set } = useUI();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );
  const start = dayStart(date);
  const width = 46;
  const days = 28;
  const formatter = new Intl.DateTimeFormat(i18n.language, {
    day: "numeric",
    month: "short",
  });
  const position = (at: number) => ((at - start) / day) * width;
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>{t("timeline")}</h2>
        <div className="toolbar">
          <button
            onClick={() => set({ date: addDays(date, -14) })}
            aria-label={t("previous")}
          >
            ←
          </button>
          <button onClick={() => set({ date: Date.now() })}>
            {t("today")}
          </button>
          <button
            onClick={() => set({ date: addDays(date, 14) })}
            aria-label={t("next")}
          >
            →
          </button>
          <label>
            {t("start")}
            <input
              type="date"
              value={localInput(date).slice(0, 10)}
              onChange={(e) => {
                if (e.target.value)
                  set({ date: +new Date(`${e.target.value}T00:00`) });
              }}
            />
          </label>
        </div>
      </div>
      <DndContext
        sensors={sensors}
        onDragEnd={(e) => {
          const p = snapshot.projects.find((p) => p.id === e.active.id);
          if (p && e.delta.x)
            set({
              extension: {
                id: p.id,
                end: addDays(p.end_at, Math.round(e.delta.x / width)),
              },
            });
        }}
      >
        <div className="timeline-scroll">
          <div className="timeline" style={{ width: days * width + 200 }}>
            <div className="timeline-header">
              <div>
                {t("project")} / {t("task")}
              </div>
              <div className="timeline-axis">
                {Array.from({ length: days }, (_, i) => (
                  <span key={i} style={{ width }}>
                    {formatter.format(addDays(start, i))}
                  </span>
                ))}
              </div>
            </div>
            {snapshot.projects.map((p) => (
              <div key={p.id}>
                <div className="timeline-row">
                  <button
                    className="timeline-label"
                    onClick={() => set({ view: "projects", selected: p.id })}
                  >
                    {p.name}
                  </button>
                  <div
                    className="timeline-track"
                    style={{ backgroundSize: `${width}px 100%` }}
                  >
                    <div
                      className="timeline-bar"
                      style={{
                        display:
                          p.end_at < start || p.start_at >= addDays(start, days)
                            ? "none"
                            : undefined,
                        left: Math.max(0, position(p.start_at)),
                        width: Math.max(
                          4,
                          Math.min(days * width, position(p.end_at)) -
                            Math.max(0, position(p.start_at)),
                        ),
                        background: p.color,
                      }}
                    >
                      {p.name}
                    </div>
                    {position(p.end_at) >= 0 &&
                      position(p.end_at) <= days * width && (
                        <EndHandle project={p} left={position(p.end_at) - 8} />
                      )}
                  </div>
                </div>
                {snapshot.tasks
                  .filter((task) => task.project_id === p.id)
                  .map((task) => (
                    <div className="timeline-row small" key={task.id}>
                      <button
                        className="timeline-label"
                        onClick={() =>
                          set({ editor: { table: "tasks", value: task } })
                        }
                      >
                        {task.parent_id ? "↳ " : ""}
                        {task.name}
                      </button>
                      <div
                        className="timeline-track"
                        style={{ backgroundSize: `${width}px 100%` }}
                      >
                        <button
                          className={`timeline-bar task-bar ${task.milestone ? "is-milestone" : ""}`}
                          onClick={() =>
                            set({ editor: { table: "tasks", value: task } })
                          }
                          style={{
                            display:
                              task.end_at < start ||
                              task.start_at >= addDays(start, days)
                                ? "none"
                                : undefined,
                            left: Math.max(0, position(task.start_at)),
                            width: Math.max(
                              6,
                              Math.min(days * width, position(task.end_at)) -
                                Math.max(0, position(task.start_at)),
                            ),
                            background: p.color,
                          }}
                          aria-label={task.name}
                        >
                          {task.milestone ? "◆" : task.name}
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      </DndContext>
      {!snapshot.projects.length && (
        <div className="empty-state">{t("noProjects")}</div>
      )}
    </section>
  );
}
export function ExtendDialog({ run, disabled = false }: { run: ViewProps["run"]; disabled?: boolean }) {
  const { t } = useTranslation();
  const { extension, set } = useUI();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={t("extend")} close={() => !busy && set({ extension: null })}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || busy) return;
          const f = new FormData(e.currentTarget);
          setBusy(true);
          void run(async () => {
            await app.extend(
              extension!.id,
              +new Date(String(f.get("end"))),
              f.has("move"),
            );
            set({ extension: null });
          }).finally(() => setBusy(false));
        }}
      >
        <label>
          {t("newEnd")}
          <input
            required
            type="datetime-local"
            name="end"
            defaultValue={localInput(extension!.end)}
          />
        </label>
        <label className="check">
          <input type="checkbox" name="move" defaultChecked />
          {t("moveTasks")}
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={() => set({ extension: null })}>
            {t("cancel")}
          </button>
          <button className="primary" disabled={busy || disabled}>
            {t("save")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
