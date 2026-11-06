package run.openbot.mobile.notifications

import android.content.Context
import android.content.Intent
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.json.JSONObject
import java.nio.charset.StandardCharsets

/**
 * Receives the notifications of OpenBot hosts from a UnifiedPush distributor (for example the ntfy
 * app), also while the app does not run. A host posts the sealed agent name and text, and the sound,
 * as JSON to the phone's ntfy endpoint, and the ntfy server passes the body on. This service opens
 * the seal and shows the notification (`NotificationPresenter`), as `OpenBotMessagingService` does
 * for the Firebase Cloud Messaging transport of the same notifications.
 */
class OpenBotUnifiedPushService : PushService() {
  override fun onMessage(message: PushMessage, instance: String) {
    val payload = JSONObject(String(message.content, StandardCharsets.UTF_8))
    val sealed = payload.optString("sealed")
    if (sealed.isEmpty()) return
    // A silent notification has `sound: null`, which `optString` reads as the empty string.
    val sound = payload.optString("sound").takeIf { it.isNotEmpty() }
    NotificationPresenter.show(this, sealed, sound, System.currentTimeMillis())
  }

  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    UnifiedPushState.saveEndpoint(this, endpoint.url)
    sendBroadcast(Intent(AndroidNotificationsModule.ACTION_ENDPOINT).putExtra(AndroidNotificationsModule.EXTRA_ENDPOINT, endpoint.url))
  }

  override fun onUnregistered(instance: String) {
    UnifiedPushState.saveEndpoint(this, null)
    sendBroadcast(Intent(AndroidNotificationsModule.ACTION_ENDPOINT))
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    // The app asks for the endpoint again when it comes on screen, so the failure needs no handling.
  }
}
