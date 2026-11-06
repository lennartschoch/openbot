import type { PushNotificationsNative } from "./push-notifications-native.types";

/** UnifiedPush is the Android transport of notifications. An iPhone uses Apple Push Notifications. */
export const unifiedPushNotifications: PushNotificationsNative | null = null;

export function pickUnifiedPushDistributor(): void {
  // No distributor on iOS.
}

/** The distributor app of this registration. An iPhone has none. */
export function unifiedPushDistributor(): string | null {
  const none: string | null = null;
  return none;
}
