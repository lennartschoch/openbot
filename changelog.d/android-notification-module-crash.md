### Fixed

- The Android app starts again. `expo-notifications` requires three native modules as its JavaScript
  bundle loads, and the Google strip had deleted them, so the app died at launch with
  `Cannot find native module 'ExpoPushTokenManager'`. They are registered again as Firebase-free
  stubs that report the transport as unavailable when something calls them.
- The Android release no longer ships ML Kit or Firebase code. The build passes the scanner switches
  to Gradle directly and the release job checks the finished APK, so a config plugin that skips them
  fails the build instead of shipping Google code to a phone.
- The Google strip writes package files with a fresh inode, so it no longer rewrites Bun's download
  cache and a later install starts from a package that is already stripped.
