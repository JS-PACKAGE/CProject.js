import type { Project, Task } from "./types";

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}
function calculate(
  task: Task,
  children: Map<string, Task[]>,
  path: Set<string>,
): number {
  if (path.has(task.id)) throw new Error("Task hierarchy cycle detected");
  if (task.progress_manual !== null) return clamp(task.progress_manual);
  path.add(task.id);
  const descendants = children.get(task.id) ?? [];
  const result = descendants.length
    ? descendants.reduce(
        (sum, child) => sum + calculate(child, children, path),
        0,
      ) / descendants.length
    : clamp(task.progress);
  path.delete(task.id);
  return result;
}
function index(tasks: Task[]): Map<string, Task[]> {
  const result = new Map<string, Task[]>();
  for (const task of tasks)
    if (task.deleted_at === null && task.parent_id !== null) {
      const list = result.get(task.parent_id) ?? [];
      list.push(task);
      result.set(task.parent_id, list);
    }
  return result;
}
export function taskProgress(task: Task, tasks: Task[]): number {
  return calculate(
    task,
    index(tasks.filter((t) => t.project_id === task.project_id)),
    new Set(),
  );
}
export function projectProgress(project: Project, tasks: Task[]): number {
  if (project.progress_manual !== null) return clamp(project.progress_manual);
  const active = tasks.filter(
      (t) => t.deleted_at === null && t.project_id === project.id,
    ),
    ids = new Set(active.map((t) => t.id));
  const children = index(active),
    roots = active.filter((t) => t.parent_id === null || !ids.has(t.parent_id));
  // Validate even components not reachable from a root.
  for (const task of active) calculate(task, children, new Set());
  return roots.length
    ? roots.reduce(
        (sum, task) => sum + calculate(task, children, new Set()),
        0,
      ) / roots.length
    : 0;
}
