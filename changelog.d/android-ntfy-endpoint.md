### Fixed

- Android notifications reach the phone again. The `push-notifications-android-v2` decoder accepted
  only a single-label host and no query, so every real UnifiedPush endpoint failed, such as
  `https://ntfy.example.com/openbot-topic?up=1`. The host returned `400`, the phone retried, and no
  registration was stored. The endpoint pattern now accepts DNS labels and the `?up=1` query that
  ntfy adds. The v2 registration itself is unchanged.
