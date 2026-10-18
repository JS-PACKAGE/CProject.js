import { describe, expect, it } from "vitest";
import { assertAcyclic, dependencyConflicts, propagate } from "./dependency";
import { projectProgress, taskProgress } from "./progress";
import { at, context, edge, project, task } from "./fixtures.test-helper";

describe("dependency graph", () => {
  it("rejects all cycles including disconnected nonpropagating edges and self edges", () => {
    expect(() =>
      assertAcyclic(
        [task("a"), task("b")],
        [edge(), edge("b", "a", { propagate: false })],
      ),
    ).toThrow("cycle");
    expect(() => assertAcyclic([task()], [edge("a", "a")])).toThrow("cycle");
    expect(() => assertAcyclic([task()], [edge()])).toThrow("missing");
    expect(() =>
      assertAcyclic([task(), task("b", { deleted_at: 1 })], [edge()]),
    ).toThrow("missing");
    expect(() =>
      assertAcyclic([task()], [edge("a", "a", { deleted_at: 1 })]),
    ).not.toThrow();
    expect(() => assertAcyclic([], [])).not.toThrow();
  });
  it("processes fan-in topologically independent of input and preserves durations", () => {
    const tasks = [
      task("c"),
      task("b", {
        start_at: at(5, 13),
        end_at: at(5, 15),
        duration_minutes: 120,
      }),
      task("a"),
    ];
    const result = propagate(
      tasks,
      [edge("a", "c"), edge("b", "c"), edge("a", "b", { lag_minutes: 60 })],
      () => context(),
      "working_hours",
    );
    expect(result[0].start_at).toBe(at(5, 15));
    expect(result[0].end_at).toBe(at(5, 16));
    expect(tasks[0].start_at).toBe(at(5));
    expect(
      propagate(
        result,
        [edge("a", "c"), edge("b", "c")],
        () => context(),
        "working_hours",
      ),
    ).toEqual(result);
  });
  it.each(["FS", "SS", "FF", "SF"] as const)(
    "implements %s constraints including negative lag",
    (type) => {
      const a = task("a", {
        start_at: at(5, 13),
        end_at: at(5, 16),
        duration_minutes: 180,
      });
      const result = propagate(
        [a, task("b", { duration_minutes: null })],
        [edge("a", "b", { type, lag_minutes: -60 })],
        () => context(),
        "working_hours",
      );
      const expected = {
        FS: at(5, 15),
        SS: at(5, 11),
        FF: at(5, 14),
        SF: at(5, 10),
      };
      expect(result[1].start_at).toBe(expected[type]);
      expect(
        dependencyConflicts(
          result,
          [edge("a", "b", { type, lag_minutes: -60 })],
          () => context(),
        ),
      ).toEqual([]);
    },
  );
  it("leaves disconnected dates fixed while reporting conflicts and missing tasks", () => {
    const tasks = [task("a", { end_at: at(5, 15) }), task("b")],
      deps = [
        edge("a", "b", { propagate: false }),
        edge("a", "missing", { id: "missing" }),
      ];
    expect(
      propagate(tasks, [deps[0]], () => context(), "working_hours"),
    ).toEqual(tasks);
    expect(dependencyConflicts(tasks, deps)).toEqual(["a-b", "missing"]);
    expect(
      dependencyConflicts(tasks, [edge("a", "b", { deleted_at: 1 })]),
    ).toEqual([]);
  });
  it("uses working rather than elapsed lag for conflicts when a calendar is supplied", () => {
    const tasks = [
      task("a", { end_at: at(9, 17) }),
      task("b", { start_at: at(12, 9, 30) }),
    ];
    expect(
      dependencyConflicts(tasks, [edge("a", "b", { lag_minutes: 60 })]),
    ).toEqual([]);
    expect(
      dependencyConflicts(tasks, [edge("a", "b", { lag_minutes: 60 })], () =>
        context(),
      ),
    ).toEqual(["a-b"]);
  });
  it("keeps milestones zero length and supports whole-day propagation", () => {
    const c = context(),
      a = task("a", { end_at: at(9, 14) });
    const result = propagate(
      [
        a,
        task("b", { milestone: true }),
        task("c", { duration_minutes: 1440 }),
      ],
      [edge("a", "b"), edge("b", "c", { lag_minutes: 1440 })],
      () => c,
      "full_days",
    );
    expect(result[1].start_at).toBe(at(9, 14));
    expect(result[1].end_at).toBe(at(9, 14));
    expect(result[2].start_at).toBe(at(12, 14));
    expect(result[2].end_at).toBe(at(13, 14));
  });
});

describe("hierarchy-aware dependency constraints", () => {
  it("rejects implicit feedback through containment even on disconnected edges", () => {
    const tasks = [task("a"), task("b", { parent_id: "a" }), task("c")];
    expect(() =>
      assertAcyclic(tasks, [edge("a", "b", { propagate: false })]),
    ).toThrow("cycle");
    expect(() => assertAcyclic(tasks, [edge("b", "a")])).toThrow("cycle");
    expect(() =>
      assertAcyclic([task("a", { parent_id: "missing" })], []),
    ).toThrow("parent");
    expect(() =>
      assertAcyclic(
        [task("a"), task("b", { project_id: "other", parent_id: "a" })],
        [],
      ),
    ).toThrow("parent");
  });
  it("schedules outgoing summary constraints after children and shifts incoming groups preserving offsets", () => {
    const tasks = [
      task("group"),
      task("a", { parent_id: "group" }),
      task("b", { parent_id: "group", start_at: at(5, 10), end_at: at(5, 11) }),
      task("pre", { end_at: at(5, 14), duration_minutes: 240 }),
      task("post"),
    ];
    const result = propagate(
      tasks,
      [edge("pre", "group"), edge("group", "post")],
      () => context(),
      "working_hours",
    );
    expect(result[1].start_at).toBe(at(5, 14));
    expect(result[2].start_at).toBe(at(5, 15));
    expect(result[0].start_at).toBe(at(5, 14));
    expect(result[0].end_at).toBe(at(5, 16));
    expect(result[4].start_at).toBe(at(5, 16));
    expect(result[4].end_at).toBe(at(5, 17));
    expect(
      propagate(
        result,
        [edge("pre", "group"), edge("group", "post")],
        () => context(),
        "working_hours",
      ),
    ).toEqual(result);
  });
  it("supports finish-based summary lag constraints", () => {
    const result = propagate(
      [
        task("g"),
        task("a", { parent_id: "g" }),
        task("b", { parent_id: "g", start_at: at(5, 10), end_at: at(5, 11) }),
        task("pre", { end_at: at(5, 16) }),
      ],
      [edge("pre", "g", { type: "FF" })],
      () => context(),
      "working_hours",
    );
    expect(result[0].end_at).toBe(at(5, 16));
    expect(result[0].start_at).toBe(at(5, 14));
  });
});

describe("progress aggregation", () => {
  it("equally weights direct children recursively rather than all leaves", () => {
    const tasks = [
      task("a"),
      task("b", { parent_id: "a", progress: 20 }),
      task("c", { parent_id: "a", progress: 80 }),
      task("d", { progress: 100 }),
    ];
    expect(taskProgress(tasks[0], tasks)).toBe(50);
    expect(projectProgress(project(), tasks)).toBe(75);
    expect(projectProgress(project(), [])).toBe(0);
  });
  it("honors manual zero, clamps, ignores deleted and unrelated children", () => {
    const tasks = [
      task("a", { progress_manual: 0 }),
      task("b", { parent_id: "a", progress: 100 }),
      task("c", { parent_id: "a", progress: 100, deleted_at: 1 }),
    ];
    expect(taskProgress(tasks[0], tasks)).toBe(0);
    expect(projectProgress(project({ progress_manual: 200 }), tasks)).toBe(100);
    expect(taskProgress(task("x", { progress: -5 }), [])).toBe(0);
    expect(taskProgress(task("x", { progress: NaN }), [])).toBe(0);
    expect(
      taskProgress(task("x", { progress: 50 }), [
        task("y", { project_id: "other", parent_id: "x", progress: 100 }),
      ]),
    ).toBe(50);
    expect(
      projectProgress(project(), [
        task("orphan", { parent_id: "gone", progress: 42 }),
      ]),
    ).toBe(42);
  });
  it("rejects disconnected hierarchy cycles", () => {
    const tasks = [
      task("a", { parent_id: "b" }),
      task("b", { parent_id: "a" }),
    ];
    expect(() => taskProgress(tasks[0], tasks)).toThrow("cycle");
    expect(() => projectProgress(project(), tasks)).toThrow("cycle");
  });
});
