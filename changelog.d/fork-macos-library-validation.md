### Fixed

- The signed macOS fork build starts again. A self-signed certificate has no Team ID, so under the
  hardened runtime library validation refused to load `Electron Framework` and the app aborted at
  launch ("mapping process and mapped file (non-platform) have different Team IDs"). The fork
  entitlements for the app and its helpers (`build/entitlements.fork.mac.plist`,
  `build/entitlements.fork.mac.inherit.plist`) now turn library validation off.
