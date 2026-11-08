const fs = require("node:fs");
const path = require("node:path");

const { AndroidConfig, withAndroidManifest, withAppBuildGradle, withGradleProperties } = require("expo/config-plugins");

/**
 * Keeps Google's ML Kit out of the APK.
 *
 * `expo-camera` reads QR codes with ML Kit, and its Gradle build only *packages* those dependencies
 * while barcode scanning is on: `com.google.mlkit:barcode-scanning`,
 * `com.google.android.gms:play-services-code-scanner` and `androidx.camera:camera-mlkit-vision`
 * become `compileOnly` when `expo.camera.barcode-scanner-enabled` is `false`. The app does not use
 * the camera's scanner at all — `qr-scanner.tsx` takes a still and decodes it with `jsqr` — so the
 * flag is off in `app.json` and set again here, where it also covers the document scanner, which the
 * plugin does not expose.
 *
 * The library's manifest also declares `com.google.mlkit.vision.DEPENDENCIES=barcode_ui`, which asks
 * Google Play services to preload the module. Nothing reads it without Play services, and the entry
 * would still be in the merged manifest, so it is marked for removal.
 */
const BARCODE_SCANNER_PROPERTY = "expo.camera.barcode-scanner-enabled";
const DOCUMENT_SCANNER_PROPERTY = "expo.camera.document-scanner-enabled";
const MLKIT_DEPENDENCIES_METADATA = "com.google.mlkit.vision.DEPENDENCIES";
/**
 * `expo-notifications`' plugin writes these two beside its own; only the deleted Firebase service
 * read them, so they would be dead keys that name Google in the manifest.
 */
const REMOVED_METADATA = new Set([
  MLKIT_DEPENDENCIES_METADATA,
  "com.google.firebase.messaging.default_notification_color",
  "com.google.firebase.messaging.default_notification_icon",
]);
/**
 * R8 shrinks the app with `proguard-android-optimize.txt`, which reports every class that the app
 * code references but the APK does not contain. `expo-camera` keeps its Kotlin scanner code with the
 * dependencies as `compileOnly`, so R8 names these packages. Nothing loads them at runtime: the
 * scanner code is unreachable while `barcode-scanner-enabled` is `false`.
 */
const MLKIT_DONTWARN_RULES = [
  "-dontwarn com.google.mlkit.**",
  "-dontwarn com.google.android.gms.vision.**",
  // The code scanner's `Task`/`On*Listener` types are `compileOnly` with the scanner off, like the
  // ML Kit classes, so R8 names them too.
  "-dontwarn com.google.android.gms.tasks.**",
].join("\n");
const RULES_MARKER = "# with-no-mlkit";

/** @type {import('expo/config-plugins').ConfigPlugin<null>} */
module.exports = (config) => {
  config = withGradleProperties(config, (config) => {
    for (const property of [BARCODE_SCANNER_PROPERTY, DOCUMENT_SCANNER_PROPERTY]) {
      config.modResults = AndroidConfig.BuildProperties.updateAndroidBuildProperty(
        config.modResults,
        property,
        "false",
      );
    }
    return config;
  });

  config = withAppBuildGradle(config, (config) => {
    // Prebuild writes `app/proguard-rules.pro` before the plugin mods run, and `build.gradle`
    // includes it, so the rules need no change to the Gradle files.
    const rulesFile = path.join(config.modRequest.platformProjectRoot, "app", "proguard-rules.pro");
    const current = fs.existsSync(rulesFile) ? fs.readFileSync(rulesFile, "utf8") : "";
    if (!current.includes(RULES_MARKER)) {
      fs.appendFileSync(
        rulesFile,
        `\n${RULES_MARKER}: the ML Kit scanner of expo-camera is compileOnly.\n${MLKIT_DONTWARN_RULES}\n`,
      );
    }
    return config;
  });

  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;
    // `tools:node="remove"` needs the namespace, and the generated manifest does not declare it.
    manifest.$ = { ...manifest.$, "xmlns:tools": "http://schemas.android.com/tools" };
    const metadata = application["meta-data"] ?? [];
    application["meta-data"] = metadata.filter((entry) => !REMOVED_METADATA.has(entry.$?.["android:name"]));
    application["meta-data"].push({
      $: { "android:name": MLKIT_DEPENDENCIES_METADATA, "tools:node": "remove" },
    });
    return config;
  });
};
