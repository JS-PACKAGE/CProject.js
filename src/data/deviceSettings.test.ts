import { afterEach, describe, expect, it, vi } from "vitest";
import { getNotificationSound, setNotificationSound } from "./deviceSettings";

afterEach(() => vi.unstubAllGlobals());

describe("device sound preference", () => {
  it("defaults to enabled and stores only the sound preference", () => {
    const values = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => { values.set(key, value); });
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem });
    expect(getNotificationSound()).toBe(true);
    setNotificationSound(false);
    expect(getNotificationSound()).toBe(false);
    expect(setItem).toHaveBeenCalledExactlyOnceWith("cproject-notification-sound", "false");
    expect(values.size).toBe(1);
    values.clear();
    expect(getNotificationSound()).toBe(true);
  });
  it("retains this page's choice when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("Storage blocked"); },
      setItem: () => { throw new Error("Storage blocked"); },
    });
    setNotificationSound(false);
    expect(getNotificationSound()).toBe(false);
    setNotificationSound(true);
    expect(getNotificationSound()).toBe(true);
  });
});
