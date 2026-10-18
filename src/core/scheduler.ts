import { advance, expandEvents, workingMinutesBetween } from "./calendar";
import { assertAcyclic, propagate } from "./dependency";
import { taskProgress } from "./progress";
import type {
  CalendarContext,
  CalendarEvent,
  Dependency,
  ExtensionResult,
  Project,
  Reminder,
  Snapshot,
  Task,
} from "./types";

const DAY = 86_400_000;
function contextFor(
  snapshot: Snapshot,
  project: Project,
  task?: Task,
): CalendarContext {
  const calendar = snapshot.work_calendars.find(
    (c) => c.deleted_at === null && c.id === project.calendar_id,
  );
  if (!calendar)
    throw new Error(`Missing work calendar for project ${project.id}`);
  return {
    calendar,
    rules: snapshot.weekday_rules,
    exceptions: snapshot.calendar_exceptions,
    events: snapshot.calendar_events,
    target: task
      ? { type: "task", id: task.id }
      : { type: "project", id: project.id },
    project_id: project.id,
  };
}
function rewrite(
  events: CalendarEvent[],
  type: "project" | "task",
  id: string,
): CalendarEvent | undefined {
  // A recurring rewrite targets one entity, not a succession of moving entities:
  // the series anchor is authoritative; recurrence still expands for reminders/excludes.
  return events
    .filter(
      (e) =>
        e.deleted_at === null &&
        e.override?.mode === "rewrite" &&
        e.override.target_type === type &&
        e.override.target_id === id,
    )
    .sort((a, b) => a.updated_at - b.updated_at || a.id.localeCompare(b.id))
    .at(-1);
}
function applyRewrite<T extends Project | Task>(
  entity: T,
  event: CalendarEvent | undefined,
): T {
  if (!event) return entity;
  const start_at = event.override?.new_start ?? event.start_at,
    end_at = event.override?.new_end ?? event.end_at;
  if (end_at < start_at) throw new Error("Rewrite ends before it starts");
  return { ...entity, start_at, end_at };
}
export function reschedule(snapshot: Snapshot, previous?: Snapshot): Snapshot {
  const projects = snapshot.projects.map((p) => ({ ...p }));
  let tasks = snapshot.tasks.map((t) => ({ ...t }));
  assertAcyclic(tasks, snapshot.dependencies);
  const activeTasks = tasks.filter((t) => t.deleted_at === null);
  for (const task of activeTasks) {
    if (
      !projects.some((p) => p.id === task.project_id && p.deleted_at === null)
    )
      throw new Error("Task references missing project");
  }
  for (let i = 0; i < projects.length; i++) {
    const original = projects[i];
    if (original.deleted_at !== null) continue;
    const projectRewrite = rewrite(
      snapshot.calendar_events,
      "project",
      original.id,
    );
    const project = applyRewrite(original, projectRewrite),
      mode = project.duration_mode;
    contextFor(snapshot, project);
    const pinned = new Set<string>();
    const local = tasks
      .filter((t) => t.project_id === project.id && t.deleted_at === null)
      .map((task) => {
        const context = contextFor(snapshot, project, task),
          event = rewrite(snapshot.calendar_events, "task", task.id);
        if (event) pinned.add(task.id);
        let next = applyRewrite(task, event);
        // Infer duration once before applying exclusions; later calendar changes retain it.
        const base = { ...context, events: [] };
        const duration = task.milestone
          ? 0
          : event
            ? workingMinutesBetween(next.start_at, next.end_at, context, mode)
            : (task.duration_minutes ??
              workingMinutesBetween(task.start_at, task.end_at, base, mode));
        if (duration < 0) throw new Error("Task has negative duration");
        next = {
          ...next,
          duration_minutes: duration,
          end_at: task.milestone
            ? next.start_at
            : event
              ? next.end_at
              : advance(next.start_at, duration, context, mode),
        };
        return next;
      });
    const dependencies = snapshot.dependencies.filter(
      (d) => d.deleted_at === null && d.project_id === project.id,
    );
    const scheduled = propagate(
      local,
      dependencies,
      (task) => contextFor(snapshot, project, task),
      mode,
      pinned,
    );
    const children = new Map<string, Task[]>();
    for (const task of scheduled)
      if (task.parent_id) {
        const list = children.get(task.parent_id) ?? [];
        list.push(task);
        children.set(task.parent_id, list);
      }
    const aggregate = (task: Task): void => {
      const descendants = children.get(task.id) ?? [];
      for (const child of descendants) aggregate(child);
      if (descendants.length && !pinned.has(task.id)) {
        task.start_at = Math.min(...descendants.map((t) => t.start_at));
        task.end_at = Math.max(...descendants.map((t) => t.end_at));
        task.duration_minutes = workingMinutesBetween(
          task.start_at,
          task.end_at,
          contextFor(snapshot, project, task),
          mode,
        );
      }
      task.progress = taskProgress(task, scheduled);
    };
    for (const task of scheduled.filter((t) => !t.parent_id)) aggregate(task);
    const byId = new Map(scheduled.map((t) => [t.id, t]));
    tasks = tasks.map((t) => byId.get(t.id) ?? t);
    // Task-backed bounds only expand. Taskless calendars use the persisted prior interval as their duration baseline.
    if (!projectRewrite && !scheduled.length && previous) {
      const before = previous.projects.find(
        (p) => p.id === project.id && p.deleted_at === null,
      );
      if (
        before &&
        before.duration_mode === mode &&
        before.start_at === original.start_at &&
        before.end_at === original.end_at
      ) {
        const duration = workingMinutesBetween(
          before.start_at,
          before.end_at,
          contextFor(previous, before),
          before.duration_mode,
        );
        const context = contextFor(snapshot, project);
        const currentDuration = workingMinutesBetween(
          project.start_at,
          project.end_at,
          context,
          mode,
        );
        projects[i] =
          duration === currentDuration
            ? project
            : {
                ...project,
                end_at: advance(project.start_at, duration, context, mode),
              };
      } else projects[i] = project;
    } else
      projects[i] =
        projectRewrite || !scheduled.length
          ? project
          : {
              ...project,
              start_at: Math.min(
                project.start_at,
                ...scheduled.map((t) => t.start_at),
              ),
              end_at: Math.max(
                project.end_at,
                ...scheduled.map((t) => t.end_at),
              ),
            };
  }
  return { ...snapshot, projects, tasks };
}
export function extendProject(
  project: Project,
  tasks: Task[],
  dependencies: Dependency[],
  end: number,
  moveTasks: boolean,
  calendarFor: (task: Task) => CalendarContext,
): ExtensionResult {
  if (!Number.isFinite(end) || end < project.start_at)
    throw new Error("Invalid project end");
  if (!moveTasks)
    return {
      project: { ...project, end_at: end },
      tasks: tasks.map((t) => ({ ...t })),
    };
  const shifted = tasks.map((task) => {
    if (task.project_id !== project.id || task.deleted_at !== null)
      return { ...task };
    const context = calendarFor(task),
      mode = project.duration_mode;
    const delta = workingMinutesBetween(project.end_at, end, context, mode);
    const duration = task.milestone
      ? 0
      : (task.duration_minutes ??
        workingMinutesBetween(task.start_at, task.end_at, context, mode));
    const shiftedStart = advance(task.start_at, delta, context, mode);
    // A duration cursor may land at closing time; a moved task starts at the
    // next working instant rather than spending its first night off-calendar.
    const start_at =
      delta !== 0 && duration > 0 && mode === "working_hours"
        ? advance(shiftedStart, 1 / 60_000, context, mode) - 1
        : shiftedStart;
    return {
      ...task,
      start_at,
      end_at: advance(start_at, duration, context, mode),
      duration_minutes: duration,
    };
  });
  const relevant = shifted.filter(
    (t) => t.project_id === project.id && t.deleted_at === null,
  );
  const updated = propagate(
    relevant,
    dependencies.filter((d) => d.project_id === project.id),
    calendarFor,
    project.duration_mode,
  );
  const byId = new Map(updated.map((t) => [t.id, t]));
  return {
    project: {
      ...project,
      end_at: Math.max(end, ...updated.map((t) => t.end_at)),
    },
    tasks: shifted.map((t) => byId.get(t.id) ?? t),
  };
}

export function buildReminders(
  snapshot: Snapshot,
  now: number,
  makeId: () => string,
): Reminder[] {
  if (!Number.isFinite(now)) throw new Error("Invalid reminder time");
  const horizon = now + 366 * DAY,
    offsets = [...new Set(snapshot.settings.default_reminder_offsets)];
  if (offsets.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error("Invalid reminder offsets");
  const key = (
    type: string,
    id: string,
    occurrence: number,
    offset: number,
  ): string => JSON.stringify([type, id, occurrence, offset]);
  const previous = new Map<string, Reminder>();
  for (const r of snapshot.reminders)
    if (r.deleted_at === null && r.entity_type !== "custom") {
      const occurrence = Number(
        r.params.occurrence_at ?? r.trigger_at + r.offset_minutes * 60_000,
      );
      previous.set(
        key(r.entity_type, r.entity_id, occurrence, r.offset_minutes),
        r,
      );
    }
  const output = snapshot.reminders
    .filter(
      (r) =>
        r.deleted_at === null &&
        (r.entity_type === "custom" || r.params.snooze_of !== undefined),
    )
    .map((r) => ({ ...r, params: { ...r.params } }));
  const add = (
    type: "project" | "task" | "event",
    id: string,
    name: string,
    occurrence: number,
  ): void => {
    for (const offset of offsets) {
      const trigger_at = occurrence - offset * 60_000;
      const old = previous.get(key(type, id, occurrence, offset));
      if (trigger_at > horizon || (trigger_at < now && !old)) continue;
      const params = { name, occurrence_at: String(occurrence) };
      if (old) {
        if (old.params.snooze_of === undefined)
          output.push({ ...old, params: { ...old.params, ...params } });
      } else
        output.push({
          id: makeId(),
          version: 1,
          updated_at: now,
          deleted_at: null,
          entity_type: type,
          entity_id: id,
          trigger_at,
          message_key: `reminder.${type}`,
          params,
          offset_minutes: offset,
          fired_at: null,
          snoozed_to: null,
        });
    }
  };
  for (const p of snapshot.projects)
    if (p.deleted_at === null && p.status !== "archived" && p.status !== "done")
      add("project", p.id, p.name, p.end_at);
  for (const t of snapshot.tasks)
    if (t.deleted_at === null && t.status !== "archived" && t.status !== "done")
      add("task", t.id, t.name, t.end_at);
  const lookAhead = Math.max(0, ...offsets) * 60_000;
  // Include old occurrences to preserve fired/snoozed history without resurrecting deleted entities.
  const past = snapshot.reminders
    .filter((r) => r.entity_type === "event" && r.deleted_at === null)
    .map((r) =>
      Number(
        r.params.occurrence_at ?? r.trigger_at + r.offset_minutes * 60_000,
      ),
    );
  const from = Math.min(now, ...past.filter(Number.isFinite));
  for (const event of expandEvents(
    snapshot.calendar_events,
    from,
    horizon + lookAhead + 1,
  ))
    add("event", event.id, event.title, event.start_at);
  return output.sort(
    (a, b) => a.trigger_at - b.trigger_at || a.id.localeCompare(b.id),
  );
}
