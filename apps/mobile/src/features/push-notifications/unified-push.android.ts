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
  distributors(): string[];
  registerWith(distributor: string, messageForDistributor: string | null): void;
  openDistributor(distributor: string): void;
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
 * Every distributor app that answers. The connector knows the v3 distributors (a service); ntfy
 * answers with a v2 receiver, which the native module adds to this list.
 */
export function unifiedPushDistributors(): string[] {
  return native?.distributors() ?? [];
}

/** Chooses one distributor by package, which is how a v2 distributor such as ntfy is picked. */
export function registerWithUnifiedPushDistributor(distributor: string): void {
  native?.registerWith(distributor, "OpenBot");
}

/** Opens the distributor app, where the user picks the ntfy server and confirms the topic. */
export function openUnifiedPushDistributor(distributor: string): void {
  native?.openDistributor(distributor);
}

/** The app label of a distributor package, with the app's own name as the last resort. */
export function unifiedPushDistributorLabel(distributor: string): string {
  const known: Record<string, string> = {
    "io.heckel.ntfy": "ntfy",
    "org.unifiedpush.android.distributor": "UnifiedPush Distributions",
  };
  return known[distributor] ?? distributor.split(".").filter(Boolean).at(-1) ?? distributor;
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
