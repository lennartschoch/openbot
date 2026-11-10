### Changed

- The phone app reports the fork version (`0.65.0-fork.N`), not the upstream store version.

### Removed

- A headless server (server mode, hosted server, container) installs no provider runtime at all.
  There is no update check, no download, and a client's `runtimesDownload` and `runtimesCancel` get
  a refusal - on a desktop host they keep working. A provider on the server runs the CLI that the
  operator installed on the machine, from `PATH` or `OPENBOT_<PROVIDER>_PATH`; without one, the row
  shows the install guide. This keeps the harnesses on a server machine in the operator's hands,
  like the app update before it. The tool runtimes of the server (Bun, the Computer Use driver, the
  remote desktop runtime) still download, because remote desktop and MCP servers need them.
