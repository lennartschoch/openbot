// Frozen optional push-notifications-android-v2 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: a signed-in member's Android
// phone gives the host its UnifiedPush endpoint, a secret that only the phone and the host know, and
// the events the member wants to hear about. While the phone says it is away, the host sends a
// notification for each such event of an agent this member can see, by posting the sealed
// notification to the endpoint, so an ntfy server and a UnifiedPush distributor deliver it without
// Google Play Services. The endpoint is the full HTTPS URL of one ntfy topic. Apart from the
// endpoint this is `push-notifications-android-v1`. The host keeps a registration for the session
// that sent it, also after it restarts, and forgets it when the phone removes it, when the member is
// removed or disabled, or when the ntfy server refuses it. Widening any of it needs a third
// capability string.
import {
  type AdminDecoder,
  adminRoute,
  boolean,
  count,
  empty,
  fields,
  identifier,
  nullable,
  type OptionalRouteCodec,
  oneOf,
  string,
} from "./admin-wire";
import {
  PUSH_NOTIFICATION_SOUNDS,
  type PushNotificationLevel,
  type PushNotificationSound,
} from "./push-notifications-v1";

export const ANDROID_UNIFIED_PUSH_NOTIFICATIONS_CAPABILITY = "push-notifications-android-v2";

export const ANDROID_UNIFIED_PUSH_NOTIFICATIONS_ROUTES = {
  register: "/v1/push-notifications/android-registration-v2",
  remove: "/v1/push-notifications/android-registration-v2/remove",
} as const;

/**
 * The UnifiedPush endpoint of the app: the full `https://` URL of one ntfy topic, such as
 * `https://ntfy.example.com/openbot-topic?up=1`. The host has DNS labels, and ntfy marks a
 * UnifiedPush endpoint with the `?up=1` query. Both are part of the URL that the distributor gives,
 * so the decoder accepts them. Without them no real endpoint passed, and no Android phone could
 * register.
 */
export const ANDROID_UNIFIED_PUSH_ENDPOINT_PATTERN =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*(?::\d{1,5})?(?:\/[A-Za-z0-9._~%-]{1,128}){1,8}(?:\?[A-Za-z0-9._~%=&+-]{1,128})?$/u;

export interface AndroidUnifiedPushNotificationRegistration {
  /** The phone's id for this host. The host puts it into the sealed notification for the tap. */
  serverId: string;
  /** The UnifiedPush endpoint of the app, the full URL of its ntfy topic. */
  token: string;
  /** 32 random bytes as base64url. */
  secret: string;
  /** The interface language of the phone. The host uses English for a language it does not have. */
  locale: string;
  /** `true` while the app is not on screen. Only then does the host send notifications. */
  away: boolean;
  level: PushNotificationLevel;
  /** No notification before this time, in seconds since 1970, or `null`. */
  mutedUntil: number | null;
  /** Whether the notification shows the start of a reply or a question, or only what happened. */
  preview: boolean;
  /**
   * The sound of notifications. "default" is the Android notification sound, and with "none"
   * notifications are silent.
   */
  sound: PushNotificationSound;
}

const pattern =
  (expression: RegExp, maximum: number): AdminDecoder =>
  (value) => {
    const text = string(maximum)(value);
    if (typeof text !== "string" || !expression.test(text)) throw new Error("Invalid push notification value.");
    return text;
  };

const pushEndpoint = pattern(ANDROID_UNIFIED_PUSH_ENDPOINT_PATTERN, 512);
const secret = pattern(/^[A-Za-z0-9_-]{43}$/u, 43);

export const ANDROID_UNIFIED_PUSH_NOTIFICATIONS_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [
    ANDROID_UNIFIED_PUSH_NOTIFICATIONS_ROUTES.register,
    adminRoute(
      fields({
        serverId: identifier,
        token: pushEndpoint,
        secret,
        locale: string(35),
        away: boolean,
        level: oneOf("all", "needs-me"),
        mutedUntil: nullable(count),
        preview: boolean,
        sound: oneOf(...PUSH_NOTIFICATION_SOUNDS),
      }),
      empty,
    ),
  ],
  [ANDROID_UNIFIED_PUSH_NOTIFICATIONS_ROUTES.remove, adminRoute(empty, empty)],
]);
