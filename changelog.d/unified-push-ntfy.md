### Changed

- Android phones get push notifications through UnifiedPush with ntfy, so they no longer need Google
  Play Services for notifications. Install an ntfy app, choose it under Settings - Notifications -
  Push service, and set your own ntfy server and topic there. The host posts the sealed notification
  straight to the ntfy server of the phone, and the server passes it on. Phones that register with
  the older Firebase route keep working.
