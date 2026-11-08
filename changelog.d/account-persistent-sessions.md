### Fixed

- A remote client no longer drops off a headless host after one hour. The fork's account service
  gave host and device remote sessions the ticket lifetime (`OPENBOT_SESSION_TTL_SECONDS=3600`),
  while upstream keeps them until logout or revocation. Signal enforced that deadline and closed
  the sockets with `authentication_required`, which the client treats as terminal, so only a client
  restart brought the connection back. Remote sessions now use the same persistent deadline as
  `apps/auth-api`.
