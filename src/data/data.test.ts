import { describe, expect, it } from "vitest";
import { initialSnapshot, entity } from "./entity";
import { makeChanges } from "./changeLog";
import { validateSnapshot } from "./validation";
import type { Project, Task } from "../core/types";
function fixture() {
  const snapshot = initialSnapshot();
  const project: Project = {
    ...entity(),
    name: "Launch",
    calendar_id: snapshot.work_calendars[0].id,
    duration_mode: "working_hours",
    start_at: new Date(2026, 9, 19, 9).getTime(),
    end_at: new Date(2026, 9, 19, 12).getTime(),
    status: "planned",
    color: "#123456",
    notes: "",
    progress_manual: null,
  };
  snapshot.projects.push(project);
  const task: Task = {
    ...entity(),
    project_id: project.id,
    parent_id: null,
    name: "Design",
    start_at: project.start_at,
    end_at: project.end_at,
    duration_minutes: 180,
    progress: 0,
    progress_manual: null,
    status: "planned",
    order_index: 0,
    milestone: false,
    notes: "",
  };
  snapshot.tasks.push(task);
  return { snapshot, project, task };
}

describe("transaction change log", () => {
  it("records before images and increments only changed entity versions", () => {
    const { snapshot, task } = fixture();
    const next = structuredClone(snapshot);
    next.tasks[0].name = "Revised";
    const changes = makeChanges(snapshot, next, "device", 12345);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      table: "tasks",
      op: "upsert",
      before: task,
      payload: { name: "Revised", version: 2, updated_at: 12345 },
    });
    expect(next.projects[0]).toEqual(snapshot.projects[0]);
  });
  it("preserves deletion tombstones when a restored backup omits rows", () => {
    const { snapshot, task } = fixture();
    const next = structuredClone(snapshot);
    next.tasks = [];
    const changes = makeChanges(snapshot, next, "device", 67890);
    expect(changes[0]).toMatchObject({
      op: "delete",
      row_id: task.id,
      payload: { deleted_at: 67890, version: 2 },
    });
    expect(next.tasks[0].deleted_at).toBe(67890);
    const again = structuredClone(next);
    again.tasks = [];
    expect(makeChanges(next, again, "device", 99999)).toEqual([]);
    expect(again.tasks[0].deleted_at).toBe(67890);
  });
  it("round trips Unicode, overrides, nulls, and settings through JSON without generating changes", () => {
    const { snapshot, project } = fixture();
    snapshot.calendar_events.push({
      ...entity(),
      calendar_id: project.calendar_id,
      title: "假日 / 休日",
      start_at: project.start_at,
      end_at: project.end_at,
      all_day: false,
      kind: "leave",
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      override: {
        target_type: "project",
        target_id: project.id,
        mode: "exclude",
      },
    });
    const restored = JSON.parse(JSON.stringify(snapshot));
    validateSnapshot(restored);
    expect(makeChanges(snapshot, restored, "device")).toEqual([]);
  });
});
describe("backup and mutation invariants", () => {
  it("rejects cross-project task hierarchy and a third task level", () => {
    const { snapshot, task, project } = fixture();
    const another = { ...project, ...entity(), name: "Other" };
    snapshot.projects.push(another);
    const child = {
      ...task,
      ...entity(),
      parent_id: task.id,
      project_id: another.id,
    };
    snapshot.tasks.push(child);
    expect(() => validateSnapshot(snapshot)).toThrow("two levels");
    child.project_id = project.id;
    snapshot.tasks.push({ ...child, ...entity(), parent_id: child.id });
    expect(() => validateSnapshot(snapshot)).toThrow("two levels");
  });
  it("rejects cycles even when propagation is disabled", () => {
    const { snapshot, task, project } = fixture();
    const child = { ...task, ...entity() };
    snapshot.tasks.push(child);
    snapshot.dependencies.push(
      {
        ...entity(),
        project_id: project.id,
        predecessor_task_id: task.id,
        successor_task_id: child.id,
        type: "FS",
        lag_minutes: 0,
        propagate: false,
      },
      {
        ...entity(),
        project_id: project.id,
        predecessor_task_id: child.id,
        successor_task_id: task.id,
        type: "FS",
        lag_minutes: 0,
        propagate: false,
      },
    );
    expect(() => validateSnapshot(snapshot)).toThrow();
  });
  it("rejects ambiguous duplicate work rules and invalid day duration", () => {
    const { snapshot, project, task } = fixture();
    snapshot.weekday_rules.push({ ...snapshot.weekday_rules[0], ...entity() });
    expect(() => validateSnapshot(snapshot)).toThrow("Duplicate weekday");
    snapshot.weekday_rules.pop();
    project.duration_mode = "full_days";
    task.duration_minutes = 60;
    expect(() => validateSnapshot(snapshot)).toThrow("integer number of days");
  });
  it("rejects dangling rewrites and overlapping work segments", () => {
    const { snapshot, project } = fixture();
    snapshot.weekday_rules[1].segments = [
      { start: "09:00", end: "12:00" },
      { start: "11:00", end: "18:00" },
    ];
    expect(() => validateSnapshot(snapshot)).toThrow("overlap");
    snapshot.weekday_rules[1].segments = [];
    snapshot.calendar_events.push({
      ...entity(),
      calendar_id: project.calendar_id,
      title: "Rewrite",
      start_at: project.start_at,
      end_at: project.end_at,
      all_day: false,
      kind: "custom",
      rrule: null,
      override: {
        target_type: "task",
        target_id: entity().id,
        mode: "rewrite",
      },
    });
    expect(() => validateSnapshot(snapshot)).toThrow("does not exist");
  });
  it("rejects malformed reminder entity identifiers", () => {
    const snapshot = initialSnapshot();
    const reminder = {
      ...entity(), entity_type: "custom" as const, entity_id: "custom",
      trigger_at: Date.now(), message_key: "reminder.custom", params: {},
      offset_minutes: 0, fired_at: null, snoozed_to: null,
    };
    snapshot.reminders.push(reminder);
    expect(() => validateSnapshot(snapshot)).toThrow("Invalid reminder");
  });
});
