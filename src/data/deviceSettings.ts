const SOUND_KEY = "cproject-notification-sound";
let notificationSound = true;

export function getNotificationSound(): boolean {
  try {
    const stored = localStorage.getItem(SOUND_KEY);
    notificationSound = stored !== "false";
  } catch {
    // Keep this page's preference when browser storage is unavailable.
  }
  return notificationSound;
}

export function setNotificationSound(value: boolean): void {
  notificationSound = value;
  try {
    localStorage.setItem(SOUND_KEY, String(value));
  } catch {
    // Keep this page's preference when browser storage is unavailable.
  }
}
