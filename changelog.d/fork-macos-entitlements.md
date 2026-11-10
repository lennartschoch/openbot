### Fixed

- The signed macOS fork build starts again. It carried `com.apple.developer.associated-domains` and
  `com.apple.developer.team-identifier`, which macOS accepts only with an Apple-issued provisioning
  profile. The self-signed certificate has none, so AMFI killed the app at launch with
  `Taskgated Invalid Signature` and `No matching profile found`. The fork signing path now uses
  `build/entitlements.fork.mac.plist`, which omits both keys. App links to `openbot.run` stay an
  upstream feature.
