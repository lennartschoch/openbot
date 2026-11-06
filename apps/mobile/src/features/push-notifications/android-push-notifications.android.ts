import { File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import type { NotificationPermission } from "@/features/settings/model/push-notifications";
import { androidChannelId, createAndroidChannels } from "./android-notification-channels";
import { type PushNotificationsNative, SOUND_PREVIEW_KEY } from "./push-notifications-native.types";

/** `OpenBotMessagingService.kt` reads this file in the files folder of the app (`Paths.document`). */
const KEYS_FILE = "push-notifications.json";

/**
 * The Firebase messaging service of the app opens the notifications also while the app does not
 * run, so the app writes the keys of each server into its own files folder, which only the app can
 * read. The keys open notifications only, and a new phone secret after sign-out makes them useless.
 */
export const androidPushNotifications: PushNotificationsNative = {
  async permission(asked) {
    await createAndroidChannels();
    const current = await Notifications.getPermissionsAsync();
    if (current.status !== "undetermined") return permissionOf(current);
    const answer = permissionOf(await Notifications.requestPermissionsAsync());
    asked?.(answer);
    return answer;
  },
  async deviceToken() {
    // Fork: Firebase Cloud Messaging is off. A later push transport supplies the token.
    return null;
  },
  onDeviceToken() {
    // Fork: Firebase Cloud Messaging is off, so the phone gives no new token.
    return () => undefined;
  },
  writeKeys(servers) {
    const text = JSON.stringify({ version: 1, servers });
    const file = new File(Paths.document, KEYS_FILE);
    if (file.exists && file.textSync() === text) return;
    file.writeSync(text);
  },
  removeKeys() {
    const file = new File(Paths.document, KEYS_FILE);
    if (file.exists) file.delete();
  },
  async previewSound(sound) {
    // The channel of the sound plays it, as it plays a notification. The handler shows nothing.
    await Notifications.scheduleNotificationAsync({
      content: { data: { [SOUND_PREVIEW_KEY]: true } },
      trigger: { channelId: androidChannelId(sound) },
    });
  },
};

function permissionOf(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (status.granted) return "granted";
  return status.status === "undetermined" ? "undetermined" : "denied";
}
