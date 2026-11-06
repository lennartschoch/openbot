import type { EventSubscription, NativeModule } from "expo";
import { requireOptionalNativeModule } from "expo";
import {
  androidPermission,
  previewAndroidSound,
  removeAndroidKeys,
  writeAndroidKeys,
} from "./android-notification-support";
import type { PushNotificationsNative } from "./push-notifications-native.types";

declare class UnifiedPushModule extends NativeModule {
  register(messageForDistributor: string | null): void;
  unregister(): void;
  getEndpoint(): string | null;
  getDistributor(): string | null;
  pickDistributor(): void;
  addListener(event: "onEndpoint", listener: (event: { endpoint: string | null }) => void): EventSubscription;
}

/** `modules/android-notifications`. Expo Go on Android has no UnifiedPush. */
const native = requireOptionalNativeModule<UnifiedPushModule>("AndroidNotifications");

/** Opens the phone's UnifiedPush distributor picker, such as the ntfy app. */
export function pickUnifiedPushDistributor(): void {
  native?.pickDistributor();
}

/** The distributor app of this registration, such as the ntfy app's package, or `null`. */
export function unifiedPushDistributor(): string | null {
  return native?.getDistributor() ?? null;
}

/**
 * The UnifiedPush transport: the endpoint of one topic on the ntfy server of the distributor, with
 * no Google Play Services. `OpenBotUnifiedPushService.kt` opens the seal and shows the notification.
 */
export const unifiedPushNotifications: PushNotificationsNative | null = native
  ? {
      permission: androidPermission,
      async deviceToken() {
        // A registration asks the distributor for the endpoint; it answers with an `onEndpoint` event.
        native.register("OpenBot");
        return native.getEndpoint();
      },
      onDeviceToken(listener) {
        const subscription = native.addListener("onEndpoint", (event) => listener(event.endpoint));
        return () => subscription.remove();
      },
      writeKeys: writeAndroidKeys,
      removeKeys: removeAndroidKeys,
      previewSound: previewAndroidSound,
    }
  : null;
