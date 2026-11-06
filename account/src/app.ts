// The HTTP surface. Every shape here mirrors what the unmodified OpenBot desktop app,
// server and Signal expect; see ../SPEC.md. Responses are intentionally small.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Config } from "./config";
import { hash, newId, newToken, nowSeconds, prune, rateLimit, type Db } from "./db";
import { authorizationUrl, discover, redeemCode } from "./oidc";
import { machineTokenHash, mintTicket, jwks, type RemoteRole } from "./tickets";

type Json = Record<string, unknown>;

interface User {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  analytics_enabled: number | null;
  chat_color: string | null;
}

interface HostRow {
  host_id: string;
  owner_user_id: string;
  name: string;
  device_public_key: string | null;
  machine_token_hash: string | null;
  auth_epoch: number;
}

const COMPANY_SIGN_IN_RETURN = /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{2,5}\/company-sign-in$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

export function createApp(config: Config, db: Db) {
  // Prune expired rows at most every 5 minutes, so public traffic cannot grow the DB forever.
  let lastPrune = 0;
  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    if (nowSeconds() - lastPrune > 300) {
      lastPrune = nowSeconds();
      try {
        prune(db);
      } catch (error) {
        console.error(`prune failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      // ── Health + JWKS ───────────────────────────────────────────────────
      if (method === "GET" && path === "/health/live") return json({ status: "ok" });
      if (method === "GET" && path === "/.well-known/jwks.json") return json(jwks(db));

      // ── Human auth (Authelia OIDC) ──────────────────────────────────────
      if (method === "POST" && path === "/v1/auth/email/start") return await emailStart(config, db, request);
      if (method === "POST" && path === "/v1/auth/company/start") return await companyStart(config, db, request);
      if (method === "GET" && path === "/v1/auth/company/callback") return await companyCallback(config, db, url);
      if (method === "POST" && path === "/v1/auth/company/exchange") return await companyExchange(config, db, request);
      if (method === "POST" && path === "/v1/auth/logout") return logout(db, request);
      if (method === "GET" && path === "/v1/me") return me(db, request);

      // ── Mobile Connect (phone signs in by scanning a QR) ────────────────
      if (method === "POST" && path === "/v1/mobile-auth/ticket") return await createMobileTicket(db, request);
      if (method === "DELETE" && path === "/v1/mobile-auth/ticket") return cancelMobileTickets(db, request, url);
      if (method === "POST" && path === "/v1/mobile-auth/link") return await createMobileLink(db, request);
      if (method === "DELETE" && path === "/v1/mobile-auth/link") return revokeMobileLink(db, request, url);
      if (method === "POST" && path === "/v1/mobile-auth/redeem") return await redeemMobileTicket(config, db, request);
      if (method === "GET" && path === "/v1/mobile-auth/session") return mobileSession(db, request);
      if (method === "DELETE" && path === "/v1/mobile-auth/session") return logoutMobile(db, request);
      if (method === "GET" && path === "/v1/mobile-auth/devices") return listMobileDevices(db, request, url);
      {
        const devicesMatch = path.match(/^\/v1\/mobile-auth\/devices\/([^/]+)$/u);
        if (method === "DELETE" && devicesMatch) return revokeMobileDevice(db, decodeURIComponent(devicesMatch[1]), request);
      }

      // ── Server claims (host bootstrap without email) ────────────────────
      if (method === "POST" && path === "/v2/admin/server-claims") return await createServerClaim(config, db, request);
      if (method === "POST" && path === "/v2/server-claims/redeem") return await redeemServerClaim(config, db, request);

      // ── Remote control plane ────────────────────────────────────────────
      if (method === "POST" && path === "/v2/remote/hosts/register") return await registerHost(db, request);
      if (method === "GET" && path === "/v2/remote/hosts/") return listHosts(db, request);
      // OpenBot's hosted-server feature is not part of this deployment; answer empty so the app
      // stops logging 404s (it lists them at startup).
      if (method === "GET" && path === "/v2/hosting/servers/")
        return json({ available: false, servers: [], maxServers: 0, lifecycleAvailable: false });
      if (method === "POST" && path === "/v2/remote/sessions/") return await startSession(config, db, request);
      if (method === "POST" && path === "/v2/remote/resume/validate") return await resumeValidate(config, db, request);

      let m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/ticket$/u);
      if (method === "POST" && m) return await hostTicket(config, db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/key-handover$/u);
      if (method === "POST" && m) return await keyHandover(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/members\/$/u);
      if (method === "GET" && m) return listMembers(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/sessions\/([^/]+)\/ticket$/u);
      if (method === "POST" && m) return await sessionTicket(config, db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/sessions\/([^/]+)\/end$/u);
      if (method === "POST" && m) return endSession(db, decodeURIComponent(m[1]), request);

      return apiError(404, "not_found", `No route for ${method} ${path}.`);
    } catch (error) {
      console.error(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      return apiError(500, "internal_error", "The account service failed.");
    }
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function apiError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

async function readJson(request: Request): Promise<Json> {
  const value = (await request.json().catch(() => null)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
  return value as Json;
}

function bearer(request: Request): string | null {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/u);
  return match ? match[1].trim() : null;
}

/** Behind Caddy, the client address arrives in `X-Forwarded-For`. This service is only
 * reachable through Caddy or the tailnet admin, so the header is trusted for limiting. */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

function b64urlSha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function loadUser(db: Db, id: string): User | null {
  return (
    db.raw
      .query<User, [string]>(
        "SELECT id, email, name, avatar_url, analytics_enabled, chat_color FROM users WHERE id = ?",
      )
      .get(id) ?? null
  );
}

function findUser(db: Db, token: string | null, now = nowSeconds()): User | null {
  if (!token) return null;
  const tokenHash = hash(token);
  const row = db.raw
    .query<{ user_id: string }, [string, number]>(
      "SELECT user_id FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
    )
    .get(tokenHash, now);
  if (!row) return null;
  db.raw.query("UPDATE auth_sessions SET last_used_at = ? WHERE token_hash = ?").run(now, tokenHash);
  return loadUser(db, row.user_id);
}

function toAuthUser(user: User): Json {
  const body: Json = {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatar_url,
    analyticsEnabled: user.analytics_enabled === null ? null : user.analytics_enabled === 1,
  };
  if (user.chat_color) body.chatColor = user.chat_color;
  return body;
}

function issueAuthSession(config: Config, db: Db, userId: string, kind = "desktop"): string {
  const token = newToken(32);
  const now = nowSeconds();
  db.raw
    .query(
      "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_used_at, kind) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(newId(), userId, hash(token), now + config.authSessionTtlSeconds, now, now, kind);
  return token;
}

function upsertUserByEmail(db: Db, email: string, name: string | null): User {
  const normalized = email.trim().toLowerCase();
  const existing = db.raw
    .query<User, [string]>("SELECT id, email, name, avatar_url, analytics_enabled, chat_color FROM users WHERE email = ?")
    .get(normalized);
  if (existing) return existing;
  const now = nowSeconds();
  const id = `user_${newId()}`;
  db.raw
    .query("INSERT INTO users (id, email, name, created_at, updated_at, analytics_enabled) VALUES (?, ?, ?, ?, ?, 0)")
    .run(id, normalized, name, now, now);
  return loadUser(db, id)!;
}

// ── human auth ────────────────────────────────────────────────────────────

async function emailStart(config: Config, db: Db, request: Request): Promise<Response> {
  void config;
  if (!rateLimit(db, `email:start:${clientIp(request)}`, 20, 900)) {
    return apiError(429, "rate_limited", "Too many attempts. Try again later.");
  }
  const connection = db.raw.query("SELECT 1 AS found FROM company_connections WHERE enabled = 1 LIMIT 1").get();
  if (connection) return apiError(409, "company_sign_in_required", "Sign in with your Authelia account.");
  return apiError(400, "email_sign_in_disabled", "Email codes are disabled; sign in with Authelia.");
}

async function companyStart(config: Config, db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const returnTo = typeof body.returnTo === "string" ? body.returnTo : "";
  const clientState = typeof body.clientState === "string" ? body.clientState : "";
  const clientChallenge = typeof body.clientChallenge === "string" ? body.clientChallenge : "";
  if (!COMPANY_SIGN_IN_RETURN.test(returnTo) || !TOKEN_PATTERN.test(clientState) || !TOKEN_PATTERN.test(clientChallenge)) {
    return apiError(400, "invalid_company_sign_in", "The sign-in request is invalid.");
  }
  if (!rateLimit(db, `company:start:${clientIp(request)}`, 30, 900)) {
    return apiError(429, "rate_limited", "Too many sign-in attempts. Try again later.");
  }
  const connection = config.oidcDomain
    ? db.raw
        .query<{ domain: string; issuer: string; client_id: string; client_secret: string }, [string]>(
          "SELECT domain, issuer, client_id, client_secret FROM company_connections WHERE domain = ? AND enabled = 1",
        )
        .get(config.oidcDomain)
    : db.raw
        .query<{ domain: string; issuer: string; client_id: string; client_secret: string }, []>(
          "SELECT domain, issuer, client_id, client_secret FROM company_connections WHERE enabled = 1 LIMIT 1",
        )
        .get();
  if (!connection) return apiError(404, "company_sign_in_not_found", "This email does not use company sign-in.");

  const metadata = await discover(connection.issuer);
  const verifier = newToken(32);
  const nonce = newToken(16);
  const state = newToken(24);
  const now = nowSeconds();
  db.raw
    .query(
      `INSERT INTO company_flows (state_hash, issuer, client_id, client_secret, verifier, nonce, return_to, client_state, client_challenge, login_email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(hash(state), connection.issuer, connection.client_id, connection.client_secret, verifier, nonce, returnTo, clientState, clientChallenge, email, now, now + 600);

  return json({
    authorizationUrl: authorizationUrl(metadata, {
      clientId: connection.client_id,
      redirectUri: `${config.publicUrl}/v1/auth/company/callback`,
      state,
      nonce,
      codeChallenge: b64urlSha256(verifier),
      loginHint: email,
    }),
  });
}

async function companyCallback(config: Config, db: Db, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  if (!TOKEN_PATTERN.test(state)) return apiError(400, "invalid_company_sign_in", "Bad state.");
  const flow = db.raw
    .query<
      { issuer: string; client_id: string; client_secret: string; verifier: string; nonce: string; return_to: string; client_state: string; client_challenge: string },
      [string]
    >(
      "DELETE FROM company_flows WHERE state_hash = ? RETURNING issuer, client_id, client_secret, verifier, nonce, return_to, client_state, client_challenge",
    )
    .get(hash(state));
  if (!flow) return apiError(410, "company_sign_in_expired", "This sign-in expired. Start it again in OpenBot.");
  const back = (values: Record<string, string>) => redirect(flow.return_to, { state: flow.client_state, ...values });

  if (url.searchParams.get("error")) return back({ error: "company_provider_refused" });
  const code = url.searchParams.get("code") ?? "";
  if (!code) return back({ error: "company_sign_in_failed" });

  try {
    const metadata = await discover(flow.issuer);
    const identity = await redeemCode(metadata, {
      clientId: flow.client_id,
      clientSecret: flow.client_secret,
      code,
      codeVerifier: flow.verifier,
      redirectUri: `${config.publicUrl}/v1/auth/company/callback`,
      nonce: flow.nonce,
    });
    if (!identity.emailVerified) return back({ error: "company_email_missing" });
    // Single-tenant allow-list. Empty list = accept any user Authelia authenticates.
    if (config.allowedEmails.length > 0 && !config.allowedEmails.includes(identity.email)) {
      return back({ error: "company_email_domain_mismatch" });
    }
    // `oidcDomain` is optional. Leave it empty on a single-tenant self-host: Authelia is the
    // trust anchor, so any user it authenticates is accepted regardless of email domain.
    if (config.oidcDomain && !identity.email.endsWith(`@${config.oidcDomain}`)) {
      return back({ error: "company_email_domain_mismatch" });
    }
    const user = upsertUserByEmail(db, identity.email, identity.name);
    db.raw
      .query(
        `INSERT INTO identity_links (issuer, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(issuer, subject) DO UPDATE SET user_id = excluded.user_id, email = excluded.email`,
      )
      .run(metadata.issuer, identity.subject, user.id, identity.email, nowSeconds());
    const oneTime = newToken(24);
    const now = nowSeconds();
    db.raw
      .query("INSERT INTO company_codes (code_hash, user_id, client_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hash(oneTime), user.id, flow.client_challenge, now, now + 120);
    return back({ code: oneTime });
  } catch (error) {
    console.error(`company callback: ${error instanceof Error ? error.message : String(error)}`);
    return back({ error: "company_sign_in_failed" });
  }
}

async function companyExchange(config: Config, db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  const code = typeof body.code === "string" ? body.code : "";
  const codeVerifier = typeof body.codeVerifier === "string" ? body.codeVerifier : "";
  if (!TOKEN_PATTERN.test(code) || !TOKEN_PATTERN.test(codeVerifier)) {
    return apiError(400, "invalid_company_sign_in_code", "The sign-in did not finish. Try again.");
  }
  const now = nowSeconds();
  const row = db.raw
    .query<{ user_id: string }, [number, string, string, number]>(
      `UPDATE company_codes SET redeemed_at = ? WHERE code_hash = ? AND client_challenge = ? AND redeemed_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .get(now, hash(code), b64urlSha256(codeVerifier), now);
  if (!row) return apiError(400, "invalid_company_sign_in_code", "The sign-in did not finish. Try again.");
  const token = issueAuthSession(config, db, row.user_id);
  return json({ sessionToken: token, user: toAuthUser(loadUser(db, row.user_id)!) });
}

function logout(db: Db, request: Request): Response {
  const token = bearer(request);
  if (token) db.raw.query("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").run(nowSeconds(), hash(token));
  return new Response(null, { status: 204 });
}

function me(db: Db, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  return json(toAuthUser(user));
}

// ── server claims ─────────────────────────────────────────────────────────

async function createServerClaim(config: Config, db: Db, request: Request): Promise<Response> {
  if (bearer(request) !== config.serverClaimsAdminToken) return apiError(401, "unauthorized", "Bad admin token.");
  const body = await readJson(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email.includes("@")) return apiError(400, "invalid_email", "Enter a valid email address.");
  const user = upsertUserByEmail(db, email, null);
  const claim = newToken(32);
  const now = nowSeconds();
  const expiresAt = now + 900;
  db.raw
    .query("INSERT INTO server_claims (claim_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hash(claim), user.id, now, expiresAt);
  return json({ claim, expiresAt: expiresAt * 1000 });
}

async function redeemServerClaim(config: Config, db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  const claim = typeof body.claim === "string" ? body.claim.trim() : "";
  if (!claim) return apiError(400, "invalid_request", "The claim is required.");
  if (!rateLimit(db, `claim:redeem:${clientIp(request)}`, 20, 900)) {
    return apiError(429, "rate_limited", "Too many attempts. Try again later.");
  }
  const now = nowSeconds();
  const row = db.raw
    .query<{ user_id: string }, [number, string, number]>(
      `UPDATE server_claims SET redeemed_at = ? WHERE claim_hash = ? AND redeemed_at IS NULL AND expires_at > ?
       RETURNING user_id`,
    )
    .get(now, hash(claim), now);
  if (!row) return apiError(400, "server_claim_invalid", "This claim was used or has expired.");
  const token = issueAuthSession(config, db, row.user_id, "server");
  return json({ sessionToken: token, user: toAuthUser(loadUser(db, row.user_id)!) });
}

// ── remote control plane ──────────────────────────────────────────────────

function loadHost(db: Db, hostId: string): HostRow | null {
  return (
    db.raw
      .query<HostRow, [string]>(
        "SELECT host_id, owner_user_id, name, device_public_key, machine_token_hash, auth_epoch FROM remote_hosts WHERE host_id = ?",
      )
      .get(hostId) ?? null
  );
}

function membershipFor(db: Db, hostId: string, userId: string) {
  return db.raw
    .query<{ membership_id: string; role: RemoteRole; status: string }, [string, string]>(
      "SELECT membership_id, role, status FROM remote_memberships WHERE host_id = ? AND user_id = ?",
    )
    .get(hostId, userId);
}

async function registerHost(db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const hostId = typeof body.hostId === "string" ? body.hostId : "";
  const name = typeof body.name === "string" ? body.name : "";
  const ownerMembershipId = typeof body.ownerMembershipId === "string" ? body.ownerMembershipId : "";
  const devicePublicKey = typeof body.devicePublicKey === "string" ? body.devicePublicKey : null;
  const rotateCredential = body.rotateCredential === true;
  const providedToken = typeof body.machineToken === "string" ? body.machineToken : null;
  if (!hostId || !name || !ownerMembershipId) return apiError(400, "invalid_remote_request", "Bad registration.");

  const now = nowSeconds();
  let host = loadHost(db, hostId);
  if (!host) {
    db.raw
      .query(
        "INSERT INTO remote_hosts (host_id, owner_user_id, name, device_public_key, auth_epoch, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
      )
      .run(hostId, user.id, name, devicePublicKey, now, now);
    db.raw
      .query(
        "INSERT INTO remote_memberships (membership_id, host_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)",
      )
      .run(ownerMembershipId, hostId, user.id, now, now);
    host = loadHost(db, hostId)!;
  } else {
    const membership = membershipFor(db, hostId, user.id);
    if (!membership || membership.role !== "owner") return apiError(403, "forbidden", "Only the owner may register.");
    db.raw
      .query("UPDATE remote_hosts SET name = ?, device_public_key = ?, updated_at = ? WHERE host_id = ?")
      .run(name, devicePublicKey, now, hostId);
    host = loadHost(db, hostId)!;
  }

  let machineToken: string | null = null;
  if (rotateCredential || !host.machine_token_hash) {
    machineToken = newToken(32);
    db.raw
      .query("UPDATE remote_hosts SET machine_token_hash = ?, updated_at = ? WHERE host_id = ?")
      .run(machineTokenHash(machineToken), now, hostId);
  } else if (providedToken && host.machine_token_hash !== machineTokenHash(providedToken)) {
    return apiError(401, "unauthorized", "Invalid host credential.");
  }
  const membership = membershipFor(db, hostId, user.id)!;
  return json({
    hostId,
    name,
    membershipId: membership.membership_id,
    authEpoch: host.auth_epoch,
    machineToken,
  });
}

function listMembers(db: Db, hostId: string, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const requester = membershipFor(db, hostId, user.id);
  if (!requester || requester.status !== "active") return apiError(403, "forbidden", "No access to this host.");
  const rows = db.raw
    .query<
      {
        membership_id: string;
        role: RemoteRole;
        status: string;
        created_at: number;
        email: string;
        name: string | null;
        avatar_url: string | null;
        chat_color: string | null;
      },
      [string]
    >(
      `SELECT m.membership_id, m.role, m.status, m.created_at, u.email, u.name, u.avatar_url, u.chat_color
       FROM remote_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.host_id = ? ORDER BY m.created_at`,
    )
    .all(hostId);
  return json({
    members: rows.map((row) => ({
      membershipId: row.membership_id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      ...(row.chat_color ? { chatColor: row.chat_color } : {}),
      role: row.role,
      status: row.status,
      createdAt: row.created_at,
    })),
  });
}

function listHosts(db: Db, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const rows = db.raw
    .query<
      { host_id: string; name: string; device_public_key: string | null; auth_epoch: number; membership_id: string; role: RemoteRole },
      [string]
    >(
      `SELECT h.host_id, h.name, h.device_public_key, h.auth_epoch, m.membership_id, m.role
       FROM remote_memberships m JOIN remote_hosts h ON h.host_id = m.host_id
       WHERE m.user_id = ? AND m.status = 'active' ORDER BY h.created_at`,
    )
    .all(user.id);
  return json({
    hosts: rows.map((row) => ({
      hostId: row.host_id,
      name: row.name,
      logoKey: null,
      devicePublicKey: row.device_public_key,
      keyHandovers: [],
      authEpoch: row.auth_epoch,
      membershipId: row.membership_id,
      role: row.role,
    })),
  });
}

async function hostTicket(config: Config, db: Db, hostId: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const machineToken = typeof body.machineToken === "string" ? body.machineToken : "";
  const host = loadHost(db, hostId);
  if (!host || !host.machine_token_hash || host.machine_token_hash !== machineTokenHash(machineToken)) {
    return apiError(401, "unauthorized", "Invalid host credential.");
  }
  const owner = membershipFor(db, hostId, host.owner_user_id);
  if (!owner || owner.status !== "active") return apiError(403, "forbidden", "The host has no active owner.");
  const now = nowSeconds();
  const sessionId = `host:${hostId}`;
  const expiresAt = now + config.sessionTtlSeconds;
  db.raw
    .query(
      `INSERT INTO remote_sessions (session_id, host_id, user_id, membership_id, started_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at, ended_at = NULL`,
    )
    .run(sessionId, hostId, host.owner_user_id, owner.membership_id, now, expiresAt);
  const { ticket, expiresAtSeconds } = await mintTicket(
    db,
    {
      sessionId,
      hostId,
      userId: host.owner_user_id,
      membershipId: owner.membership_id,
      role: "host",
      authEpoch: host.auth_epoch,
      sessionExpiresAt: expiresAt,
    },
    config.ticketTtlSeconds,
    config.signalUrl,
  );
  return json({ ticket, expiresAt: expiresAtSeconds * 1000, signalUrl: config.signalUrl });
}

async function keyHandover(db: Db, hostId: string, request: Request): Promise<Response> {
  const body = await readJson(request);
  const machineToken = typeof body.machineToken === "string" ? body.machineToken : "";
  const host = loadHost(db, hostId);
  if (!host || !host.machine_token_hash || host.machine_token_hash !== machineTokenHash(machineToken)) {
    return apiError(401, "unauthorized", "Invalid host credential.");
  }
  const handover = body.handover as Json | undefined;
  if (!handover || typeof handover.publicKey !== "string") return apiError(400, "invalid_request", "Bad handover.");
  const now = nowSeconds();
  db.raw
    .query(
      `INSERT OR IGNORE INTO remote_host_key_handovers (host_id, issued_at, previous_public_key, public_key, previous_signature, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      hostId,
      typeof handover.issuedAt === "number" ? handover.issuedAt : now,
      typeof handover.previousPublicKey === "string" ? handover.previousPublicKey : host.device_public_key ?? "",
      handover.publicKey,
      typeof handover.previousSignature === "string" ? handover.previousSignature : "",
      typeof handover.signature === "string" ? handover.signature : "",
      now,
    );
  db.raw.query("UPDATE remote_hosts SET device_public_key = ?, updated_at = ? WHERE host_id = ?").run(handover.publicKey, now, hostId);
  return new Response(null, { status: 204 });
}

async function startSession(config: Config, db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const hostId = typeof body.hostId === "string" ? body.hostId : "";
  const membership = membershipFor(db, hostId, user.id);
  if (!membership || membership.status !== "active") return apiError(403, "forbidden", "No access to this host.");
  const now = nowSeconds();
  const sessionId = newId();
  const expiresAt = now + config.sessionTtlSeconds;
  db.raw
    .query(
      "INSERT INTO remote_sessions (session_id, host_id, user_id, membership_id, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(sessionId, hostId, user.id, membership.membership_id, now, expiresAt);
  return json({ sessionId, hostId, expiresAt: expiresAt * 1000 }, 201);
}

async function sessionTicket(config: Config, db: Db, sessionId: string, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const clientPublicKey = typeof body.clientPublicKey === "string" ? body.clientPublicKey : "";
  if (!clientPublicKey) return apiError(400, "invalid_remote_request", "The client public key is required.");
  const session = db.raw
    .query<{ host_id: string; user_id: string; membership_id: string; expires_at: number; ended_at: number | null }, [string]>(
      "SELECT host_id, user_id, membership_id, expires_at, ended_at FROM remote_sessions WHERE session_id = ?",
    )
    .get(sessionId);
  if (!session || session.user_id !== user.id) return apiError(404, "not_found", "Unknown session.");
  if (session.ended_at !== null || session.expires_at <= nowSeconds()) {
    return apiError(410, "session_expired", "The session has ended.");
  }
  const membership = db.raw
    .query<{ role: RemoteRole; auth_epoch: number }, [string, string]>(
      `SELECT m.role, h.auth_epoch FROM remote_memberships m JOIN remote_hosts h ON h.host_id = m.host_id
       WHERE m.membership_id = ? AND h.host_id = ?`,
    )
    .get(session.membership_id, session.host_id);
  if (!membership) return apiError(403, "forbidden", "The membership is gone.");
  const { ticket, expiresAtSeconds } = await mintTicket(
    db,
    {
      sessionId,
      hostId: session.host_id,
      userId: user.id,
      membershipId: session.membership_id,
      role: membership.role,
      authEpoch: membership.auth_epoch,
      sessionExpiresAt: session.expires_at,
      clientPublicKey,
    },
    config.ticketTtlSeconds,
    config.signalUrl,
  );
  return json({ ticket, expiresAt: expiresAtSeconds * 1000, signalUrl: config.signalUrl });
}

function endSession(db: Db, sessionId: string, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  db.raw
    .query("UPDATE remote_sessions SET ended_at = ? WHERE session_id = ? AND user_id = ? AND ended_at IS NULL")
    .run(nowSeconds(), sessionId, user.id);
  return new Response(null, { status: 204 });
}

async function resumeValidate(config: Config, db: Db, request: Request): Promise<Response> {
  const raw = await request.text();
  const timestamp = request.headers.get("OpenBot-Timestamp") ?? "";
  const signature = request.headers.get("OpenBot-Signature") ?? "";
  const expected = createHmac("sha256", config.authWebhookSecret).update(`${timestamp}.${raw}`).digest("base64url");
  if (!safeEqual(signature, expected)) return apiError(401, "invalid_signature", "Bad service signature.");
  let claims: Json;
  try {
    claims = JSON.parse(raw) as Json;
  } catch {
    return apiError(400, "invalid_resume_claims", "Bad resume claims.");
  }
  const sessionId = typeof claims.sessionId === "string" ? claims.sessionId : "";
  const hostId = typeof claims.hostId === "string" ? claims.hostId : "";
  const userId = typeof claims.userId === "string" ? claims.userId : "";
  const authEpoch = typeof claims.authEpoch === "number" ? claims.authEpoch : -1;
  const sessionExpiresAt = typeof claims.sessionExpiresAt === "number" ? claims.sessionExpiresAt : 0;
  const now = nowSeconds();
  const session = db.raw
    .query<{ host_id: string; user_id: string; expires_at: number; ended_at: number | null }, [string]>(
      "SELECT host_id, user_id, expires_at, ended_at FROM remote_sessions WHERE session_id = ?",
    )
    .get(sessionId);
  const host = loadHost(db, hostId);
  const valid =
    !!session &&
    !!host &&
    session.host_id === hostId &&
    session.user_id === userId &&
    session.ended_at === null &&
    session.expires_at > now &&
    sessionExpiresAt > now &&
    host.auth_epoch === authEpoch;
  return json({ valid });
}

function redirect(target: string, params: Record<string, string>): Response {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Response(null, { status: 303, headers: { Location: url.toString(), "Cache-Control": "no-store" } });
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ── Mobile Connect ────────────────────────────────────────────────────────

/** The signed-in desktop proves it owns the host it shows a QR for. */
function mobileHostBinding(db: Db, userId: string, value: unknown): { hostId: string; fingerprint: string } | null {
  if (!value || typeof value !== "object") return null;
  const host = value as { hostId?: unknown; fingerprint?: unknown };
  if (typeof host.hostId !== "string") return null;
  const row = loadHost(db, host.hostId);
  if (!row) return null;
  const membership = membershipFor(db, host.hostId, userId);
  if (!membership || membership.status !== "active") return null;
  return { hostId: row.host_id, fingerprint: typeof host.fingerprint === "string" ? host.fingerprint : "" };
}

async function createMobileTicket(db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const binding = mobileHostBinding(db, user.id, body.host);
  if (!binding) return apiError(400, "invalid_mobile_host", "The host binding is invalid.");
  const ticket = newToken(24);
  const now = nowSeconds();
  const expiresAt = now + 300;
  db.raw
    .query(
      "INSERT INTO mobile_tickets (claim_hash, user_id, host_id, fingerprint, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(hash(ticket), user.id, binding.hostId, binding.fingerprint, now, expiresAt);
  // `expiresAt` is milliseconds, like every account timestamp the apps compare to Date.now().
  return json({ ticket, expiresAt: expiresAt * 1000 });
}

function cancelMobileTickets(db: Db, request: Request, url: URL): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const hostId = url.searchParams.get("host") ?? "";
  if (hostId) {
    db.raw
      .query("UPDATE mobile_tickets SET redeemed_at = ? WHERE user_id = ? AND host_id = ? AND redeemed_at IS NULL")
      .run(nowSeconds(), user.id, hostId);
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function createMobileLink(db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const binding = mobileHostBinding(db, user.id, body.host);
  if (!binding) return apiError(400, "invalid_mobile_host", "The host binding is invalid.");
  const token = newToken(24);
  const now = nowSeconds();
  db.raw
    .query(
      `INSERT INTO mobile_links (host_id, user_id, fingerprint, token_hash, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(host_id) DO UPDATE SET user_id = excluded.user_id, fingerprint = excluded.fingerprint,
         token_hash = excluded.token_hash, created_at = excluded.created_at`,
    )
    .run(binding.hostId, user.id, binding.fingerprint, hash(token), now);
  return json({ link: token, createdAt: now * 1000 });
}

function revokeMobileLink(db: Db, request: Request, url: URL): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const hostId = url.searchParams.get("host") ?? "";
  if (hostId) db.raw.query("DELETE FROM mobile_links WHERE host_id = ? AND user_id = ?").run(hostId, user.id);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

async function redeemMobileTicket(config: Config, db: Db, request: Request): Promise<Response> {
  const body = await readJson(request);
  const ticket = typeof body.ticket === "string" ? body.ticket : "";
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : "";
  const deviceName = typeof body.deviceName === "string" ? body.deviceName : "";
  const platformRaw = body.platform;
  const platform = platformRaw === "ios" || platformRaw === "android" || platformRaw === "unknown" ? platformRaw : "";
  if (!ticket || !deviceId || !deviceName || !platform) {
    return apiError(400, "invalid_mobile_ticket", "The Mobile Connect code is invalid.");
  }
  if (!rateLimit(db, `mobile:redeem:${clientIp(request)}`, 60, 900)) {
    return apiError(429, "rate_limited", "Too many attempts. Try again later.");
  }
  const now = nowSeconds();
  let hostId: string | null = null;
  let fingerprint = "";
  let userId: string | null = null;
  let via: "code" | "link" = "code";
  const oneTime = db.raw
    .query<{ user_id: string; host_id: string; fingerprint: string }, [number, string, number]>(
      `UPDATE mobile_tickets SET redeemed_at = ? WHERE claim_hash = ? AND redeemed_at IS NULL AND expires_at > ?
       RETURNING user_id, host_id, fingerprint`,
    )
    .get(now, hash(ticket), now);
  if (oneTime) {
    hostId = oneTime.host_id;
    fingerprint = oneTime.fingerprint;
    userId = oneTime.user_id;
  } else {
    const link = db.raw
      .query<{ user_id: string; host_id: string; fingerprint: string }, [string]>(
        "SELECT user_id, host_id, fingerprint FROM mobile_links WHERE token_hash = ?",
      )
      .get(hash(ticket));
    if (link) {
      hostId = link.host_id;
      fingerprint = link.fingerprint;
      userId = link.user_id;
      via = "link";
    }
  }
  if (!hostId || !userId) return apiError(401, "invalid_mobile_ticket", "The Mobile Connect code is invalid or expired.");
  const token = newToken(32);
  db.raw
    .query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_used_at, kind, device_id, device_name, platform, via, host_id)
       VALUES (?, ?, ?, ?, ?, ?, 'mobile', ?, ?, ?, ?, ?)`,
    )
    .run(newId(), userId, hash(token), now + config.authSessionTtlSeconds, now, now, deviceId, deviceName, platform, via, hostId);
  return json({ sessionToken: token, user: toAuthUser(loadUser(db, userId)!), host: { hostId, fingerprint } });
}

function mobileSession(db: Db, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "The mobile session is invalid.");
  return json(toAuthUser(user));
}

function logoutMobile(db: Db, request: Request): Response {
  const token = bearer(request);
  if (token) db.raw.query("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").run(nowSeconds(), hash(token));
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

function listMobileDevices(db: Db, request: Request, url: URL): Response {
  const token = bearer(request);
  const user = findUser(db, token);
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const includeDesktop = url.searchParams.get("includeDesktop") === "true";
  const hostFilter = url.searchParams.get("host");
  const rows = db.raw
    .query<
      {
        id: string;
        kind: string;
        device_name: string | null;
        platform: string | null;
        via: string | null;
        host_id: string | null;
        created_at: number;
        last_used_at: number;
        token_hash: string;
      },
      [string, number]
    >(
      `SELECT id, kind, device_name, platform, via, host_id, created_at, last_used_at, token_hash
       FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(user.id, nowSeconds());
  const tokenHash = hash(token ?? "");
  if (includeDesktop) {
    return json({
      sessions: rows.map((row) => ({
        sessionId: row.id,
        name: row.device_name ?? (row.kind === "mobile" ? "Phone" : "Desktop"),
        kind: row.kind === "mobile" ? "mobile" : "desktop",
        current: row.token_hash === tokenHash,
        connectedAt: row.created_at * 1000,
        lastActiveAt: row.last_used_at * 1000,
      })),
    });
  }
  const devices = rows
    .filter((row) => row.kind === "mobile")
    .filter((row) => !hostFilter || row.host_id === hostFilter)
    .map((row) => ({
      sessionId: row.id,
      name: row.device_name ?? "Phone",
      platform: row.platform === "ios" || row.platform === "android" ? row.platform : "unknown",
      connectedAt: row.created_at * 1000,
      lastActiveAt: row.last_used_at * 1000,
      via: row.via === "link" ? "link" : "code",
    }));
  return json({ devices });
}

function revokeMobileDevice(db: Db, sessionId: string, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  db.raw
    .query("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ?")
    .run(nowSeconds(), sessionId, user.id);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
