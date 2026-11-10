// ES256 remote tickets + the JWKS the desktop app and Signal verify them with.
//
// Contract (packages/contracts/src/signal-protocol/ticket.ts):
//   aud = "openbot-remote", alg = ES256, protocol range = [2,2].

import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";
import { type Db, hash, newToken, nowSeconds } from "./db";

export const REMOTE_TICKET_AUDIENCE = "openbot-remote";
export const REMOTE_TICKET_PROTOCOL_VERSION = 2;

export type RemoteRole = "host" | "owner" | "admin" | "member";

export interface TicketClaims {
  sessionId: string;
  hostId: string;
  userId: string;
  membershipId: string;
  role: RemoteRole;
  authEpoch: number;
  sessionExpiresAt: number;
  clientPublicKey?: string;
  signal?: string;
}

interface KeyRow {
  kid: string;
  private_jwk: string;
  public_jwk: string;
}

/** Returns the active signing key, creating one on first use. */
export async function activeKey(db: Db): Promise<KeyRow> {
  const row = db.raw
    .query<KeyRow, []>(
      "SELECT kid, private_jwk, public_jwk FROM ticket_keys WHERE active = 1 ORDER BY created_at DESC LIMIT 1",
    )
    .get();
  if (row) return row;
  return await createKey(db);
}

export async function createKey(db: Db): Promise<KeyRow> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = `openbot-remote-${newToken(6)}`;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "ES256", use: "sig" };
  const publicJwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  db.raw
    .query("INSERT INTO ticket_keys (kid, private_jwk, public_jwk, created_at, active) VALUES (?, ?, ?, ?, 1)")
    .run(kid, JSON.stringify(privateJwk), JSON.stringify(publicJwk), nowSeconds());
  return { kid, private_jwk: JSON.stringify(privateJwk), public_jwk: JSON.stringify(publicJwk) };
}

/** The public JWKS document, all active keys (old keys stay until retired). */
export function jwks(db: Db): { keys: JWK[] } {
  const rows = db.raw.query<{ public_jwk: string }, []>("SELECT public_jwk FROM ticket_keys WHERE active = 1").all();
  return { keys: rows.map((row): JWK => JSON.parse(row.public_jwk)) };
}

/** The active key row and its imported private key, shared by every ticket kind. */
async function signingKey(db: Db) {
  const key = await activeKey(db);
  const privateJwk: JWK = JSON.parse(key.private_jwk);
  const privateKey = await importJWK(privateJwk, "ES256");
  return { key, privateKey };
}

/** Mints a signed ticket. Returns the compact JWS and its expiry in epoch seconds. */
export async function mintTicket(
  db: Db,
  claims: TicketClaims,
  ttlSeconds: number,
  signalUrl: string,
): Promise<{ ticket: string; expiresAtSeconds: number }> {
  const { key, privateKey } = await signingKey(db);
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + ttlSeconds;
  const payload = {
    jti: newToken(16),
    sessionId: claims.sessionId,
    hostId: claims.hostId,
    userId: claims.userId,
    membershipId: claims.membershipId,
    role: claims.role,
    authEpoch: claims.authEpoch,
    protocolMinimum: REMOTE_TICKET_PROTOCOL_VERSION,
    protocolMaximum: REMOTE_TICKET_PROTOCOL_VERSION,
    sessionExpiresAt: claims.sessionExpiresAt,
    ...(claims.clientPublicKey ? { clientPublicKey: claims.clientPublicKey } : {}),
  };
  // A single Signal has no `signal` claim: it is the entry machine by default.
  const ticket = await new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setAudience(REMOTE_TICKET_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(privateKey);
  void signalUrl;
  return { ticket, expiresAtSeconds: expiresAt };
}

// Generic webhook routes (packages/contracts/src/signal-protocol/webhook-route.ts).
export const WEBHOOK_ROUTE_AUDIENCE = "openbot-webhook-route";
export const WEBHOOK_ROUTE_TTL_SECONDS = 5 * 60;
export const WEBHOOK_ROUTES_LIMIT = 64;
export const WEBHOOK_ROUTE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export interface WebhookRoute {
  id: string;
  /** When this service registered the route, in milliseconds. */
  linkedAt: number;
}

/**
 * The route ticket that the host's Signal ingress socket presents: the route IDs linked to one
 * host, signed with the remote ticket key under its own audience. Signal checks `hid` and
 * `routes` (remote/api/src/tokens.ts, `webhookRouteClaimsSchema`).
 */
export async function mintWebhookRouteTicket(db: Db, hostId: string, routes: WebhookRoute[]): Promise<string> {
  const { key, privateKey } = await signingKey(db);
  const issuedAt = nowSeconds();
  return await new SignJWT({ hid: hostId, routes })
    .setProtectedHeader({ alg: "ES256", kid: key.kid, typ: "JWT" })
    .setAudience(WEBHOOK_ROUTE_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + WEBHOOK_ROUTE_TTL_SECONDS)
    .sign(privateKey);
}

/** Hash a machine token for storage (`remote_hosts.machine_token_hash`). */
export function machineTokenHash(token: string): string {
  return hash(token);
}
