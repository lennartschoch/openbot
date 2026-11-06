package run.openbot.mobile.notifications

import android.content.Context
import android.net.Uri
import expo.modules.notifications.notifications.enums.NotificationPriority
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationContent
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.triggers.ChannelAwareTrigger
import expo.modules.notifications.service.NotificationsService
import java.util.Date
import java.util.UUID

/**
 * Opens one sealed notification and gives it to `expo-notifications`, which shows it, or asks the app
 * first when the app is on screen. `OpenBotMessagingService` calls this for Firebase Cloud Messaging
 * and `OpenBotUnifiedPushService` calls it for UnifiedPush (ntfy), so both transports show the same
 * notification. A notification that no key opens shows the app name only.
 */
object NotificationPresenter {
  fun show(context: Context, sealed: String, sound: String?, sentTime: Long) {
    val opened = SealedNotification.open(context, sealed)
    val base = content(context, opened, sound)
    // The agent picture is the large icon. Without one, the notification shows as before.
    val avatar = opened?.let { NotificationAvatars.file(context, it.serverId, it.agentId) }
    val shown = if (avatar == null) base else AgentNotificationContent(base, avatar.path)
    val request = NotificationRequest(UUID.randomUUID().toString(), shown, ChannelAwareTrigger(channelId(sound)))
    NotificationsService.receive(context, Notification(request, if (sentTime > 0) Date(sentTime) else Date()))
  }

  private fun content(context: Context, opened: OpenedNotification?, sound: String?): NotificationContent {
    val builder = NotificationContent.Builder()
      .setTitle(opened?.title ?: APP_NAME)
      .setText(opened?.body)
      .setSubtitle(opened?.serverName)
      .setPriority(NotificationPriority.HIGH)
      .setAutoDismiss(true)
    // `expo-notifications` gives the app this object as the notification data.
    if (opened != null) builder.setBody(opened.data())
    // Android 8 and later play the sound of the channel. Earlier versions play the sound of the content.
    when {
      sound == null -> builder.setSound(null).setVibrationPattern(null)
      SOUND_RESOURCES.containsKey(sound) ->
        builder.setSound(Uri.parse("android.resource://${context.packageName}/raw/${SOUND_RESOURCES.getValue(sound)}"))
    }
    return builder.build()
  }

  /** The title until the app opens the seal. A brand name, so it is the same in every language. */
  private const val APP_NAME = "OpenBot"

  /** The sounds of `NOTIFICATION_SOUND_FILES`, as `with-notification-sounds.js` names their copies. */
  private val SOUND_RESOURCES = mapOf(
    "openbot" to "openbot_task",
    "warm" to "openbot_warm",
    "mech" to "openbot_mech",
    "bubble" to "openbot_bubble",
    "press" to "openbot_press",
  )

  /** The channel of each sound, which the app creates (`android-notification-channels.ts`). */
  private fun channelId(sound: String?): String = when {
    sound == null -> "openbot.sound.none"
    SOUND_RESOURCES.containsKey(sound) -> "openbot.sound.$sound.v2"
    else -> "openbot.sound.default"
  }
}
