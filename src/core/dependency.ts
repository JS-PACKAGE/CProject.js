import { advance, workingMinutesBetween } from "./calendar";
import type { CalendarContext, Dependency, DurationMode, Task } from "./types";

function graph(tasks: Task[], dependencies: Dependency[]) {
  const active = tasks.filter((t) => t.deleted_at === null),
    byId = new Map(active.map((t) => [t.id, t]));
  const children = new Map<string, Task[]>();
  for (const task of active)
    if (task.parent_id) {
      if (
        !byId.has(task.parent_id) ||
        byId.get(task.parent_id)!.project_id !== task.project_id
      )
        throw new Error("Invalid task parent");
      const list = children.get(task.parent_id) ?? [];
      list.push(task);
      children.set(task.parent_id, list);
    }
  const leafCache = new Map<string, string[]>();
  const leaves = (id: string, path = new Set<string>()): string[] => {
    if (path.has(id)) throw new Error("Task hierarchy cycle detected");
    const cached = leafCache.get(id);
    if (cached) return cached;
    path.add(id);
    const list = children.get(id);
    const result = list ? list.flatMap((t) => leaves(t.id, path)) : [id];
    path.delete(id);
    leafCache.set(id, result);
    return result;
  };
  for (const task of active) leaves(task.id);
  const leafIds = active.filter((t) => !children.has(t.id)).map((t) => t.id);
  const outgoing = new Map(leafIds.map((id) => [id, [] as string[]])),
    degree = new Map(leafIds.map((id) => [id, 0]));
  const incoming = new Map<string, Dependency[]>();
  for (const edge of dependencies.filter((d) => d.deleted_at === null)) {
    if (
      !byId.has(edge.predecessor_task_id) ||
      !byId.has(edge.successor_task_id)
    )
      throw new Error(`Dependency ${edge.id} references missing task`);
    if (
      byId.get(edge.predecessor_task_id)!.project_id !== edge.project_id ||
      byId.get(edge.successor_task_id)!.project_id !== edge.project_id
    )
      throw new Error("Dependency crosses project boundary");
    for (const target of leaves(edge.successor_task_id)) {
      const list = incoming.get(target) ?? [];
      list.push(edge);
      incoming.set(target, list);
      for (const source of leaves(edge.predecessor_task_id)) {
        outgoing.get(source)!.push(target);
        degree.set(target, degree.get(target)! + 1);
      }
    }
  }
  const order = leafIds.filter((id) => degree.get(id) === 0);
  for (let i = 0; i < order.length; i++)
    for (const target of outgoing.get(order[i])!) {
      degree.set(target, degree.get(target)! - 1);
      if (degree.get(target) === 0) order.push(target);
    }
  if (order.length !== leafIds.length)
    throw new Error("Dependency cycle detected (including task containment)");
  return { order, byId, children, incoming };
}
export function assertAcyclic(tasks: Task[], dependencies: Dependency[]): void {
  graph(tasks, dependencies);
}
export function propagate(
  tasks: Task[],
  dependencies: Dependency[],
  contextFor: (task: Task) => CalendarContext,
  mode: DurationMode,
  pinned: ReadonlySet<string> = new Set(),
): Task[] {
  const result = tasks.map((t) => ({ ...t }));
  const { order, byId, children, incoming } = graph(result, dependencies);
  const summarize = (id: string): Task => {
    const task = byId.get(id)!,
      list = children.get(id);
    if (list && !pinned.has(id)) {
      const nested = list.map((t) => summarize(t.id));
      task.start_at = Math.min(...nested.map((t) => t.start_at));
      task.end_at = Math.max(...nested.map((t) => t.end_at));
    }
    return task;
  };
  for (const task of byId.values()) summarize(task.id);
  const initial = new Map([...byId].map(([id, task]) => [id, { ...task }]));
  for (const id of order) {
    if (pinned.has(id)) continue;
    const task = byId.get(id)!,
      context = contextFor(task);
    const duration = task.milestone
      ? 0
      : (task.duration_minutes ??
        workingMinutesBetween(task.start_at, task.end_at, context, mode));
    let start = task.start_at;
    for (const edge of incoming.get(id) ?? []) {
      if (!edge.propagate || pinned.has(edge.successor_task_id)) continue;
      const predecessor = summarize(edge.predecessor_task_id),
        target = initial.get(edge.successor_task_id)!;
      const source =
        edge.type === "FS" || edge.type === "FF"
          ? predecessor.end_at
          : predecessor.start_at;
      let required = advance(source, edge.lag_minutes, context, mode);
      const targetDuration =
        target.id === id
          ? duration
          : workingMinutesBetween(
              target.start_at,
              target.end_at,
              context,
              mode,
            );
      if (edge.type === "FF" || edge.type === "SF")
        required = advance(required, -targetDuration, context, mode);
      const offset =
        target.id === id
          ? 0
          : workingMinutesBetween(
              target.start_at,
              initial.get(id)!.start_at,
              context,
              mode,
            );
      required = advance(required, offset, context, mode);
      start = Math.max(start, required);
    }
    if (start !== task.start_at || task.milestone) {
      task.start_at = start;
      task.end_at = advance(start, duration, context, mode);
    }
  }
  for (const task of byId.values()) summarize(task.id);
  return result;
}
export function dependencyConflicts(
  tasks: Task[],
  dependencies: Dependency[],
  contextFor?: (task: Task) => CalendarContext,
  mode: DurationMode = "working_hours",
): string[] {
  const byId = new Map(
    tasks.filter((t) => t.deleted_at === null).map((t) => [t.id, t]),
  );
  return dependencies
    .filter((edge) => {
      if (edge.deleted_at !== null) return false;
      const a = byId.get(edge.predecessor_task_id),
        b = byId.get(edge.successor_task_id);
      if (!a || !b) return true;
      const source =
        edge.type === "FS" || edge.type === "FF" ? a.end_at : a.start_at;
      const target =
        edge.type === "FS" || edge.type === "SS" ? b.start_at : b.end_at;
      const required = contextFor
        ? advance(source, edge.lag_minutes, contextFor(b), mode)
        : source + edge.lag_minutes * 60_000;
      return target < required;
    })
    .map((edge) => edge.id);
}
