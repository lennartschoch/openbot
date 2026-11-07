package run.openbot.mobile.notifications

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.UnifiedPush

/** The last endpoint of the distributor, kept so a restart can register before the phone answers. */
object UnifiedPushState {
  private const val PREFERENCES = "openbot.unified-push"
  private const val KEY_ENDPOINT = "endpoint"

  fun readEndpoint(context: Context): String? =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(KEY_ENDPOINT, null)

  fun saveEndpoint(context: Context, endpoint: String?) {
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
      .putString(KEY_ENDPOINT, endpoint)
      .apply()
  }
}

/**
 * The app side of UnifiedPush: `register` asks the distributor (for example the ntfy app) for an
 * endpoint, `getEndpoint` reads the last one it gave, and `getDistributor` names the distributor app.
 * The endpoint is the HTTPS URL of one ntfy topic, and its server is the ntfy server that the user
 * chose in the distributor app. `OpenBotUnifiedPushService` stores new endpoints and broadcasts them,
 * and the module gives them to the app as an `onEndpoint` event.
 */
class AndroidNotificationsModule : Module() {
  private var receiver: BroadcastReceiver? = null

  override fun definition() = ModuleDefinition {
    Name("AndroidNotifications")

    Events("onEndpoint")

    Function("register") { messageForDistributor: String? ->
      val context = appContext.reactContext ?: return@Function Unit
      UnifiedPush.register(context, INSTANCE_DEFAULT, messageForDistributor, null)
      Unit
    }

    Function("unregister") {
      val context = appContext.reactContext ?: return@Function Unit
      UnifiedPush.unregister(context, INSTANCE_DEFAULT)
      Unit
    }

    Function("getEndpoint") {
      val context = appContext.reactContext ?: return@Function null
      UnifiedPushState.readEndpoint(context)
    }

    Function("getDistributor") {
      val context = appContext.reactContext ?: return@Function null
      UnifiedPush.getAckDistributor(context)
    }

    Function("pickDistributor") {
      val activity = appContext.reactContext as? Activity ?: return@Function Unit
      UnifiedPush.tryPickDistributor(activity) { }
    }

    /**
     * Every distributor app that answers, in the order the settings screen shows them. The
     * connector's list is the source of truth, and a phone with only ntfy installed has one entry:
     * ntfy answers as a v2 receiver, which the connector queries.
     */
    Function("distributors") {
      val context = appContext.reactContext ?: return@Function emptyList<String>()
      val found = UnifiedPush.getDistributors(context).filter { it != context.packageName }
      Log.i("OpenBotPush", "distributors() -> $found")
      found
    }

    /**
     * Registers with one distributor by package. `tryPickDistributor` needs the v3 link activity,
     * which ntfy answers through a dialog of its own; saving the distributor and registering works
     * with both, and is the only way to choose when more than one distributor answers.
     */
    Function("registerWith") { distributor: String, messageForDistributor: String? ->
      val context = appContext.reactContext ?: return@Function Unit
      Log.i("OpenBotPush", "registerWith($distributor, $messageForDistributor)")
      UnifiedPush.saveDistributor(context, distributor)
      UnifiedPush.register(context, INSTANCE_DEFAULT, messageForDistributor, null)
      Unit
    }

    /** Opens the distributor app, where the user picks the server and confirms the topic. */
    Function("openDistributor") { distributor: String ->
      val context = appContext.reactContext ?: return@Function Unit
      val launch = context.packageManager.getLaunchIntentForPackage(distributor) ?: return@Function Unit
      context.startActivity(launch)
      Unit
    }

    OnStartObserving {
      val context = appContext.reactContext ?: return@OnStartObserving
      receiver =
        object : BroadcastReceiver() {
          override fun onReceive(context: Context, intent: Intent) {
            sendEvent("onEndpoint", mapOf("endpoint" to intent.getStringExtra(EXTRA_ENDPOINT)))
          }
        }
          .also {
            // Android 13+ wants an export flag; the broadcast comes from this app's own UnifiedPush
            // service, so the receiver needs no other app.
            ContextCompat.registerReceiver(
              context,
              it,
              IntentFilter(ACTION_ENDPOINT),
              ContextCompat.RECEIVER_NOT_EXPORTED,
            )
          }
    }

    OnStopObserving {
      receiver?.let { appContext.reactContext?.unregisterReceiver(it) }
      receiver = null
    }
  }

  companion object {
    const val ACTION_ENDPOINT = "run.openbot.mobile.UNIFIED_PUSH_ENDPOINT"
    const val EXTRA_ENDPOINT = "endpoint"
  }
}
