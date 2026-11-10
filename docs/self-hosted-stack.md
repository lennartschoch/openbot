# Self-hosted stack from start to finish

## Quickstart

The whole stack on one Linux host with Docker and your OIDC identity provider. The sections after
this one explain each step. Replace `api.example.com`, `signal.example.com`, `turn.example.com` and
`owner@example.com` with your own values.

```sh
# 1. The account service. Fill in .env first: the public URL, the three secrets,
#    the Signal URL, the OIDC values and the owner email. See step 1 below.
cd account && cp .env.example .env && chmod 0600 .env && "$EDITOR" .env
docker compose up -d --build
docker compose exec account bun run src/seed.ts      # prints the server claim

# 2. Signal and TURN. Fill in remote/.env.self-hosted first. See step 2 below.
cp remote/.env.example remote/.env.self-hosted && "$EDITOR" remote/.env.self-hosted
docker compose -f remote/compose.yaml --env-file remote/.env.self-hosted up -d --build

# 3. The headless server. Add OPENBOT_AUTH_API_URL to the environment of compose.yaml.
curl -fsSLO https://raw.githubusercontent.com/lennartschoch/openbot/main/docker/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/lennartschoch/openbot/main/docker/seccomp.json
docker compose up -d
docker exec -it openbot openbot login --claim --name my-server   # paste the claim

# 4. The desktop: open the app, Change account service, fill in the two URLs,
#    Save, Restart OpenBot, sign in. See step 4 below.

# 5. The phone: scan the QR with the OpenBot phone app.
docker exec -it openbot openbot mobile-connect
```

| Fill in | In | Value |
| --- | --- | --- |
| Account service | `account/.env` | `OPENBOT_ACCOUNT_PUBLIC_URL=https://api.example.com`, `OPENBOT_SIGNAL_URL=wss://signal.example.com/v1/signal`, `OPENBOT_BOOTSTRAP_EMAIL=owner@example.com`, and `openssl rand -base64 48` for `OPENBOT_AUTH_WEBHOOK_SECRET` and `OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN` |
| Sign-in | `account/.env` | `OPENBOT_OIDC_ISSUER`, `OPENBOT_OIDC_CLIENT_ID`, `OPENBOT_OIDC_CLIENT_SECRET` of your identity provider; `OPENBOT_OIDC_DOMAIN` limits the email domain |
| Signal and TURN | `remote/.env.self-hosted` | `SIGNAL_DOMAIN`, `TURN_DOMAIN`, `TURN_PUBLIC_IP`, `ACME_EMAIL`, `CLOUDFLARE_DNS_API_TOKEN`, `REMOTE_TICKET_JWKS_URL=https://api.example.com/.well-known/jwks.json`, `REMOTE_CONTROL_PLANE_URL=https://api.example.com`, `REMOTE_AUTH_WEBHOOK_SECRET` (the same value as in the account service), and `openssl rand -base64 48` for `REMOTE_SESSION_SECRET`, `TURN_SHARED_SECRET`, `REMOTE_METRICS_TOKEN` |
| Headless server | `docker/compose.yaml` | `OPENBOT_AUTH_API_URL=https://api.example.com` in the `environment` of the `openbot` service |

The reverse proxy serves `https://api.example.com` and serves it only over HTTPS; the account
service publishes on the loopback interface. TURN needs the ports of the
[production requirements](../remote/README.md#production-requirements). The stack then works with
nothing on `openbot.run`.

## The pieces

This guide runs the whole OpenBot stack of this fork on one Linux host, with Docker:

| Piece | Runs where | What it does |
| --- | --- | --- |
| Account service | The Bun service in [`account/`](../account/README.md), in Docker (`api.example.com`) | Holds the account, sends the connection tickets, and signs them. One owner, one SQLite file. |
| Signal and TURN | Docker Compose in [`remote/`](../remote/README.md) (`signal.example.com`, `turn.example.com`) | Carries the connection set-up of desktops and phones, and relays their traffic when a direct path does not work. |
| Headless server | The Docker image `ghcr.io/lennartschoch/openbot` | Runs the agents with no screen. Shows in the server list of the account. |
| Desktop and phone | Your computers | Sign in to the account service and connect to the server through it. |

Sign-in on this stack works through your own OIDC identity provider, for example Authelia. The
account service sends no email codes, so the stack needs no SMTP account.

Detailed pages that this guide links to instead of repeating:

- [`account/README.md`](../account/README.md) - the account service: settings, backup, security.
- [`remote/README.md`](../remote/README.md) - Signal and TURN: ports, DNS, certificates.
- [Docker](docker.md) - the headless server container: data, upgrades, instances, security.
- [Self-hosted servers](self-hosted-server.md) - the `openbot` terminal command.

In the examples, the account service is `api.example.com`, Signal is `signal.example.com`, TURN is
`turn.example.com`, and your OIDC email is `owner@example.com`. Use your own values.

## What you need

- A Linux host with Docker Engine and Docker Compose, and a static public IPv4 address. The same
  host can run all three Docker pieces.
- Two DNS names with HTTPS: one for the account service, one for Signal. TURN needs a third name and
  the [production requirements](../remote/README.md#production-requirements) list its ports.
- A reverse proxy in front of the account service. Its public URL must be HTTPS, because the
  sign-in of the desktop returns to it. The reverse proxy is also the only client of the account
  service: publish it on the loopback interface, as its Compose file does.
- An OIDC identity provider that the owner can sign in to, and its client ID and client secret for
  the account service.
- A clone of this repository on the host, at the release you want to run.

## 1. The account service

1. Fill in `account/.env` from `account/.env.example`:

   ```sh
   cd account
   cp .env.example .env && chmod 0600 .env
   ```

   | Value | Use |
   | --- | --- |
   | `OPENBOT_ACCOUNT_PUBLIC_URL` | `https://api.example.com`. Your reverse proxy points this name at the published port. |
   | `OPENBOT_AUTH_WEBHOOK_SECRET` | `openssl rand -base64 48`. Signal uses the same value. |
   | `OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN` | `openssl rand -base64 48`. Makes more claims after the first one. |
   | `OPENBOT_SIGNAL_URL` | `wss://signal.example.com/v1/signal`. A ticket names it. |
   | `OPENBOT_OIDC_ISSUER`, `OPENBOT_OIDC_CLIENT_ID`, `OPENBOT_OIDC_CLIENT_SECRET` | Your identity provider. Company sign-in stays off without them, and no client could sign in. |
   | `OPENBOT_OIDC_DOMAIN` | The one email domain that may sign in, for example `example.com`. Empty accepts every domain of the issuer. |
   | `OPENBOT_ALLOWED_EMAILS` | Empty accepts each user of the issuer. |
   | `OPENBOT_BOOTSTRAP_EMAIL` | `owner@example.com`. The email that the first claim is for. |

2. Build and start it. Then make the first server claim; the seed script prints it:

   ```sh
   docker compose up -d --build
   docker compose exec account bun run src/seed.ts
   ```

   Save the claim. It works once, for 15 minutes, and it belongs to `OPENBOT_BOOTSTRAP_EMAIL`. For
   more claims later, `OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN` makes one:

   ```sh
   printf '{"email":"owner@example.com"}' |
     curl --fail -sS -X POST https://api.example.com/v2/admin/server-claims \
       -H "Authorization: Bearer $OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN" \
       -H 'content-type: application/json' --data-binary @- |
     sed -n 's/.*"claim":"\([A-Za-z0-9_-]*\)".*/\1/p'
   ```

3. Check the service through the reverse proxy:

   ```sh
   curl -fsS https://api.example.com/health/live
   curl -fsS https://api.example.com/.well-known/jwks.json
   ```

The ticket key lives in the SQLite file of the account service. Back the volume up as one unit, and
keep it secret: with it, a person can open each host of the account. See
[Backup and restore](../account/README.md#backup-and-restore).

## 2. Signal and TURN

1. Copy `remote/.env.example` to `remote/.env.self-hosted` and set these values:

   - `SIGNAL_DOMAIN`, `TURN_DOMAIN`, `TURN_PUBLIC_IP`, `ACME_EMAIL`.
   - `CLOUDFLARE_DNS_API_TOKEN`: a token with DNS edit access to your zone, for the certificates.
   - `REMOTE_TICKET_JWKS_URL=https://api.example.com/.well-known/jwks.json`. Signal verifies the
     tickets that the account service signs from there.
   - `REMOTE_CONTROL_PLANE_URL=https://api.example.com`.
   - `REMOTE_AUTH_WEBHOOK_SECRET`: the same value as `OPENBOT_AUTH_WEBHOOK_SECRET` of step 1.
   - `REMOTE_SESSION_SECRET`, `TURN_SHARED_SECRET`, `REMOTE_METRICS_TOKEN`: `openssl rand -base64 48`.
   - Leave `SLACK_SIGNING_SECRET`, `GITHUB_WEBHOOK_SECRET`, `DISCORD_*` and `TELEGRAM_*` empty.

2. Start them and check Signal:

   ```sh
   docker compose -f remote/compose.yaml --env-file remote/.env.self-hosted up -d --build
   curl -fsS https://signal.example.com/health/ready
   ```

The ports, the DNS records and the notes for a reverse proxy that already uses port 443 are in
[Signal production requirements](../remote/README.md#production-requirements).

## 3. The headless server

1. Point the OpenBot container at your account service. Download the Compose file, then add the
   account service to the `environment` of the `openbot` service:

   ```yaml
       environment:
         - OPENBOT_AUTH_API_URL=https://api.example.com
   ```

   ```sh
   curl -fsSLO https://raw.githubusercontent.com/lennartschoch/openbot/main/docker/compose.yaml
   curl -fsSLO https://raw.githubusercontent.com/lennartschoch/openbot/main/docker/seccomp.json
   docker compose up -d
   ```

2. Sign the server in with the claim of step 1:

   ```sh
   docker exec -it openbot openbot login --claim --name my-server
   ```

   The server then shows in the server list of the account, under the email of the claim. The
   options that the examples need, the data volume, upgrades and the security limits are in
   [Docker](docker.md). Without `OPENBOT_AUTH_API_URL`, the container talks to `openbot.run`.

## 4. Connect a desktop

The desktop signs in to the account service that the sign-in screen names.

1. Open the OpenBot desktop app.
2. On the sign-in screen, select **Change account service**.
3. Fill in the account service URL, `https://api.example.com`.
4. Fill in the Signal URL of this stack, `wss://signal.example.com/v1/signal`.
5. Select **Save**, then **Restart OpenBot**.
6. Select the sign-in. Your browser opens at your identity provider, and OpenBot continues when you
   have signed in there.
7. The server from step 3 is in the server list. Open it and connect a provider, as on a
   [hosted server](hosted-servers.md#providers).

Two rules keep the sign-in clean:

- The saved session belongs to the service that issued it. If the app was signed in to
  `openbot.run` before, sign out first (profile menu), then change the account service. A restart
  without a sign-out sends the old token to the other service once before the app signs you out.
- To go back to `openbot.run`, sign out, then open **Change account service** again and clear both
  fields, and restart.

Every desktop that connects to this stack needs the same two URLs. `OPENBOT_AUTH_API_URL` and
`OPENBOT_REMOTE_SIGNAL_URL` keep working and still win over the saved values.

## 5. Connect a phone from the terminal

The phone app signs in with a Mobile Connect code. A headless server has no screen for it, so the
`openbot` command shows the code in the terminal:

```sh
docker exec -it openbot openbot mobile-connect
```

1. Install the OpenBot phone app.
2. Run the command above. The terminal draws a QR code.
3. In the phone app, select **Scan QR code** and scan the code. It works for one sign-in and
   expires after two minutes.

The code carries the address of this account service, so the phone signs in to your service. It
then shows the servers of the account and opens this server first. The phone needs nothing else:
it learns the Signal address from the code. Email sign-in on the phone always uses `openbot.run`,
so use the QR code for this stack. To remove a phone later, open the desktop app,
**Settings > Mobile Connect**. On a native [self-hosted server](self-hosted-server.md#phone-app)
without Docker, the same command is `openbot mobile-connect`.

## What does not work on this stack

The account service is single-tenant on purpose, and it leaves some features out. See
[What it does not do](../account/README.md#what-it-does-not-do): push notifications and Live
Activities, billing and hosted server plans, avatars, the marketplace, and the email-code sign-in
of the phone. The desktop, the phone, the headless server and remote desktop work.
