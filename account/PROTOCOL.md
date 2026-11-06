# Account service — protocol contract

Copied from the deployment repository as the contract that the unmodified desktop, host,
Signal and mobile clients require. The service in this directory implements it instead of
`apps/auth-api`. The version note below is the one the contract was read from.

Reverse-engineered from the unmodified clients at OpenBot `v0.62.0`. The desktop
app (`src/main/central-auth-manager.ts`), the host, and Signal
(`remote/api/src/tokens.ts`) are not modified, so these shapes must match.

## Ticket (ES256 JWT)

- Header: `alg=ES256`, `kid`.
- Audience: `openbot-remote`.
- Claims: `jti, sessionId, hostId, userId, membershipId, role, authEpoch,
  protocolMinimum=2, protocolMaximum=2, sessionExpiresAt (s), clientPublicKey?,
  signal?, iat, exp` (`packages/contracts/src/signal-protocol/ticket.ts`).
- Published at `GET /.well-known/jwks.json`; Signal may instead be given
  `REMOTE_TICKET_PUBLIC_KEYS`.

## Responses

| Endpoint | Response |
| --- | --- |
| `POST /v2/admin/server-claims` (Bearer admin) `{email}` | `{claim, expiresAt}` |
| `POST /v2/server-claims/redeem` `{claim}` | `{sessionToken, user}` |
| `POST /v2/remote/hosts/register` (Bearer) `{hostId,name,ownerMembershipId,devicePublicKey?,rotateCredential?,machineToken?}` | `{hostId,name,membershipId,authEpoch,machineToken\|null}` |
| `GET /v2/remote/hosts/` (Bearer) | `{hosts:[{hostId,name,logoKey,devicePublicKey,keyHandovers,authEpoch,membershipId,role}]}` |
| `POST /v2/remote/hosts/:id/ticket` `{machineToken,signalHome?,failedSignalUrl?}` | `{ticket,expiresAt(ms),signalUrl}` |
| `POST /v2/remote/hosts/:id/key-handover` `{machineToken,handover}` | 204 |
| `POST /v2/remote/sessions/` (Bearer) `{hostId}` | **201** `{sessionId,hostId,expiresAt(ms)}` |
| `POST /v2/remote/sessions/:id/ticket` (Bearer) `{clientPublicKey}` | `{ticket,expiresAt(ms),signalUrl}` |
| `POST /v2/remote/sessions/:id/end` (Bearer) | 204 |
| `POST /v2/remote/resume/validate` (HMAC) | `{valid:boolean}` |
| `GET /v1/me` (Bearer) | `CentralAuthUser` |
| `PATCH /v1/me/profile` (Bearer) `{name}` | `CentralAuthUser`. Name 3-20 visible characters. |
| `PUT /v1/me/analytics` (Bearer) `{enabled, ageMs?}` | `CentralAuthUser` with the new `analyticsEnabled`. |
| `PUT /v1/me/chat-color` (Bearer) `{chatColor}` | `CentralAuthUser`. `#rrggbb` in lower case, or null. |
| `GET /v1/mobile/features?platform=<android\|ios>&version=<x.y.z>` (no auth) | `{features:{cloudServers:boolean,browser:boolean}}`. `latestVersion` is optional and this service omits it. An unknown platform gets both features off. |
| `POST /v1/auth/email/start` `{email}` | 409 `{error:{code:"company_sign_in_required"}}` when the domain uses company sign-in |
| `POST /v1/auth/company/start` `{email,returnTo,clientState,clientChallenge}` | `{authorizationUrl}` |
| `GET /v1/auth/company/callback` | 303 to `returnTo?state=<clientState>&code=<one-time>` (or `&error=<code>`) |
| `POST /v1/auth/company/exchange` `{code,codeVerifier}` | `{sessionToken,user}` |

`user` = `{id,email,name,avatarUrl,analyticsEnabled,chatColor?}`.

## Errors

`{error:{code,message}}`. The app keys on `code`; notable ones:
`company_sign_in_required` (409), `invalid_company_sign_in_code`,
`company_email_domain_mismatch`, `server_claim_invalid`.

## Service signature (Signal → account)

`POST /v2/remote/resume/validate` carries `OpenBot-Timestamp` and
`OpenBot-Signature = base64url(HMAC-SHA256(secret, "<timestamp>.<raw body>"))`,
secret = `REMOTE_AUTH_WEBHOOK_SECRET` on both sides.

## Two PKCE legs

1. Desktop → account: the app sends `clientChallenge = base64url(sha256(verifier))`
   at `/company/start`; the account checks it at `/company/exchange`.
2. account → Authelia: the account generates its own verifier, sends the derived
   challenge in the authorization URL, and presents the verifier at the token
   endpoint.
