import { useCallback, useEffect, useState } from "react";
import i18n from "i18next";
import type { Reminder, Snapshot } from "../core/types";
import { app } from "../data/app";
import { sync, type SyncState } from "../sync/client";

export type NotificationStatus = NotificationPermission | "unsupported" | "insecure" | "error";
export interface BrowserNotifications {
  status: NotificationStatus;
  requestPermission: () => Promise<void>;
}
export function workspaceIdentity(state: SyncState): string {
  return `${state.mode}:${state.serverUrl}`;
}
function permissionStatus(): NotificationStatus {
  if (!("Notification" in window)) return "unsupported";
  if (!window.isSecureContext) return "insecure";
  return Notification.permission;
}
export function reminderText(reminder: Reminder, snapshot: Snapshot): string {
  const t = i18n.getFixedT(snapshot.settings.language);
  const name = (reminder.entity_type === "project"
    ? snapshot.projects.find((row) => row.id === reminder.entity_id)?.name
    : reminder.entity_type === "task"
      ? snapshot.tasks.find((row) => row.id === reminder.entity_id)?.name
      : reminder.entity_type === "event"
        ? snapshot.calendar_events.find((row) => row.id === reminder.entity_id)?.title
        : undefined) ?? reminder.params.name ?? "";
  return t(reminder.message_key, {
    ...reminder.params, name, defaultValue: t("reminderTitle", { name }),
  });
}
let registration: Promise<ServiceWorkerRegistration> | undefined;
function notificationWorker(): Promise<ServiceWorkerRegistration> {
  registration ??= navigator.serviceWorker.register("/notification-worker.js")
    .then(async (worker) => {
      if (!worker.active) {
        await new Promise<void>((resolve, reject) => {
          const installing = worker.installing ?? worker.waiting;
          if (!installing) { reject(new Error("Notification worker unavailable")); return; }
          const changed = () => {
            if (installing.state === "activated" || installing.state === "redundant") {
              installing.removeEventListener("statechange", changed);
              if (installing.state === "activated") resolve();
              else reject(new Error("Notification worker failed"));
            }
          };
          installing.addEventListener("statechange", changed);
          changed();
        });
      }
      return worker;
    }).catch((error: unknown) => { registration = undefined; throw error; });
  return registration;
}
export function useBrowserReminders(enabled: boolean, identity: string): BrowserNotifications {
  const [status, setStatus] = useState<NotificationStatus>(permissionStatus);
  const requestPermission = useCallback(async () => {
    if (permissionStatus() === "unsupported" || permissionStatus() === "insecure") return;
    try { setStatus(await Notification.requestPermission()); }
    catch { setStatus("error"); }
    window.dispatchEvent(new Event("cproject-notification-permission"));
  }, []);
  useEffect(() => {
    let disposed = false;
    let running = false;
    let invalidated = false;
    const notifications = new Set<Notification>();
    const prefix = `cproject:${identity}:`;
    const current = () => {
      const state = sync.getState();
      return !disposed && !invalidated && enabled && state.phase === "ready" &&
        workspaceIdentity(state) === identity;
    };
    const closeWorkspaceNotifications = () => {
      for (const notification of notifications) notification.close();
      notifications.clear();
      const worker = registration ?? ("serviceWorker" in navigator
        ? navigator.serviceWorker.getRegistration() : undefined);
      if (worker) void worker.then(async (worker) => {
        if (!worker) return;
        for (const notification of await worker.getNotifications()) {
          if (notification.tag.startsWith(prefix)) {
            notification.close();
          }
        }
      }).catch(() => {});
    };
    const unsubscribe = sync.subscribe(() => {
      if (!current()) {
        invalidated = true;
        closeWorkspaceNotifications();
      }
    });
    async function deliver(reminder: Reminder, snapshot: Snapshot): Promise<boolean> {
      if (!current() || permissionStatus() !== "granted") return false;
      const options: NotificationOptions = {
        body: reminderText(reminder, snapshot), lang: snapshot.settings.language,
        silent: !snapshot.settings.notification_sound, tag: `${prefix}${reminder.id}`,
        data: { url: "/" },
      };
      const title = `CProject · ${i18n.getFixedT(snapshot.settings.language)("reminder")}`;
      try {
        if ("serviceWorker" in navigator) {
          const worker = await notificationWorker();
          if (!current() || permissionStatus() !== "granted") return false;
          await worker.showNotification(title, options);
          if (!current()) {
            for (const notification of await worker.getNotifications({ tag: options.tag })) notification.close();
            return false;
          }
        } else {
          if (!current()) return false;
          const notification = new Notification(title, options);
          notifications.add(notification);
          notification.onclick = () => { window.focus(); notification.close(); };
          const shown = await new Promise<boolean>((resolve) => {
            notification.onclose = () => { notifications.delete(notification); resolve(false); };
            notification.onshow = () => resolve(true);
            notification.onerror = () => { notification.close(); resolve(false); };
          });
          if (!shown || !current()) {
            notification.close();
            if (!shown && current()) setStatus("error");
            return false;
          }
        }
        if (!disposed) setStatus(permissionStatus());
        return true;
      } catch {
        if (!disposed) setStatus("error");
        return false;
      }
    }
    async function refresh() {
      const permission = permissionStatus();
      if (!disposed) setStatus(permission);
      if (!current() || permission !== "granted" || running) return;
      running = true;
      try {
        const dispatch = async () => { if (current()) await app.deliverReminders(deliver); };
        if (navigator.locks) {
          await navigator.locks.request(`cproject-reminders:${identity}`, { ifAvailable: true }, async (lock) => {
            if (lock) await dispatch();
          });
        } else await dispatch();
      } catch { if (!disposed) setStatus("error"); }
      finally { running = false; }
    }
    const onVisible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", onVisible);
    window.addEventListener("cproject-notification-permission", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(() => void refresh(), 15_000);
    void refresh();
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe();
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("cproject-notification-permission", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
      closeWorkspaceNotifications();
    };
  }, [enabled, identity]);
  return { status, requestPermission };
}
