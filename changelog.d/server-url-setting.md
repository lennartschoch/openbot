### Added

- The sign-in screen has Change account service: an optional account service URL that defaults to
  `openbot.run`, plus the optional `wss:` Signal address of a self-hosted server, with a restart
  button. A user of a self-hosted account service sets both before the first email code. To change
  the service later, sign out first: the fields are on the sign-in screen, and signing out stops
  the session token from reaching the other service.
