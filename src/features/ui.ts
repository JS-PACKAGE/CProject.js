import { create } from "zustand";
import type { TableName, Tables } from "../core/types";
export type View =
  "projects" | "calendar" | "timeline" | "reminders" | "settings";
export interface EditorState {
  table: TableName;
  value?: Tables[TableName];
  defaults?: Record<string, unknown>;
}
interface UI {
  view: View;
  selected: string | null;
  date: number;
  calendarMode: "month" | "week";
  editor: EditorState | null;
  extension: { id: string; end: number } | null;
  query: string;
  set: (patch: Partial<Omit<UI, "set">>) => void;
}
export const useUI = create<UI>((set) => ({
  view: "projects",
  selected: null,
  date: Date.now(),
  calendarMode: "month",
  editor: null,
  extension: null,
  query: "",
  set,
}));
export const day = 86400000;
export function localInput(at: number): string {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function localDate(at: number): string {
  return localInput(at).slice(0, 10);
}
export function dayStart(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return +d;
}
export function addDays(at: number, count: number): number {
  const d = new Date(at);
  d.setDate(d.getDate() + count);
  return +d;
}
