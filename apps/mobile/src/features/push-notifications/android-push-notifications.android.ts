import {
  androidPermission,
  previewAndroidSound,
  removeAndroidKeys,
  writeAndroidKeys,
} from "./android-notification-support";
import type { PushNotificationsNative } from "./push-notifications-native.types";

/**
 * The parts of a notification that do not belong to a transport: the permission, the key file, and the
 * sound preview. The fork pushes over UnifiedPush only (`unified-push.android.ts`); Firebase Cloud
 * Messaging is gone from the build (`scripts/fork/strip-google.mjs`), so there is no device token.
 */
export const androidPushNotifications: PushNotificationsNative = {
  permission: androidPermission,
  async deviceToken() {
    return null;
  },
  onDeviceToken() {
    // Without Firebase the phone has no token to give, and no token to renew.
    return () => undefined;
  },
  writeKeys: writeAndroidKeys,
  removeKeys: removeAndroidKeys,
  previewSound: previewAndroidSound,
};
