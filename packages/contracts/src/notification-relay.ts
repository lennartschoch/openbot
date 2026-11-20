export const NOTIFICATION_SOUNDS = ["openbot", "warm", "mech", "bubble", "press", "default"] as const;
export type NotificationSound = (typeof NOTIFICATION_SOUNDS)[number];

export interface NotificationRelayPush {
  token: string;
  environment: "production" | "development";
  sessionId: string;
  sealed: string;
  sound: NotificationSound | null;
  timestamp: number;
}

export interface AndroidNotificationRelayPush {
  token: string;
  sessionId: string;
  sealed: string;
  sound: NotificationSound | null;
  timestamp: number;
}

/**
 * One Android notification that a host sends through UnifiedPush: the host posts the sealed
 * notification and the sound to the phone's ntfy endpoint, and the app opens the seal before Android
 * shows the notification. No account service and no Google service sit between the host and the
 * ntfy server, so the ntfy server sees the app name only.
 */
export interface UnifiedNotificationRelayPush {
  /** The full URL of the phone's ntfy topic (`ANDROID_UNIFIED_PUSH_ENDPOINT_PATTERN`). */
  endpoint: string;
  /** The account session of the phone on this host, as for `NotificationRelayPush`. */
  sessionId: string;
  /** The sealed notification, base64url. */
  sealed: string;
  /** The sound that the app plays, or `null` for none. */
  sound: NotificationSound | null;
  /** When the host made the notification, in seconds. */
  timestamp: number;
}

/**
 * A sealed notification above this size would not fit the 4 KB Apple payload with its envelope.
 * Firebase Cloud Messaging data messages have the same 4 KB limit.
 */
export const NOTIFICATION_SEALED_LIMIT = 3_600;
export const NOTIFICATION_TOKEN_PATTERN = /^(?:[0-9a-f]{2}){8,256}$/u;
export const NOTIFICATION_SOUND_FILES: Readonly<Record<Exclude<NotificationSound, "default">, string>> = {
  openbot: "openbot-task.wav",
  warm: "openbot-warm.wav",
  mech: "openbot-mech.wav",
  bubble: "openbot-bubble.wav",
  press: "openbot-press.wav",
};
