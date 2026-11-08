### Fixed

- The Android app starts again after the Google services strip. The shrunk release APK missed the
  `com.google.android.gms.tasks` classes that the code scanner of `expo-camera` uses, so
  `with-no-mlkit` now adds the matching `-dontwarn` rule beside the ML Kit ones.
