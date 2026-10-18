import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";
import { v7 } from "uuid";
import type {
  CalendarContext,
  Entity,
  Settings,
  Snapshot,
  TableName,
  Tables,
  Task,
} from "../core/types";
import { reschedule, extendProject, buildReminders } from "../core/scheduler";
import { workingMinutesBetween, expandEvents } from "../core/calendar";
import { activeSnapshot, entity, initialSnapshot, tables } from "./entity";
import { makeChanges } from "./changeLog";
import { createRepository, isDesktop } from "./repositories";
import type { Repository } from "./repositories";
import { validateSnapshot } from "./validation";
export { isDesktop };

export class Application {
  private current: Snapshot | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private subscribers = new Set<(snapshot: Snapshot) => void>();
  private deviceId: string;
  private initialized = false;
  private lastWrite = 0;
  constructor(
    private repository: Repository,
    deviceId?: string,
  ) {
    this.deviceId =
      deviceId ??
      (typeof localStorage !== "undefined"
        ? localStorage.getItem("cproject-device")
        : null) ??
      v7();
    if (!deviceId && typeof localStorage !== "undefined")
      localStorage.setItem("cproject-device", this.deviceId);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private publish(): void {
    if (!this.current) return;
    for (const listener of this.subscribers)
      listener(activeSnapshot(this.current));
  }
  subscribe(listener: (snapshot: Snapshot) => void): () => void {
    this.subscribers.add(listener);
    if (this.current) listener(activeSnapshot(this.current));
    return () => {
      this.subscribers.delete(listener);
    };
  }
  setRepository(repository: Repository): Promise<void> {
    return this.serialize(async () => {
      this.repository = repository;
      this.current = null;
    });
  }
  async load(): Promise<Snapshot> {
    await this.refresh();
    if (!this.initialized && typeof window !== "undefined") {
      this.initialized = true;
      let day = new Date().toDateString();
      window.setInterval(() => {
        const now = new Date().toDateString();
        if (now !== day) {
          day = now;
          void this.refresh().catch(console.error);
        }
      }, 60_000);
      window.addEventListener("focus", () => {
        void this.refresh().catch(console.error);
      });
      if (isDesktop) {
        await listen("reminders-changed", () => {
          void this.refresh().catch(console.error);
        });
        if (!(await isPermissionGranted())) await requestPermission();
      }
    }
    return activeSnapshot(this.current!);
  }
  refresh(): Promise<void> {
    return this.serialize(async () => {
      const before = await this.repository.load();
      const next =
        before.work_calendars.length === 0
          ? initialSnapshot()
          : structuredClone(before);
      if (before.work_calendars.length === 0) next.settings = before.settings;
      await this.persist(before, next, this.repository.refreshSchedules !== false);
    });
  }
  private context(snapshot: Snapshot, task: Task): CalendarContext {
    const project = snapshot.projects.find(
      (p) => p.id === task.project_id && p.deleted_at === null,
    );
    if (!project) throw new Error("Project not found");
    const calendar = snapshot.work_calendars.find(
      (c) => c.id === project.calendar_id && c.deleted_at === null,
    );
    if (!calendar) throw new Error("Calendar not found");
    return {
      calendar,
      rules: snapshot.weekday_rules.filter(
        (r) => r.deleted_at === null && r.calendar_id === calendar.id,
      ),
      exceptions: snapshot.calendar_exceptions.filter(
        (e) => e.deleted_at === null && e.calendar_id === calendar.id,
      ),
      events: snapshot.calendar_events.filter(
        (e) => e.deleted_at === null && e.calendar_id === calendar.id,
      ),
      target: { type: "task", id: task.id },
      project_id: project.id,
    };
  }
  private async persist(
    before: Snapshot,
    next: Snapshot,
    schedule: boolean,
  ): Promise<void> {
    validateSnapshot(next);
    // Parse every recurrence even when no current entity uses its calendar.
    for (const event of next.calendar_events.filter(
      (e) => e.deleted_at === null,
    ))
      expandEvents([event], event.start_at, event.start_at + 86_400_000);
    if (schedule) {
      const calculated = reschedule(
        activeSnapshot(next),
        activeSnapshot(before),
      );
      calculated.reminders = buildReminders(calculated, Date.now(), v7);
      for (const table of tables)
        (next[table] as Entity[]) = [
          ...calculated[table],
          ...next[table].filter((row) => row.deleted_at !== null),
        ];
      validateSnapshot(next);
    }
    const timestamp = Math.max(Date.now(), this.lastWrite + 1);
    const changes = makeChanges(before, next, this.deviceId, timestamp);
    if (changes.length) {
      await this.repository.commit(
        changes,
        changes.some((c) => c.table === "settings") ? next.settings : null,
      );
      this.lastWrite = timestamp;
    }
    this.current = next;
    this.publish();
  }
  private mutate(
    work: (next: Snapshot) => void,
    schedule = true,
  ): Promise<void> {
    return this.serialize(async () => {
      const before = await this.repository.load();
      const next = structuredClone(before);
      work(next);
      await this.persist(before, next, schedule);
    });
  }
  save<K extends TableName>(table: K, value: Tables[K]): Promise<void> {
    return this.mutate((next) => {
      const rows = next[table] as Tables[K][];
      const index = rows.findIndex((row) => row.id === value.id);
      const previous = rows[index];
      if (previous && previous.version !== value.version)
        throw new Error("Data changed. Reload before editing.");
      const row = structuredClone(value);
      if (
        table === "work_calendars" &&
        (row as Tables["work_calendars"]).is_default
      )
        for (const calendar of next.work_calendars)
          calendar.is_default = calendar.id === row.id;
      if (table === "tasks") {
        const task = row as Task;
        const old = previous as Task | undefined;
        if (task.milestone) {
          task.duration_minutes = 0;
          task.end_at = task.start_at;
        } else if (
          old &&
          task.duration_minutes === old.duration_minutes &&
          (task.start_at !== old.start_at || task.end_at !== old.end_at)
        ) {
          const project = next.projects.find((p) => p.id === task.project_id)!;
          task.duration_minutes = workingMinutesBetween(
            task.start_at,
            task.end_at,
            this.context(next, task),
            project.duration_mode,
          );
        }
      }
      if (index < 0) rows.push(row);
      else rows[index] = row;
      if (table === "work_calendars" && index < 0)
        for (let weekday = 0; weekday < 7; weekday++)
          next.weekday_rules.push({
            ...entity(),
            calendar_id: row.id,
            weekday,
            is_working: weekday > 0 && weekday < 6,
            segments: [
              { start: "09:00", end: "12:00" },
              { start: "13:30", end: "18:00" },
            ],
          });
    }, table !== "reminders");
  }
  remove(table: TableName, id: string): Promise<void> {
    return this.mutate((next) => {
      const row = next[table].find((r) => r.id === id);
      if (!row) throw new Error("Record not found");
      const now = Date.now();
      const removedTasks = new Set<string>();
      const removedProjects = new Set<string>();
      if (table === "work_calendars") {
        if (
          next.projects.some(
            (p) => p.deleted_at === null && p.calendar_id === id,
          ) ||
          next.calendar_events.some(
            (e) => e.deleted_at === null && e.calendar_id === id,
          )
        )
          throw new Error("Calendar is still in use");
        if (
          next.work_calendars.filter((c) => c.deleted_at === null).length === 1
        )
          throw new Error("Keep at least one work calendar");
        for (const rule of [...next.weekday_rules, ...next.calendar_exceptions])
          if (rule.calendar_id === id) rule.deleted_at = now;
      }
      if (table === "projects") {
        removedProjects.add(id);
        for (const task of next.tasks)
          if (task.project_id === id) removedTasks.add(task.id);
      }
      if (table === "tasks") {
        removedTasks.add(id);
        for (const task of next.tasks)
          if (task.parent_id === id) removedTasks.add(task.id);
      }
      row.deleted_at = now;
      for (const task of next.tasks)
        if (removedTasks.has(task.id)) task.deleted_at = now;
      for (const edge of next.dependencies)
        if (
          removedTasks.has(edge.predecessor_task_id) ||
          removedTasks.has(edge.successor_task_id)
        )
          edge.deleted_at = now;
      for (const event of next.calendar_events)
        if (
          event.override &&
          (event.override.target_type === "project"
            ? removedProjects
            : removedTasks
          ).has(event.override.target_id)
        )
          event.override = null;
      for (const reminder of next.reminders)
        if (
          (reminder.entity_type === "task" &&
            removedTasks.has(reminder.entity_id)) ||
          (reminder.entity_type === "project" &&
            removedProjects.has(reminder.entity_id)) ||
          (table === "calendar_events" &&
            reminder.entity_type === "event" &&
            reminder.entity_id === id)
        )
          reminder.deleted_at = now;
    });
  }
  updateSettings(patch: Partial<Settings>): Promise<void> {
    return this.serialize(async () => {
      const before = await this.repository.load();
      const next = structuredClone(before);
      next.settings = { ...next.settings, ...patch };
      validateSnapshot(next);
      if (isDesktop) {
        if (!(await isPermissionGranted())) await requestPermission();
      }
      await this.persist(before, next, true);
    });
  }
  extend(projectId: string, end: number, moveTasks: boolean): Promise<void> {
    return this.mutate((next) => {
      const index = next.projects.findIndex((p) => p.id === projectId);
      if (index < 0) throw new Error("Project not found");
      const result = extendProject(
        next.projects[index],
        next.tasks.filter(
          (t) => t.deleted_at === null && t.project_id === projectId,
        ),
        next.dependencies.filter(
          (d) => d.deleted_at === null && d.project_id === projectId,
        ),
        end,
        moveTasks,
        (task) => this.context(next, task),
      );
      next.projects[index] = result.project;
      const tasks = new Map(result.tasks.map((task) => [task.id, task]));
      next.tasks = next.tasks.map((task) => tasks.get(task.id) ?? task);
    });
  }
  snooze(id: string, minutes: number): Promise<void> {
    return this.mutate((next) => {
      if (!Number.isFinite(minutes) || minutes <= 0)
        throw new Error("Snooze minutes must be positive");
      const original = next.reminders.find(
        (row) => row.id === id && row.deleted_at === null,
      );
      if (!original) throw new Error("Reminder not found");
      original.snoozed_to = Date.now() + minutes * 60_000;
      original.fired_at ??= Date.now();
      next.reminders.push({
        ...original,
        ...entity(),
        entity_type: "custom",
        trigger_at: original.snoozed_to,
        fired_at: null,
        snoozed_to: null,
      });
    }, false);
  }
  exportJSON(): Promise<string> {
    return this.serialize(async () => JSON.stringify(
      {
        format: "cproject-js",
        version: 1,
        exported_at: Date.now(),
        snapshot: await this.repository.load(),
        changes: await this.repository.changes(),
      },
      null,
      2,
    ));
  }
  importJSON(json: string, expectedSnapshot?: Snapshot): Promise<void> {
    return this.serialize(async () => {
      const parsed = JSON.parse(json) as {
        format?: string;
        version?: number;
        snapshot?: unknown;
      };
      if (parsed.format !== "cproject-js" || parsed.version !== 1)
        throw new Error("Unsupported backup format");
      validateSnapshot(parsed.snapshot);
      const before = await this.repository.load();
      if (expectedSnapshot && JSON.stringify(before) !== JSON.stringify(expectedSnapshot))
        throw new Error("The destination changed. Refresh before uploading local data.");
      const next = structuredClone(parsed.snapshot);
      await this.persist(before, next, true);
    });
  }
  undo(): Promise<void> {
    return this.serialize(async () => {
      const history = await this.repository.changes();
      const last = [...history]
        .reverse()
        .find(
          (change) =>
            change.device_id === this.deviceId && change.table !== "reminders",
        );
      if (!last) throw new Error("Nothing to undo");
      const before = await this.repository.load();
      const next = structuredClone(before);
      const batch = history.filter(
        (change) =>
          change.ts === last.ts && change.device_id === last.device_id,
      );
      for (const change of batch) {
        if (change.table === "settings") {
          const expected = change.payload as Settings;
          if ((Object.keys(expected) as (keyof Settings)[]).some(
            (key) => JSON.stringify(next.settings[key]) !== JSON.stringify(expected[key]),
          )) throw new Error("A later settings change prevents undo");
          next.settings = change.before as Settings;
          continue;
        }
        const rows: Entity[] = next[change.table];
        const index = rows.findIndex((row) => row.id === change.row_id);
        if (
          index < 0 ||
          rows[index].version !== (change.payload as Entity).version
        )
          throw new Error("A later change prevents undo");
        rows[index] = change.before
          ? (structuredClone(change.before) as Entity)
          : { ...rows[index], deleted_at: Date.now() };
      }
      await this.persist(before, next, false);
    });
  }
}
export const localRepository = createRepository();
export const app = new Application(localRepository);
