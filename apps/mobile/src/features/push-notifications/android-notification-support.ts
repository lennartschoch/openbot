import { File, Paths } from "expo-file-system";
import * as Notifications from "expo-notifications";
import type { NotificationPermission } from "@/features/settings/model/push-notifications";
import { androidChannelId, createAndroidChannels } from "./android-notification-channels";
import { SOUND_PREVIEW_KEY } from "./push-notifications-native.types";

/** `OpenBotMessagingService.kt` and `OpenBotUnifiedPushService.kt` read this file in the app files. */
const KEYS_FILE = "push-notifications.json";

/** The shared parts of both Android transports: permission, the key file, and the sound preview. */

export async function androidPermission(
  asked?: (answer: NotificationPermission) => void,
): Promise<NotificationPermission> {
  await createAndroidChannels();
  const current = await Notifications.getPermissionsAsync();
  if (current.status !== "undetermined") return permissionOf(current);
  const answer = permissionOf(await Notifications.requestPermissionsAsync());
  asked?.(answer);
  return answer;
}

/**
 * The Firebase messaging service of the app opens the notifications also while the app does not
 * run, so the app writes the keys of each server into its own files folder, which only the app can
 * read. The keys open notifications only, and a new phone secret after sign-out makes them useless.
 */
export function writeAndroidKeys(
  servers: readonly { serverId: string; name: string; seal: string; tag: string }[],
): void {
  const text = JSON.stringify({ version: 1, servers });
  const file = new File(Paths.document, KEYS_FILE);
  if (file.exists && file.textSync() === text) return;
  file.writeSync(text);
}

export function removeAndroidKeys(): void {
  const file = new File(Paths.document, KEYS_FILE);
  if (file.exists) file.delete();
}

export async function previewAndroidSound(sound: Parameters<typeof androidChannelId>[0]): Promise<void> {
  // The channel of the sound plays it, as it plays a notification. The handler shows nothing.
  await Notifications.scheduleNotificationAsync({
    content: { data: { [SOUND_PREVIEW_KEY]: true } },
    trigger: { channelId: androidChannelId(sound) },
  });
}

function permissionOf(status: Notifications.NotificationPermissionsStatus): NotificationPermission {
  if (status.granted) return "granted";
  return status.status === "undetermined" ? "undetermined" : "denied";
}
