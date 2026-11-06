# Account service (Bun)

A small account service for self-hosted OpenBot. This is an unofficial fork of OpenBot and is
not affiliated with Synthetify Labs. This fork uses the service instead of
[`apps/auth-api`](../apps/auth-api), the Cloudflare Worker. The Worker stays in the tree only
to keep merges with upstream simple. Nothing here imports it.

The service is single-tenant on purpose: one account server, one owner, a few hosts and
phones. It keeps one SQLite file. The unmodified desktop app, host, Signal and mobile app
accept it. `PROTOCOL.md` is the wire contract that they require.

## What it does

- Host sign-in by server claim: `POST /v2/admin/server-claims`, then `POST /v2/server-claims/redeem`.
- Company (OIDC) sign-in for the desktop and web client. Email codes are not sent; a client
  that asks for one gets `company_sign_in_required` (409).
- Host registry and remote sessions.
- ES256 remote tickets, published at `/.well-known/jwks.json`. Signal verifies them from there.
- Mobile Connect: QR ticket, redeem, session, device list, revoke.
- The account edits that the apps make: display name (`PATCH /v1/me/profile`), chat colour
  (`PUT /v1/me/chat-color`) and the analytics answer (`PUT /v1/me/analytics`). Each device
  follows that answer.
- Mobile feature flags (`GET /v1/mobile/features`). The agent browser live view is on for
  Android and iOS. The hosted server plans are off. No `latestVersion` is sent, so the app
  does not offer a store update.
- Signal resume validation with an HMAC webhook.

## What it does not do

These features are absent. The clients turn them off or log a warning, and nothing fails:

- Push notifications. The Android relay (`/v2/remote/hosts/:id/android-notification`), the iOS
  relay (`/notification`) and Live Activities return 404. A host logs a warning. Notifications
  show only while the app is open.
- `GET /v1/mobile/changelog`. Release notes then come from the public web site.
- Billing, hosted servers, marketplace, SMTP email, R2 and rate-limit bindings.
- Avatars (`PUT /v1/me/avatar` and `GET /v1/avatars/:id`). The clients show the blobatar.

## Analytics

A new user row has `analytics_enabled = 0`. The desktop app, the host and the mobile app read
this answer and change to the "off" mode: they send product events with a random install ID,
not with the account ID or the email. "Off" is not silence. Events keep their per-event
fields, but not the linked-only ones: site domains, tool names and the setup inventory.

To stop the traffic of a packaged desktop or host build completely, start it with
`OPENBOT_APP_VARIANT=preview`. That value is not `production`, so the app does not build an
analytics client and sends no failure reports. A self-built mobile app sends nothing when
`EXPO_PUBLIC_OPENPANEL_CLIENT_ID` and `EXPO_PUBLIC_OPENPANEL_CLIENT_SECRET` are not set at
build time.

## Run

```sh
cd account
bun install --frozen-lockfile
cp .env.example .env        # then fill in the values; chmod 0600
bun run src/selftest.ts     # 23 requests; no network and no IdP
bun run src/index.ts        # listens on OPENBOT_ACCOUNT_PORT
bun run src/backup.ts       # a dated copy of the database next to it
```

For a container:

```sh
docker compose up -d --build
docker compose exec account bun run src/seed.ts   # prints the first server claim
```

Then register a host:

```sh
sudo openbot login --claim --name my-host
```

The seed script needs `OPENBOT_BOOTSTRAP_EMAIL`. The claim expires after 15 minutes.

## Backup and restore

The database holds the ES256 ticket key and the admin token. If it is lost, every paired
client must sign in again. Back it up as one file:

```sh
docker compose exec account bun run src/backup.ts /data/account-backup.sqlite
docker compose cp account:/data/account-backup.sqlite ./account-backup.sqlite
```

`VACUUM INTO` reads a snapshot, so the service can keep running. The copy is as secret as the
volume. To restore, stop the stack, put the copy at `OPENBOT_ACCOUNT_DB` (default
`/data/account.sqlite`), remove the `-wal` and `-shm` files next to it, and start the stack.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `OPENBOT_ACCOUNT_PUBLIC_URL` | yes | Public HTTPS origin. The OIDC redirect URI uses it. |
| `OPENBOT_ACCOUNT_HOST`, `OPENBOT_ACCOUNT_PORT` | no | Listen address. Default `0.0.0.0:3100`. |
| `OPENBOT_ACCOUNT_DB` | no | SQLite path. Default `account.sqlite`. The container uses `/data/account.sqlite`. |
| `OPENBOT_AUTH_WEBHOOK_SECRET` | yes | HMAC secret for Signal. Equals `REMOTE_AUTH_WEBHOOK_SECRET`. |
| `OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN` | yes | Bearer token for the admin claim route. Use 48 or more characters. |
| `OPENBOT_SIGNAL_URL` | yes | The `wss://` Signal URL that a ticket gives to a client. |
| `OPENBOT_OIDC_ISSUER` | no | OIDC issuer. Empty disables company sign-in. |
| `OPENBOT_OIDC_CLIENT_ID`, `OPENBOT_OIDC_CLIENT_SECRET` | with OIDC | Client credentials. The redirect URI is `PUBLIC_URL/v1/auth/company/callback`. |
| `OPENBOT_OIDC_DOMAIN` | no | The only email domain that company sign-in accepts. |
| `OPENBOT_ALLOWED_EMAILS` | no | Comma-separated allow-list. Empty accepts each user of the issuer. |
| `OPENBOT_BOOTSTRAP_EMAIL` | for seed | Owner email for the first claim. |
| `OPENBOT_TICKET_TTL_SECONDS`, `OPENBOT_SESSION_TTL_SECONDS`, `OPENBOT_AUTH_SESSION_TTL_SECONDS` | no | Lifetimes. Defaults 300, 3600 and 30 days. |

Signal must read the ticket keys from this service. Use
`REMOTE_TICKET_JWKS_URL=http://account:3100/.well-known/jwks.json` on the same Docker network,
or a public URL. Both services must use the same webhook secret.

## Security

- The ticket signing key and the admin token stay in the `/data` volume. Back up the volume as
  one unit. A new key makes every stored client session invalid.
- Rate limits, row pruning, a non-root user, a read-only root file system, dropped
  capabilities and memory and PID limits are in `compose.yaml`.
- The public URL is the security boundary: it must be HTTPS, and the reverse proxy must not
  forward the admin route to the internet without a token.
