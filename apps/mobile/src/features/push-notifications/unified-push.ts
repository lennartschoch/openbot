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

/** The distributor apps that answer. An iPhone has none. */
export function unifiedPushDistributors(): string[] {
  return [];
}

/** Registers with one distributor app. An iPhone has none. */
export function registerWithUnifiedPushDistributor(_distributor: string): void {
  // No distributor on iOS.
}

/** Opens the distributor app. An iPhone has none. */
export function openUnifiedPushDistributor(_distributor: string): void {
  // No distributor on iOS.
}

/** The name of a distributor app. An iPhone has none. */
export function unifiedPushDistributorLabel(_distributor: string): string {
  return "";
}
