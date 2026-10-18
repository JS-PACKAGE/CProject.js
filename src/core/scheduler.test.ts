import { describe, expect, it } from "vitest";
import { buildReminders, extendProject, reschedule } from "./scheduler";
import {
  at,
  context,
  edge,
  event,
  project,
  snapshot,
  task,
} from "./fixtures.test-helper";
import type { Reminder } from "./types";

describe("snapshot scheduling", () => {
  it("infers working duration before exclusions exactly once and never mutates input", () => {
    const input = snapshot({
      tasks: [task("a", { duration_minutes: null, end_at: at(5, 12) })],
      calendar_events: [
        event({
          override: { target_type: "task", target_id: "a", mode: "exclude" },
        }),
      ],
    });
    const result = reschedule(input);
    expect(result.tasks[0].duration_minutes).toBe(180);
    expect(result.tasks[0].end_at).toBe(at(5, 14));
    expect(input.tasks[0].end_at).toBe(at(5, 12));
    expect(reschedule(result)).toEqual(result);
  });
  it("propagates chain delays through fan-in and expands project end without shrinking extensions", () => {
    const input = snapshot({
      tasks: [task("a", { duration_minutes: 420 }), task("b"), task("c")],
      dependencies: [
        edge("a", "b", { lag_minutes: 60 }),
        edge("a", "c"),
        edge("b", "c"),
      ],
    });
    const output = reschedule(input);
    expect(output.tasks[1].start_at).toBe(at(6, 10));
    expect(output.tasks[2].end_at).toBe(at(6, 12));
    expect(output.projects[0].end_at).toBe(at(6, 12));
    output.projects[0].end_at = at(20);
    expect(reschedule(output).projects[0].end_at).toBe(at(20));
  });
  it("rolls nested parent bounds and progress bottom-up and supports milestones", () => {
    const output = reschedule(
      snapshot({
        tasks: [
          task("a"),
          task("b", { parent_id: "a" }),
          task("c", {
            parent_id: "b",
            start_at: at(6),
            end_at: at(6, 10),
            progress: 75,
          }),
          task("m", {
            milestone: true,
            start_at: at(4),
            end_at: at(7),
            duration_minutes: null,
          }),
        ],
      }),
    );
    expect(output.tasks[0].start_at).toBe(at(6));
    expect(output.tasks[0].end_at).toBe(at(6, 10));
    expect(output.tasks[0].progress).toBe(75);
    expect(output.tasks[1].start_at).toBe(at(6));
    expect(output.tasks[3].end_at).toBe(at(4));
    expect(output.projects[0].start_at).toBe(at(4));
  });
  it("applies explicit task/project rewrite deterministically with recurring anchor semantics", () => {
    const input = snapshot({
      calendar_events: [
        event({
          rrule: "FREQ=DAILY",
          override: {
            target_type: "task",
            target_id: "a",
            mode: "rewrite",
            new_start: at(6),
            new_end: at(6, 12),
          },
        }),
        event({
          id: "p",
          override: {
            target_type: "project",
            target_id: "p",
            mode: "rewrite",
            new_start: at(2),
            new_end: at(7),
          },
        }),
      ],
    });
    const output = reschedule(input);
    expect(output.tasks[0].start_at).toBe(at(6));
    expect(output.tasks[0].duration_minutes).toBe(180);
    expect(output.projects[0].start_at).toBe(at(2));
    expect(output.projects[0].end_at).toBe(at(7));
    expect(reschedule(output)).toEqual(output);
    const defaults = reschedule(
      snapshot({
        calendar_events: [
          event({
            override: { target_type: "task", target_id: "a", mode: "rewrite" },
          }),
        ],
      }),
    );
    expect(defaults.tasks[0].start_at).toBe(at(5, 10));
    expect(defaults.tasks[0].end_at).toBe(at(5, 11));
  });
  it("keeps rewrite authority over incoming constraints and hierarchy summaries, while scheduling outgoing edges", () => {
    const output = reschedule(
      snapshot({
        tasks: [
          task("a"),
          task("child", { parent_id: "a" }),
          task("pre", { start_at: at(7), end_at: at(7, 10) }),
          task("post"),
        ],
        dependencies: [edge("pre", "a"), edge("a", "post")],
        calendar_events: [
          event({
            override: {
              target_type: "task",
              target_id: "a",
              mode: "rewrite",
              new_start: at(6),
              new_end: at(6, 12),
            },
          }),
        ],
      }),
    );
    expect(output.tasks[0].start_at).toBe(at(6));
    expect(output.tasks[0].end_at).toBe(at(6, 12));
    expect(output.tasks[1].start_at).toBe(at(5));
    expect(output.tasks[3].start_at).toBe(at(6, 12));
    expect(output.tasks[3].end_at).toBe(at(6, 14));
    expect(reschedule(output)).toEqual(output);
    const leaf = reschedule(
      snapshot({
        tasks: [task("a"), task("pre", { end_at: at(7) })],
        dependencies: [edge("pre", "a")],
        calendar_events: [
          event({
            override: { target_type: "task", target_id: "a", mode: "rewrite" },
          }),
        ],
      }),
    );
    expect(leaf.tasks[0].start_at).toBe(at(5, 10));
    expect(leaf.tasks[0].end_at).toBe(at(5, 11));
  });
  it("resolves multiple rewrites by updated time then stable ID", () => {
    const one = event({
      id: "a",
      override: { target_type: "task", target_id: "a", mode: "rewrite" },
    });
    const two = event({
      id: "z",
      start_at: at(6, 10),
      end_at: at(6, 11),
      override: one.override,
    });
    expect(
      reschedule(snapshot({ calendar_events: [two, one] })).tasks[0].start_at,
    ).toBe(at(6, 10));
  });
  it("preserves inactive rows and empty-project dates", () => {
    const input = snapshot({
      projects: [project(), project({ id: "gone", deleted_at: 1 })],
      tasks: [task("gone", { deleted_at: 1 })],
    });
    expect(reschedule(input)).toEqual(input);
  });
  it("supports full-day durations across project exclusions", () => {
    const input = snapshot({
      projects: [project({ duration_mode: "full_days" })],
      tasks: [task("a", { duration_minutes: 1440 })],
      calendar_events: [
        event({
          start_at: at(6, 10),
          end_at: at(6, 11),
          override: { target_type: "project", target_id: "p", mode: "exclude" },
        }),
      ],
    });
    expect(reschedule(input).tasks[0].end_at).toBe(at(7));
  });
  it("rejects invalid parents, hierarchy cycles, missing calendar/project and cross-project dependencies", () => {
    expect(() =>
      reschedule(snapshot({ tasks: [task("a", { parent_id: "gone" })] })),
    ).toThrow("parent");
    expect(() =>
      reschedule(
        snapshot({
          tasks: [task("a", { parent_id: "b" }), task("b", { parent_id: "a" })],
        }),
      ),
    ).toThrow("cycle");
    expect(() => reschedule(snapshot({ work_calendars: [] }))).toThrow(
      "calendar",
    );
    expect(() => reschedule(snapshot({ projects: [] }))).toThrow("project");
    expect(() =>
      reschedule(
        snapshot({
          projects: [project(), project({ id: "other" })],
          tasks: [task(), task("b", { project_id: "other" })],
          dependencies: [edge()],
        }),
      ),
    ).toThrow("boundary");
    expect(() =>
      reschedule(snapshot({ tasks: [task("a", { duration_minutes: -1 })] })),
    ).toThrow("negative");
    expect(() =>
      reschedule(
        snapshot({
          calendar_events: [
            event({
              override: {
                target_type: "task",
                target_id: "a",
                mode: "rewrite",
                new_start: at(7),
                new_end: at(6),
              },
            }),
          ],
        }),
      ),
    ).toThrow("before");
  });
  it("preserves taskless project duration across exclusion insertion/removal and calendar edits", () => {
    const before = snapshot({ tasks: [] });
    const exclude = event({
      override: { target_type: "project", target_id: "p", mode: "exclude" },
    });
    const inserted = reschedule(
      { ...before, calendar_events: [exclude] },
      before,
    );
    expect(inserted.projects[0].end_at).toBe(at(6, 10));
    expect(reschedule(inserted, inserted)).toEqual(inserted);
    const removed = reschedule({ ...inserted, calendar_events: [] }, inserted);
    expect(removed.projects[0].end_at).toBe(at(5, 17));
    const holiday = {
      ...before,
      weekday_rules: before.weekday_rules.map((r) =>
        r.weekday === 1 ? { ...r, is_working: false } : r,
      ),
    };
    const postponed = reschedule(holiday, before);
    expect(postponed.projects[0].end_at).toBe(at(6, 17));
    expect(reschedule(postponed, postponed)).toEqual(postponed);
    expect(
      reschedule(
        { ...postponed, weekday_rules: before.weekday_rules },
        postponed,
      ).projects[0].end_at,
    ).toBe(at(5, 17));
  });
  it("respects explicitly changed/new taskless project bounds and duration modes", () => {
    const before = snapshot({ tasks: [] });
    const explicit = { ...before, projects: [project({ end_at: at(7, 17) })] };
    expect(reschedule(explicit, before).projects[0].end_at).toBe(at(7, 17));
    expect(reschedule(before, snapshot({ projects: [], tasks: [] }))).toEqual(
      before,
    );
    const wholeDays = {
      ...before,
      projects: [project({ duration_mode: "full_days" as const })],
    };
    expect(reschedule(wholeDays, before).projects[0].end_at).toBe(at(5, 17));
    const weekend = { ...before, projects: [project({ end_at: at(10, 15) })] };
    expect(reschedule(weekend, weekend)).toEqual(weekend);
    const full = {
      ...before,
      projects: [
        project({
          duration_mode: "full_days" as const,
          start_at: at(9, 14),
          end_at: at(12, 14),
        }),
      ],
    };
    const holiday = event({
      start_at: at(12),
      end_at: at(12, 10),
      override: { target_type: "project", target_id: "p", mode: "exclude" },
    });
    const shifted = reschedule({ ...full, calendar_events: [holiday] }, full);
    expect(shifted.projects[0].end_at).toBe(at(13, 14));
    expect(reschedule(shifted, shifted)).toEqual(shifted);
  });
});

describe("project extension", () => {
  it("allows project-only changes and moves all project tasks preserving working durations", () => {
    const tasks = [
      task(),
      task("b", { project_id: "other" }),
      task("gone", { deleted_at: 1 }),
    ];
    const only = extendProject(project(), tasks, [], at(6, 17), false, () =>
      context(),
    );
    expect(only.project.end_at).toBe(at(6, 17));
    expect(only.tasks).toEqual(tasks);
    const moved = extendProject(project(), tasks, [], at(6, 17), true, () =>
      context(),
    );
    expect(moved.tasks[0].start_at).toBe(at(6));
    expect(moved.tasks[0].end_at).toBe(at(6, 10));
    expect(moved.tasks[1]).toEqual(tasks[1]);
    expect(moved.tasks[2]).toEqual(tasks[2]);
    expect(tasks[0].start_at).toBe(at(5));
  });
  it("handles shortening, inferred duration, milestones, propagation and empty projects", () => {
    const p = project({ end_at: at(6, 17) });
    const moved = extendProject(
      p,
      [
        task("a", {
          start_at: at(6),
          end_at: at(6, 10),
          duration_minutes: null,
        }),
        task("b", { milestone: true }),
      ],
      [edge()],
      at(5, 17),
      true,
      () => context(),
    );
    expect(moved.tasks[0].start_at).toBe(at(5));
    expect(moved.tasks[0].end_at).toBe(at(5, 10));
    expect(moved.tasks[1].start_at).toBe(at(5, 10));
    expect(moved.tasks[1].end_at).toBe(at(5, 10));
    expect(
      extendProject(p, [], [], at(7), true, () => context()).project.end_at,
    ).toBe(at(7));
    expect(() => extendProject(p, [], [], NaN, false, () => context())).toThrow(
      "Invalid",
    );
    expect(() =>
      extendProject(p, [], [], at(4), false, () => context()),
    ).toThrow("Invalid");
  });
});

describe("reminder rebuilding", () => {
  let sequence = 0;
  const id = (): string => `r${++sequence}`;
  it("builds task/project/event absolute times and deduplicates offsets", () => {
    const input = snapshot({ calendar_events: [event()] });
    input.settings.default_reminder_offsets = [0, 60, 60];
    const result = buildReminders(input, at(5, 8), id);
    expect(result).toHaveLength(6);
    expect(
      result.filter((r) => r.entity_type === "event").map((r) => r.trigger_at),
    ).toEqual([at(5, 9), at(5, 10)]);
    expect(
      result.every(
        (r) =>
          r.version === 1 &&
          r.deleted_at === null &&
          r.fired_at === null &&
          r.snoozed_to === null,
      ),
    ).toBe(true);
    expect(result.find((r) => r.entity_type === "project")?.message_key).toBe(
      "reminder.project",
    );
    expect(result.find((r) => r.entity_type === "task")?.params.name).toBe("a");
    expect(input.reminders).toEqual([]);
  });
  it("preserves IDs/fired/snoozed unchanged occurrences including overdue history", () => {
    const input = snapshot({
      calendar_events: [event({ rrule: "FREQ=DAILY;COUNT=3" })],
    });
    const initial = buildReminders(input, at(5, 8), id);
    initial[0].fired_at = at(5, 9);
    initial[0].snoozed_to = at(5, 9, 30);
    input.reminders = initial;
    const output = buildReminders(input, at(6, 12), id);
    expect(output.find((r) => r.id === initial[0].id)).toEqual(initial[0]);
    expect(
      buildReminders({ ...input, reminders: output }, at(6, 12), id),
    ).toEqual(output);
    expect(output.filter((r) => r.entity_type === "event")).toHaveLength(6);
  });
  it("rebuilds changed dates, removes deleted/done entity reminders, retains custom and snooze children", () => {
    const input = snapshot();
    input.reminders = buildReminders(input, at(5, 8), id);
    const old = input.reminders.find((r) => r.entity_type === "task")!;
    const custom: Reminder = {
      ...old,
      id: "custom",
      entity_type: "custom",
      params: {},
      trigger_at: at(1),
    };
    const snooze: Reminder = {
      ...old,
      id: "snooze",
      params: { snooze_of: old.id },
      trigger_at: at(5, 11),
    };
    input.reminders.push(custom, snooze, {
      ...custom,
      id: "deleted",
      deleted_at: 1,
    });
    input.tasks[0].end_at = at(6, 10);
    input.projects[0].status = "done";
    const output = buildReminders(input, at(5, 8), id);
    expect(output.some((r) => r.id === old.id)).toBe(false);
    expect(output.some((r) => r.entity_type === "project")).toBe(false);
    expect(output.find((r) => r.id === "custom")).toEqual(custom);
    expect(output.find((r) => r.id === "snooze")).toEqual(snooze);
    expect(output.some((r) => r.id === "deleted")).toBe(false);
  });
  it("supports old reminder records without occurrence params and skips new past/out-of-horizon times", () => {
    const input = snapshot();
    input.reminders = buildReminders(input, at(5, 8), id).map((r) => ({
      ...r,
      params: {},
    }));
    const output = buildReminders(input, at(6), id);
    expect(output.map((r) => r.id)).toEqual(input.reminders.map((r) => r.id));
    expect(buildReminders(snapshot(), at(6), id)).toEqual([]);
    expect(
      buildReminders(
        snapshot({
          projects: [project({ end_at: at(1, 9, 0, 0, 2030) })],
          tasks: [],
        }),
        at(5),
        id,
      ),
    ).toEqual([]);
  });
  it("includes recurring event occurrences and offsets whose triggers lie within the horizon", () => {
    const input = snapshot({
      projects: [],
      tasks: [],
      calendar_events: [
        event({ rrule: "FREQ=DAILY;COUNT=3" }),
        event({ id: "deleted", deleted_at: 1 }),
      ],
    });
    expect(buildReminders(input, at(5, 8), id)).toHaveLength(6);
    const future = snapshot({
      projects: [],
      tasks: [],
      calendar_events: [event({ start_at: at(7), end_at: at(7, 10) })],
    });
    future.settings.default_reminder_offsets = [24 * 60];
    expect(buildReminders(future, at(6), id)[0].trigger_at).toBe(at(6));
  });
  it("supports no default offsets without removing independently scheduled custom reminders", () => {
    const input = snapshot();
    input.reminders = buildReminders(input, at(5, 8), id);
    input.reminders[0] = { ...input.reminders[0], entity_type: "custom" };
    input.settings.default_reminder_offsets = [];
    expect(buildReminders(input, at(5, 8), id)).toEqual([input.reminders[0]]);
  });
  it("honors archived/deleted entities and validates time/offset inputs", () => {
    const input = snapshot({
      projects: [
        project({ deleted_at: 1 }),
        project({ id: "archived", status: "archived" }),
      ],
      tasks: [
        task("a", { status: "done" }),
        task("b", { status: "archived" }),
        task("c", { deleted_at: 1 }),
      ],
    });
    expect(buildReminders(input, at(5), id)).toEqual([]);
    expect(() => buildReminders(input, NaN, id)).toThrow("time");
    input.settings.default_reminder_offsets = [-1];
    expect(() => buildReminders(input, at(5), id)).toThrow("offsets");
  });
});
