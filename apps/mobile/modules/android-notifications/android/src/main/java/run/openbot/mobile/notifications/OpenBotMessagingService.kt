package run.openbot.mobile.notifications

import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * Receives the notifications of OpenBot hosts from Firebase Cloud Messaging, also while the app does
 * not run. A host sends the agent name and the text through the OpenBot relay and Google, sealed with
 * keys that only this phone and the host know, so the relay and Google see the app name only. This
 * service opens the seal and shows the notification (`NotificationPresenter`), as
 * `OpenBotUnifiedPushService` does for the UnifiedPush transport of the same notifications.
 *
 * The relay sends a data message with `sealed` and, unless the notification is silent, `sound`
 * (`android-notification-relay.ts` in the account service). Other messages go to `expo-notifications`.
 */
class OpenBotMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val sealed = remoteMessage.data["sealed"]
    if (sealed == null) {
      super.onMessageReceived(remoteMessage)
      return
    }
    NotificationPresenter.show(this, sealed, remoteMessage.data["sound"], remoteMessage.sentTime)
  }
}
