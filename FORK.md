# Fork releases

This fork builds releases from its own tree and publishes them on this repository. It does not
publish to Google Play, the App Store, or `openbot.run`. Nothing here is affiliated with
Synthetify Labs.

## Versions and tags

- `package.json` holds the desktop version. It starts at the upstream version, such as `0.63.0`.
- A fork release is `<base>-fork.<n>`, for example `0.63.0-fork.1`, and its tag is
  `fork-v0.63.0-fork.1`.
- `n` is global: it does not restart at 1 for a new upstream base. `0.63.0-fork.4` is followed by
  `0.64.0-fork.5`, as in the Paseo fork. The Android version code and the macOS update both need
  one number that only rises.
- The desktop app shows the full version.
- The mobile app keeps the upstream marketing version (`apps/mobile/app.json` `version`), because
  it follows the store train of upstream. `scripts/fork/apply-version.mjs` writes only
  `android.versionCode` and `ios.buildNumber`, from the fork version.

The Android version code is `(major*10^6 + minor*10^3 + patch) * 10000 + n`. `0.63.0-fork.3`
gives `630000003`, `0.64.0-fork.4` gives `640000004`. `n` must stay under 10,000, `minor` and
`patch` under 1000; the code reaches the Android limit of 2.1 billion near minor version 200.

## Cut a release

After an upstream release, one command syncs and releases:

```sh
node scripts/fork/sync-upstream.mjs --push
```

It merges the newest upstream release tag, writes `.fork/state.json`, bumps the
fork version, commits, tags `fork-v<version>` and pushes both. Exit code `2`
means the merge has conflicts: resolve them, `git add -A`, then run
`node scripts/fork/sync-upstream.mjs --continue --tag <tag> --push`.

For a release of fork-only fixes on the current upstream base:

```sh
node scripts/fork/cut-release.mjs --push
```

The scheduled sync task runs `/.agents/skills/fork-sync/SKILL.md`.

The tag starts `.github/workflows/fork-release.yml`. It builds:

- Linux desktop: `bun run dist:linux`, AppImage plus the update manifest.
- macOS desktop: `bun run dist:mac`, arm64. Signed with a self-signed certificate when
  `APPLE_CERTIFICATE` is set; otherwise unsigned, and macOS asks the user to open it once with a
  right-click.
- Android APK: `expo prebuild` and `gradlew assembleRelease`, signed with the fork key.
  `reactNativeArchitectures=arm64-v8a`, as in the Paseo fork: one ABI, no 32-bit or emulator
  libraries.

All assets go to one draft GitHub release, and the last job publishes it. A failed platform keeps
the release as a draft.

iOS and Windows are not built. Upstream signs them with App Store Connect and Azure Artifact
Signing credentials that a fork does not have.

## Repository secrets

| Secret | Use |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The release keystore, base64 of the `.jks` file. Required. |
| `ANDROID_KEYSTORE_PASSWORD` | Store password. |
| `ANDROID_KEY_ALIAS` | Key alias inside the keystore. |
| `ANDROID_KEY_PASSWORD` | Key password. |
| `APPLE_CERTIFICATE` | Optional. Base64 `.p12` with the certificate and its private key. |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12`. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Optional, with a Developer ID certificate only. Turn on notarization. |

### macOS signing

`electron-builder.yml` says `mac.notarize: true`, which needs a paid Apple Developer ID. The
release workflow chooses the path from the secrets:

| Secrets | Result |
| --- | --- |
| none | Unsigned. Gatekeeper blocks the first open; no automatic update. |
| `APPLE_CERTIFICATE` + password | Signed with that certificate, not notarized. A self-signed Code Signing certificate from Keychain Access is enough: every build reuses it, so Squirrel.Mac accepts the next update, and the user right-clicks to open the first one. |
| the two, plus `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` | Signed and notarized with a Developer ID. First open works normally. |

A self-signed certificate is not trusted by macOS until each Mac trusts it once, and it cannot
remove the quarantine warning, because only notarization does that:

```sh
# Once per Mac that runs the fork build:
security add-trusted-cert -r trustRoot -p codeSign -k ~/Library/Keychains/login.keychain-db .fork/openbot-fork-code-signing.crt
# Or Keychain Access: import the certificate, open it, Trust, "Always Trust", Code Signing.

# Once per download, because the build is not notarized:
xattr -dr com.apple.quarantine /Applications/OpenBot.app
```

The release workflow trusts the certificate on the runner itself, so CI does not need it.

macOS builds are arm64 only (`macos-14`). Intel Macs are not built.

If you make a new `.p12`, export it with the legacy algorithms. macOS `security import` cannot
read the OpenSSL 3 defaults (AES/PBES2) and fails with "MAC verification failed":

```sh
openssl pkcs12 -export -inkey key.pem -in cert.pem -name "OpenBot Fork" -out cert.p12 \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
```

Keep the certificate and its password outside the repository. Every build must use the same
certificate, or Squirrel.Mac refuses the update.

Use a specific key alias such as `openbot-release`. GitHub masks every occurrence of a
secret value in the logs, so a value like `fork` hides the word in every log line.

Create the Android key once and keep it safe. Every later APK must use it, or Android refuses the
update over an installed copy:

```sh
keytool -genkeypair -v -keystore fork-release.jks -alias fork \
  -keyalg RSA -keysize 4096 -validity 10000
base64 -i fork-release.jks | pbcopy   # paste into ANDROID_KEYSTORE_BASE64
```

The keystore is not in this repository and must not be committed. Back it up: losing it means the
next release has a different signature and every user must uninstall first.

## CI

Only the fork workflows run. Every workflow of upstream is disabled in the repository settings,
because it needs the release credentials of `nightly-labs`. GitHub has no per-workflow switch in
git: a workflow that a future upstream merge adds starts enabled. Disable it in
**Actions → workflow → Disable workflow**.

- `.github/workflows/account-image.yml` publishes `ghcr.io/lennartschoch/openbot-account`.
- `.github/workflows/fork-release.yml` builds the releases above.

## Back up the signing material

The private parts are not in this repository, and GitHub cannot give them back: repository
secrets are write-only, and no API returns a stored value. Keep a copy of the folder that holds
them (here `~/.config/openbot-fork/`) in a password manager:

| File | What it is | If it is lost |
| --- | --- | --- |
| `fork-release.jks` + `keystore.env` | Android release key and its passwords | The next APK has a different signature. Every installed copy must be uninstalled first. |
| `fork-signing.p12` + `apple-cert.env` | macOS signing identity and its password | A new identity, and Squirrel.Mac refuses updates over an installed copy. |
| `fork-signing.crt` + `fork-signing.key` | The pair behind the `.p12` | The `.p12` cannot be rebuilt from the secrets. |

The public halves are committed, so anyone can trust or verify a build without you:

| File | SHA-256 |
| --- | --- |
| `.fork/openbot-fork-code-signing.crt` | `D6:13:AA:E1:45:43:F8:21:83:74:A5:74:CF:ED:5F:85:5A:51:F4:E3:3C:C6:4B:E1:09:C6:8B:8E:EB:20:0F:70` |
| `.fork/openbot-fork-android.crt` | `57:98:E3:50:E1:F8:56:3F:A0:40:D9:D4:3F:27:7A:2C:12:01:38:BD:41:AC:9C:8B:3D:2F:17:F6:9B:70:D4:A1` |

A new certificate or key must change this table too.

## Sync with upstream

```sh
node scripts/fork/sync-upstream.mjs            # merges the newest upstream release tag
node scripts/fork/sync-upstream.mjs --tag v0.64.0
```

The script writes `.fork/state.json` with the upstream tag and commit that the tree contains, so a
release can report where it came from. Resolve conflicts by hand, then run
`node scripts/fork/apply-version.mjs --print` to check the base version.

## Differences from upstream that need care at each merge

- `apps/mobile/app.json`: fork identifiers, no `eas.projectId`, updates disabled. The package is
  `com.lennartschoch.openbot`. The scheme stays `openbot`, because the host emits
  `openbot://mobile-connect` QR links and a different scheme would break pairing.
- `apps/mobile/google-services.json` is absent. Push notifications over Firebase Cloud Messaging
  are not part of the fork. A build without the file works; closed-app notifications do not.
- **No analytics or telemetry leaves the app.** Four switches carry it, and a merge must keep all
  four: `FORK_ANALYTICS_ENABLED = false` in `apps/mobile/src/features/analytics/mobile-analytics.ts`,
  `FORK_FAILURE_REPORTS_ENABLED = false` in `apps/mobile/src/features/analytics/failure-reports.ts`
  and in `src/renderer/src/error-reports.ts` (product events *and* failure reports), the
  `analyticsEnabled = false` in `src/main/application-services.ts` (host events and its report
  queue), and `shouldEnableDesktopAnalytics() { return false }` in `src/renderer/src/analytics.ts`.
  `src/main/content-security-policy.ts` also drops `https://analytics.openbot.run` from
  `connect-src`, so a re-enabled sender still cannot reach upstream's collector; the upstream
  OpenPanel client id stays in the bundle but no client is ever constructed. Upstream's
  `apps/auth-api` FCM relay is not deployed — our account service is `account/`.
  Firebase is **not in the APK**: `scripts/fork/strip-google.mjs` (run by the Android job of
  `fork-release.yml`, and by `bun run fork:strip-google`) deletes `expo-notifications`' FCM
  transport — `ExpoFirebaseMessagingService`, `PushTokenModule`, `TopicSubscriptionModule`, the
  background remote-message task, `RemoteMessageSerializer`, `RemoteNotificationContent`,
  `FirebaseNotificationTrigger` — drops `com.google.firebase:firebase-messaging` from its
  `build.gradle` and the `MESSAGING_EVENT` service from its manifest, and removes our own
  `OpenBotMessagingService`. Channels, permissions, the `NotificationsService` receiver and the tap
  handling stay. The script fails the build when the upstream code it targets has moved, so an
  `expo-notifications` bump cannot silently bring Firebase back; check `strip-google`'s assertions
  when you bump it. What the strip removes with it: `firebase-installations`,
  `com.google.android.datatransport`, `play-services-*`, `com.google.android.c2dm.permission.RECEIVE`
  and the Play install-referrer permission. Still Google and still in the APK: ML Kit's
  `barcode-scanning`, pulled by `expo-camera` for the QR pairing screen (on-device, no request).
- `apps/mobile/src/features/app-update/model/app-update.ts`: store links point at this repository.
- `electron-builder.yml` keeps upstream's `publish.owner`/`repo`. The release workflow overrides
  them on the command line, so the file needs no edit.
- The account service lives in `account/`. Upstream's `apps/auth-api` stays only for merges.

## Licence

The repository is under the PolyForm Noncommercial License 1.0.0. Keep `LICENSE` and `NOTICE`.
Distribution of free builds is permitted; commercial use needs the licence from `licenses@openbot.run`.
