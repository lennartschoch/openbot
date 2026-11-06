// ES256 remote tickets + the JWKS the desktop app and Signal verify them with.
//
// Contract (packages/contracts/src/signal-protocol/ticket.ts):
//   aud = "openbot-remote", alg = ES256, protocol range = [2,2].

import { exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { hash, newToken, nowSeconds, type Db } from "./db";

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
    .query<KeyRow, []>("SELECT kid, private_jwk, public_jwk FROM ticket_keys WHERE active = 1 ORDER BY created_at DESC LIMIT 1")
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
  const rows = db.raw
    .query<{ public_jwk: string }, []>("SELECT public_jwk FROM ticket_keys WHERE active = 1")
    .all();
  return { keys: rows.map((row) => JSON.parse(row.public_jwk) as JWK) };
}

/** Mints a signed ticket. Returns the compact JWS and its expiry in epoch seconds. */
export async function mintTicket(
  db: Db,
  claims: TicketClaims,
  ttlSeconds: number,
  signalUrl: string,
): Promise<{ ticket: string; expiresAtSeconds: number }> {
  const key = await activeKey(db);
  const privateKey = await importJWK(JSON.parse(key.private_jwk) as JWK, "ES256");
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + ttlSeconds;
  const payload: Record<string, unknown> = {
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
  };
  if (claims.clientPublicKey) payload.clientPublicKey = claims.clientPublicKey;
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

/** Hash a machine token for storage (`remote_hosts.machine_token_hash`). */
export function machineTokenHash(token: string): string {
  return hash(token);
}
