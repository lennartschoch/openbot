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
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

const packageDir = process.argv[2]
  ? resolve(process.argv[2])
  : dirname(require.resolve("expo-notifications/package.json"));
const androidDir = join(packageDir, "android");
const sourceDir = join(androidDir, "src", "main", "java", "expo", "modules", "notifications");
const manifestPath = join(androidDir, "src", "main", "AndroidManifest.xml");
const gradlePath = join(androidDir, "build.gradle");
const moduleConfigPath = join(packageDir, "expo-module.config.json");

if (!existsSync(sourceDir)) throw new Error(`strip-google: no expo-notifications sources at ${sourceDir}`);

const removed = [];
const edited = [];

/** A file or directory that only exists for Firebase Cloud Messaging. */
function remove(relativePath) {
  const path = join(sourceDir, relativePath);
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
  removed.push(relativePath);
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
  writeFileSync(path, after);
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
      "  // release notes in https://firebase.google.com/support/release-notes/android - cmd + f \"Cloud Messaging version\"\n" +
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

// The three native modules that only wrap Firebase.
replace(
  moduleConfigPath,
  [
    ['      "expo.modules.notifications.notifications.background.ExpoBackgroundNotificationTasksModule",\n', ""],
    ['      "expo.modules.notifications.tokens.PushTokenModule",\n', ""],
    ['      "expo.modules.notifications.topics.TopicSubscriptionModule",\n', ""],
  ],
  "PushTokenModule",
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
    [
      "    val content = notification.notificationRequest.content\n",
      "",
    ],
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
remove("tokens/PushTokenModule.kt");
remove("tokens/interfaces/FirebaseTokenListener.kt");
remove("topics/TopicSubscriptionModule.kt");
remove("notifications/model/RemoteNotificationContent.kt");
remove("notifications/model/triggers/FirebaseNotificationTrigger.kt");
remove("notifications/RemoteMessageSerializer.java");
remove("notifications/background/BackgroundRemoteNotificationTaskConsumer.kt");
remove("notifications/background/ExpoBackgroundNotificationTasksModule.kt");

/** Prune the directories that held only removed files, so `find` shows nothing left behind. */
function pruneEmptyDirectories(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (!statSync(path).isDirectory()) continue;
    pruneEmptyDirectories(path);
    if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
  }
}
pruneEmptyDirectories(sourceDir);

/** The point of the script: no Firebase identifier left in the Android sources or the manifest. */
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
scan(androidDir);
const androidModules = JSON.parse(readFileSync(moduleConfigPath, "utf8")).android?.modules ?? [];
for (const module of androidModules)
  if (/PushTokenModule|TopicSubscriptionModule|BackgroundNotificationTasks/u.test(module))
    leftovers.push(`expo-module.config.json: ${module}`);
if (leftovers.length > 0) throw new Error(`strip-google: Firebase is still referenced:\n${leftovers.join("\n")}`);

const version = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version;
process.stdout.write(
  `strip-google: expo-notifications ${version} has no Firebase: ${removed.length} paths removed, ${edited.length} files edited.\n`,
);
