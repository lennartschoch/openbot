import {
  androidPermission,
  previewAndroidSound,
  removeAndroidKeys,
  writeAndroidKeys,
} from "./android-notification-support";
import type { PushNotificationsNative } from "./push-notifications-native.types";

/**
 * The Firebase Cloud Messaging transport. The phone gives the app a token, and the host sends the
 * sealed notification through the OpenBot relay and Google. `OpenBotMessagingService.kt` opens it.
 */
export const androidPushNotifications: PushNotificationsNative = {
  permission: androidPermission,
  async deviceToken() {
    // A build without the Firebase file of the app has no token, and the promise rejects.
    return null;
  },
  onDeviceToken() {
    // Fork: Firebase Cloud Messaging is off, so the phone gives no new token.
    return () => undefined;
  },
  writeKeys: writeAndroidKeys,
  removeKeys: removeAndroidKeys,
  previewSound: previewAndroidSound,
};
