### Changed

- The versions are the fork's. The phone app reports the fork version (`0.65.0-fork.N`), not the
  upstream store version. On the desktop, a provider runtime updates to the version the release
  pins, never past it: chasing the newest upstream release kept every install one update behind a
  version the fork has not shipped, so the provider row always showed an update. Each fork release
  ships its own pin. Set `OPENBOT_PROVIDER_RUNTIMES_FOLLOW_UPSTREAM=1` for the upstream behavior.
