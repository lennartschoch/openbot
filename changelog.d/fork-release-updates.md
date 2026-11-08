### Changed

- A server no longer installs its own update from a client. Server Settings > Updates shows the
  installed version and whether this fork has a newer release, and installs nothing. Add a release
  with `sudo openbot update`, the timer that stages one and installs it at the next boot, or a newer
  image tag on the Docker host. The remote request could make root install a release that the fork
  did not control, and a container cannot replace its own image.

### Fixed

- Update checks read this fork's releases instead of the upstream repository, so a fork build no
  longer offers an upstream version such as 0.65.0. The check accepts the `-fork.<n>` version form
  and compares two builds of one base version correctly; before, it offered the installed version
  again forever.
- The provider runtime block list is this fork's file, not upstream's.
- The Docker image is this fork's: `ghcr.io/lennartschoch/openbot`, rebuilt from each release with
  `v<version>` and `latest`. Its source label names this repository.
- The macOS host manager and installer check the fork's pinned self-signed certificate instead of
  the upstream Apple team, which a self-signed certificate can never satisfy.
