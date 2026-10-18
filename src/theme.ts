import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";
interface ThemeState {
  preference: ThemePreference;
  theme: Theme;
}

// Device-local like autostart: the key and resolution must match public/theme-init.js.
const STORAGE_KEY = "cproject-theme";
const BAR_COLORS: Record<Theme, string> = { light: "#f6f7fb", dark: "#121319" };
const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
const desktop = isTauri();

function storedPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function resolve(preference: ThemePreference): ThemeState {
  return {
    preference,
    theme: preference === "system" ? (media.matches ? "dark" : "light") : preference,
  };
}

let state = resolve(storedPreference());

function apply(next: ThemeState, initial = false) {
  const nativeChanged = initial ? next.preference !== "system" : next.preference !== state.preference;
  state = next;
  const root = document.documentElement;
  if (!initial) {
    // Button transitions would otherwise fade through muddy in-between colors.
    root.classList.add("theme-switching");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  }
  root.dataset.theme = next.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR_COLORS[next.theme]);
  // Native title bars follow the OS unless told otherwise; null hands control back to the system.
  if (desktop && nativeChanged) void getCurrentWindow().setTheme(next.preference === "system" ? null : next.preference);
  listeners.forEach((listener) => listener());
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // The choice still applies to this page when storage is unavailable.
  }
  apply(resolve(preference));
}

export function toggleTheme() {
  setThemePreference(state.theme === "dark" ? "light" : "dark");
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

media.addEventListener("change", () => {
  if (state.preference === "system") apply(resolve("system"));
});
window.addEventListener("storage", (event) => {
  if (event.key === STORAGE_KEY || event.key === null) apply(resolve(storedPreference()));
});
apply(state, true);
