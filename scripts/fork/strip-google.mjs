/**
 * Takes Firebase Cloud Messaging out of `expo-notifications` on Android.
 *
 * The fork sends notifications over UnifiedPush (ntfy) and never over Firebase, but
 * `expo-notifications` implements that transport itself: its Android sources import
 * `com.google.firebase:messaging`, and its manifest declares a `com.google.firebase.MESSAGING_EVENT`
 * service. Keeping the dependency means the APK carries `firebase-messaging`,
 * `firebase-installations`, `com.google.android.datatransport` and `play-services-*`, and the merged
 * manifest carries `com.google.android.c2dm.permission.RECEIVE` and the Play install-referrer
 * permission — none of which can do anything without a `google-services.json`, but all of which are
 * Google code on the phone.
 *
 * Everything else of the package stays: channels, permissions, the `NotificationsService` receiver
 * that shows what `NotificationPresenter.kt` hands it, and the JS `setNotificationHandler` /
 * `useLastNotificationResponse` that the app already uses. So this deletes the FCM-only files and
 * the two places that branch on them.
 *
 * Run by `bun run fork:strip-google` and by the Android job of `.github/workflows/fork-release.yml`,
 * after `bun install` and before `expo prebuild`. Every edit fails loudly when the upstream code it
 * targets has moved, because silently keeping Firebase is the outcome this script exists to prevent.
 *
 * Usage: node scripts/fork/strip-google.mjs [package-dir]
 *   package-dir defaults to the installed `expo-notifications`; a checkout of the npm tarball works
 *   for a dry run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * Optional: a directory that holds the packages by name, as `node_modules` does. Without it the
 * installed packages are stripped. A copy of the npm tarballs works for a dry run.
 */
const packagesRoot = process.argv[2] ? resolve(process.argv[2]) : null;
const packageDir = packagesRoot
  ? join(packagesRoot, "expo-notifications")
  : dirname(require.resolve("expo-notifications/package.json"));
const cameraDir = packagesRoot
  ? join(packagesRoot, "expo-camera")
  : dirname(require.resolve("expo-camera/package.json"));
const androidDir = join(packageDir, "android");
const sourceDir = join(androidDir, "src", "main", "java", "expo", "modules", "notifications");
const manifestPath = join(androidDir, "src", "main", "AndroidManifest.xml");
const gradlePath = join(androidDir, "build.gradle");

if (!existsSync(sourceDir)) throw new Error(`strip-google: no expo-notifications sources at ${sourceDir}`);

const removed = [];
const edited = [];

/**
 * Writes a file with its own inode.
 *
 * Bun installs `node_modules` by hardlinking the files of its download cache, so writing a package
 * file in place also rewrites the cache entry. A later install then starts from a package that is
 * already stripped, which made the Android build differ between the release runner (whose cache was
 * warm) and a fresh install. Unlinking first leaves the cache intact.
 */
function writeDetached(path, contents) {
  if (existsSync(path)) rmSync(path, { force: true });
  writeFileSync(path, contents);
}

/** A file or directory that only exists for Firebase Cloud Messaging. */
function remove(relativePath) {
  const path = join(sourceDir, relativePath);
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(relativePath);
}

/**
 * Writes a replacement source file.
 *
 * `expo-notifications` requires its native modules at module scope: `PushTokenManager.native.js`,
 * `TopicSubscriptionModule.android.js` and `BackgroundNotificationTasksModule.native.js` each call
 * `requireNativeModule(...)` as the bundle loads. Deleting those modules made every
 * `import "expo-notifications"` throw `Cannot find native module 'ExpoPushTokenManager'` before the
 * app rendered, which is what crashed the fork on Android. The modules stay registered, with the
 * Firebase code replaced by a stub that has no Google dependency and reports the transport as
 * unavailable when something calls it.
 */
function stub(relativePath, source) {
  const path = join(sourceDir, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeDetached(path, source);
  edited.push(`expo-notifications/${relativePath}`);
}

/** An edit that must apply, or that a previous run already applied. */
function replace(path, edits, already) {
  const before = readFileSync(path, "utf8");
  if (already !== undefined && !before.includes(already)) return;
  let after = before;
  for (const [from, to] of edits) {
    if (!after.includes(from)) {
      throw new Error(
        `strip-google: ${path.replace(packageDir, "expo-notifications")} no longer contains:\n${from}\n` +
          "The upstream code moved. Update scripts/fork/strip-google.mjs, and check that the lockfile's\n" +
          "expo-notifications version is the one the script was written against.",
      );
    }
    after = after.replace(from, to);
  }
  writeDetached(path, after);
  edited.push(path.replace(packageDir, "expo-notifications").replaceAll("\\", "/"));
}

/**
 * The edits run before the deletions, so a run that stops on an upstream change leaves the files in
 * place to be inspected.
 */

// The dependency itself, and the service declaration that only Firebase could start.
replace(
  gradlePath,
  [
    [
      '  // release notes in https://firebase.google.com/support/release-notes/android - cmd + f "Cloud Messaging version"\n' +
        "  implementation 'com.google.firebase:firebase-messaging:25.0.1'\n\n",
      "",
    ],
  ],
  "com.google.firebase",
);
replace(
  manifestPath,
  [
    [
      '    <service\n      android:name=".service.ExpoFirebaseMessagingService"\n      android:exported="false">\n' +
        '      <intent-filter android:priority="-1">\n        <action android:name="com.google.firebase.MESSAGING_EVENT" />\n' +
        "      </intent-filter>\n    </service>\n\n",
      "",
    ],
  ],
  '"com.google.firebase.MESSAGING_EVENT"',
);

// A remote message that a notification carries only exists with Firebase. The local notifications
// that `NotificationPresenter.kt` builds take the `ChannelAwareTrigger` branch that stays.
replace(
  join(sourceDir, "notifications", "NotificationSerializer.java"),
  [
    ["import com.google.firebase.messaging.RemoteMessage;\n", ""],
    ["import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger;\n", ""],
    [
      "      if (requestTrigger instanceof FirebaseNotificationTrigger trigger) {\n" +
        "        RemoteMessage message = trigger.getRemoteMessage();\n" +
        "        Map<String, String> data = message.getData();\n" +
        '        String dataBody = data.get("body");\n' +
        "        if (isValidJSONString(dataBody)) {\n" +
        "          // If the body is a JSON object string, the notification was sent by the Expo notification service,\n" +
        "          // so we do the expected remapping of fields (we JSON-parse the string into an object in JS)\n" +
        '          content.putString("dataString", dataBody);\n' +
        "        } else {\n" +
        "          // The message was sent directly from Firebase or some other service,\n" +
        "          // and we copy the data as is\n" +
        '          content.putBundle("data", toBundle(data));\n' +
        "        }\n" +
        "      } else if(\n",
      "      if(\n",
    ],
  ],
  "FirebaseNotificationTrigger",
);

replace(
  join(sourceDir, "notifications", "handling", "NotificationsHandler.kt"),
  [
    ["import expo.modules.notifications.notifications.model.RemoteNotificationContent\n", ""],
    ["    val content = notification.notificationRequest.content\n", ""],
    [
      "    if (content is RemoteNotificationContent && content.isDataOnly) {\n" +
        "      // We do not notify JS about data-only notifications, for consistency with iOS.\n" +
        "      // onDidReceiveNotification is triggered\n" +
        "      // and JS task will run if set up\n" +
        "      return\n" +
        "    }\n",
      "",
    ],
  ],
  "RemoteNotificationContent",
);

replace(
  join(sourceDir, "service", "delegates", "ExpoHandlingDelegate.kt"),
  [
    [
      "    // Run background tasks only for custom notification action buttons (not the default tap).\n" +
        "    // When the default notification tap launches the app from killed state, calling\n" +
        "    // runTaskManagerTasks starts a headless React instance that races with the foreground app.\n" +
        "    // The foreground TaskManager gets misclassified as headless (via isStartedByHeadlessLoader),\n" +
        "    // then wiped by invalidateAppRecord — breaking all subsequent background task execution.\n" +
        "    if (!isAppInForeground() && notificationResponse.actionIdentifier != NotificationResponse.DEFAULT_ACTION_IDENTIFIER) {\n" +
        "      FirebaseMessagingDelegate.runTaskManagerTasks(\n" +
        "        context.applicationContext,\n" +
        "        NotificationSerializer.toBundle(notificationResponse)\n" +
        "      )\n" +
        "    }\n\n",
      "",
    ],
  ],
  "FirebaseMessagingDelegate",
);

// `logRemoteMessage` logged a Firebase message. The bundle and notification logs around it stay.
replace(
  join(sourceDir, "notifications", "debug", "DebugLogging.kt"),
  [
    ["import com.google.firebase.messaging.RemoteMessage\n", ""],
    [
      "  fun logRemoteMessage(caller: String, message: RemoteMessage) {\n" +
        "    if (!BuildConfig.DEBUG) {\n" +
        "      // Do not log for release/production builds\n" +
        "      return\n" +
        "    }\n" +
        "    val logMessage =\n" +
        '      """\n' +
        "      $caller:\n" +
        "        notification.channelId: ${message.notification?.channelId}\n" +
        "        notification.vibrateTimings: ${message.notification?.vibrateTimings?.contentToString()}\n" +
        "        notification.body: ${message.notification?.body}\n" +
        "        notification.color: ${message.notification?.color}\n" +
        "        notification.sound: ${message.notification?.sound}\n" +
        "        notification.title: ${message.notification?.title}\n" +
        "        notification.collapseKey: ${message.collapseKey}\n" +
        "        data: ${message.data}\n" +
        '      """.trimIndent()\n' +
        "\n" +
        '    Log.i("expo-notifications", logMessage)\n' +
        "  }\n" +
        "\n",
      "",
    ],
  ],
  "RemoteMessage",
);

// The files that only exist for Firebase Cloud Messaging.
remove("service/ExpoFirebaseMessagingService.kt");
remove("service/delegates/FirebaseMessagingDelegate.kt");
remove("service/interfaces/FirebaseMessagingDelegate.kt");
remove("tokens/interfaces/FirebaseTokenListener.kt");
remove("notifications/model/RemoteNotificationContent.kt");
remove("notifications/model/triggers/FirebaseNotificationTrigger.kt");
remove("notifications/RemoteMessageSerializer.java");
remove("notifications/background/BackgroundRemoteNotificationTaskConsumer.kt");

// The native modules stay registered, because the JavaScript of the package requires them as the
// bundle loads. They carry no Firebase and report the missing transport instead.
stub(
  "tokens/PushTokenModule.kt",
  `package expo.modules.notifications.tokens

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REGISTRATION_FAIL_CODE = "E_REGISTRATION_FAILED"

/**
 * Keeps the \`ExpoPushTokenManager\` native module registered without Firebase Cloud Messaging.
 *
 * The app sends notifications over UnifiedPush and never asks for a device token, but
 * \`expo-notifications\` imports this module at module scope, so it must exist for the bundle to load.
 */
class PushTokenModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoPushTokenManager")

    Events("onDevicePushToken")

    AsyncFunction("getDevicePushTokenAsync") { promise: Promise ->
      promise.reject(
        REGISTRATION_FAIL_CODE,
        "This build has no Firebase Cloud Messaging. Notifications arrive over UnifiedPush.",
        null
      )
    }

    AsyncFunction("unregisterForNotificationsAsync") { promise: Promise ->
      promise.resolve(null)
    }
  }
}
`,
);
stub(
  "topics/TopicSubscriptionModule.kt",
  `package expo.modules.notifications.topics

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TOPIC_SUBSCRIBE_FAIL_CODE = "E_TOPIC_SUBSCRIBE_FAILED"
private const val TOPIC_UNSUBSCRIBE_FAIL_CODE = "E_TOPIC_UNSUBSCRIBE_FAILED"

/**
 * Keeps the \`ExpoTopicSubscriptionModule\` native module registered without Firebase Cloud Messaging.
 *
 * \`expo-notifications\` requires it as the bundle loads. Broadcast topics need Firebase, so the two
 * operations reject.
 */
class TopicSubscriptionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoTopicSubscriptionModule")

    AsyncFunction("subscribeToTopicAsync") { topic: String, promise: Promise ->
      promise.reject(
        TOPIC_SUBSCRIBE_FAIL_CODE,
        "This build has no Firebase Cloud Messaging, so it cannot subscribe to the topic '$topic'.",
        null
      )
    }

    AsyncFunction("unsubscribeFromTopicAsync") { topic: String, promise: Promise ->
      promise.reject(
        TOPIC_UNSUBSCRIBE_FAIL_CODE,
        "This build has no Firebase Cloud Messaging, so it cannot unsubscribe from the topic '$topic'.",
        null
      )
    }
  }
}
`,
);
stub(
  "notifications/background/ExpoBackgroundNotificationTasksModule.kt",
  `package expo.modules.notifications.notifications.background

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Keeps the \`ExpoBackgroundNotificationTasksModule\` native module registered without Firebase.
 *
 * \`expo-notifications\` requires it as the bundle loads. A background task that only handled remote
 * messages has nothing to run, so both operations resolve without registering anything.
 */
class ExpoBackgroundNotificationTasksModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoBackgroundNotificationTasksModule")

    AsyncFunction("registerTaskAsync") { _: String -> null }

    AsyncFunction("unregisterTaskAsync") { _: String -> null }
  }
}
`,
);

/**
 * Turns a package that ships a prebuilt AAR into a source build.
 *
 * `expo-notifications` and `expo-camera` are published with `android.publication`, and Expo's Gradle
 * plugin then adds `api "host.exp.exponent:expo.modules.<name>:<version>"` — the AAR from the
 * package's `local-maven-repo`, not the sources. Editing or flagging the sources of such a package
 * changes nothing: the first attempt at this strip crossed the prebuild untouched because the AAR
 * carried Firebase anyway. Without the `publication` block the module becomes a Gradle project and
 * its `build.gradle` (and its `barcodeScannerEnabled` switch) applies.
 */
function buildFromSource(name, directory) {
  const configPath = join(directory, "expo-module.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.android?.publication !== undefined) {
    delete config.android.publication;
    writeDetached(configPath, `${JSON.stringify(config, null, 2)}\n`);
    edited.push(`${name}/expo-module.config.json`);
  }
  // Nothing may resolve the prebuilt artifact after this; a stale AAR would reintroduce Firebase.
  // This runs on a second pass too, when `publication` is already gone.
  const mavenRepo = join(directory, "local-maven-repo");
  if (!existsSync(mavenRepo)) return;
  rmSync(mavenRepo, { recursive: true, force: true });
  removed.push(`${name}/local-maven-repo`);
}

/** Prune the directories that held only removed files, so `find` shows nothing left behind. */
function pruneEmptyDirectories(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (!statSync(path).isDirectory()) continue;
    pruneEmptyDirectories(path);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  }
}
/** The point of the script: no Firebase and no prebuilt AAR left behind. */
const leftovers = [];
function scan(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      scan(path);
      continue;
    }
    if (!/\.(kt|java|xml|gradle|json)$/u.test(entry)) continue;
    // Comments name the removed classes in prose; only code counts. A broken KDoc link compiles.
    const text = readFileSync(path, "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      .replaceAll(/<!--[\s\S]*?-->/gu, "")
      .replaceAll(/\/\/[^\n]*/gu, "");
    for (const pattern of [
      "com.google.firebase",
      "RemoteMessage",
      "FirebaseMessaging",
      "FirebaseNotificationTrigger",
      "RemoteNotificationContent",
      "RemoteMessageSerializer",
    ]) {
      if (text.includes(pattern)) leftovers.push(`${path.replace(packageDir, "expo-notifications")}: ${pattern}`);
    }
  }
}

buildFromSource("expo-notifications", packageDir);
buildFromSource("expo-camera", cameraDir);
pruneEmptyDirectories(sourceDir);

scan(androidDir);
for (const name of ["expo-notifications", "expo-camera"]) {
  const directory = name === "expo-camera" ? cameraDir : packageDir;
  const config = JSON.parse(readFileSync(join(directory, "expo-module.config.json"), "utf8"));
  if (config.android?.publication !== undefined) leftovers.push(`${name}: still published as a prebuilt AAR`);
  if (existsSync(join(directory, "local-maven-repo"))) leftovers.push(`${name}/local-maven-repo still exists`);
  if (name === "expo-notifications") {
    const modules = config.android?.modules ?? [];
    for (const module of ["tokens.PushTokenModule", "topics.TopicSubscriptionModule"]) {
      if (!modules.some((entry) => entry.endsWith(module)))
        leftovers.push(`expo-notifications/expo-module.config.json: ${module} is not registered`);
    }
    if (!modules.some((entry) => entry.endsWith("background.ExpoBackgroundNotificationTasksModule")))
      leftovers.push("expo-notifications/expo-module.config.json: the background task module is not registered");
  }
}
if (leftovers.length > 0) throw new Error(`strip-google: Google is still referenced:\n${leftovers.join("\n")}`);

const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
const cameraVersion = JSON.parse(readFileSync(join(cameraDir, "package.json"), "utf8")).version;
process.stdout.write(
  `strip-google: no Firebase, no ML Kit — expo-notifications ${version} and expo-camera ${cameraVersion}\n` +
    `  build from source now: ${removed.length} paths removed, ${edited.length} files edited.\n`,
);
