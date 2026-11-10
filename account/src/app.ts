// The HTTP surface. Every shape here mirrors what the unmodified OpenBot desktop app,
// server and Signal expect; see ../SPEC.md. Responses are intentionally small.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type Config, PERSISTENT_SESSION_EXPIRES_AT_SECONDS } from "./config";
import { type Db, hash, newId, newToken, nowSeconds, prune, rateLimit } from "./db";
import { authorizationUrl, discover, redeemCode } from "./oidc";
import {
  jwks,
  machineTokenHash,
  mintTicket,
  mintWebhookRouteTicket,
  type RemoteRole,
  WEBHOOK_ROUTE_ID_PATTERN,
  WEBHOOK_ROUTES_LIMIT,
  type WebhookRoute,
} from "./tickets";

/** A value that a JSON body can hold. Bodies come from `JSON.parse`, so every field is one of these. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object body. Response and request bodies are small; each route reads its own fields. */
type Json = { [key: string]: JsonValue };

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
      if (method === "GET" && path === "/health/ready") return healthReady(db);
      if (method === "GET" && path === "/.well-known/jwks.json") return json(jwks(db));

      // ── Human auth (Authelia OIDC) ──────────────────────────────────────
      if (method === "POST" && path === "/v1/auth/email/start") return await emailStart(config, db, request);
      if (method === "POST" && path === "/v1/auth/company/start") return await companyStart(config, db, request);
      if (method === "GET" && path === "/v1/auth/company/callback") return await companyCallback(config, db, url);
      if (method === "POST" && path === "/v1/auth/company/exchange") return await companyExchange(config, db, request);
      if (method === "POST" && path === "/v1/auth/logout") return logout(db, request);
      if (method === "GET" && path === "/v1/me") return me(db, request);
      if (method === "PATCH" && path === "/v1/me/profile") return await updateProfile(db, request);
      if (method === "PUT" && path === "/v1/me/analytics") return await updateAnalytics(db, request);
      if (method === "PUT" && path === "/v1/me/chat-color") return await updateChatColor(db, request);
      if (method === "GET" && path === "/v1/mobile/features") return mobileFeatures(url);

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
        if (method === "DELETE" && devicesMatch)
          return revokeMobileDevice(db, decodeURIComponent(devicesMatch[1]), request);
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
      if (method === "POST" && path === "/v2/remote/webhook-route/validate")
        return await validateWebhookRoute(config, db, request);

      let m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/ticket$/u);
      if (method === "POST" && m) return await hostTicket(config, db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/key-handover$/u);
      if (method === "POST" && m) return await keyHandover(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/webhook-routes$/u);
      if (method === "POST" && m) return await registerWebhookRoute(db, decodeURIComponent(m[1]), request);
      if (method === "DELETE" && m) return await revokeWebhookRoute(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/webhook-route$/u);
      if (method === "POST" && m) return await webhookRouteTicket(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/members\/$/u);
      if (method === "GET" && m) return listMembers(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/hosts\/([^/]+)\/invites$/u);
      if (method === "GET" && m) return listInvites(db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/sessions\/([^/]+)\/ticket$/u);
      if (method === "POST" && m) return await sessionTicket(config, db, decodeURIComponent(m[1]), request);
      m = path.match(/^\/v2\/remote\/sessions\/([^/]+)\/end$/u);
      if (method === "POST" && m) return endSession(db, decodeURIComponent(m[1]), request);

      return apiError(404, "not_found", `No route for ${method} ${path}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "body_too_large") return apiError(413, "body_too_large", "The request body is too large.");
      if (message === "invalid_json") return apiError(400, "invalid_json", "The request body is not valid JSON.");
      console.error(`${method} ${path}: ${message}`);
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

/** The largest body that this service reads. Every route takes a few short fields. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Reads the body as text and stops at `limit` bytes. A request without a `Content-Length`
 * header is read through the stream, so a chunked body cannot grow without a bound.
 */
async function readText(request: Request, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error("body_too_large");
  const body = request.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function readJson(request: Request): Promise<Json> {
  let value: unknown;
  try {
    value = JSON.parse(await readText(request));
  } catch (error) {
    if (error instanceof Error && error.message === "body_too_large") throw error;
    throw new Error("invalid_json");
  }
  // The body came from `JSON.parse`, so a plain object already holds only JSON values.
  if (!isJsonObject(value)) throw new Error("invalid_json");
  return value;
}

function isJsonObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bearer(request: Request): string | null {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/u);
  return match ? match[1].trim() : null;
}

/**
 * Behind Caddy, the client address arrives in `X-Forwarded-For`. A proxy appends the address
 * that it saw, so the last entry is the one that the trust boundary added; a client can write
 * the entries before it. This service is only reachable through the proxy or the tailnet admin.
 */
function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (!forwarded) return "unknown";
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.at(-1) ?? "unknown";
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

/** Reads the user that a statement in the same request has just written. Never null in a working database. */
function requireUser(db: Db, id: string): User {
  const user = loadUser(db, id);
  if (!user) throw new Error("user_missing_after_write");
  return user;
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
    .query<User, [string]>(
      "SELECT id, email, name, avatar_url, analytics_enabled, chat_color FROM users WHERE email = ?",
    )
    .get(normalized);
  if (existing) return existing;
  const now = nowSeconds();
  const id = `user_${newId()}`;
  db.raw
    .query("INSERT INTO users (id, email, name, created_at, updated_at, analytics_enabled) VALUES (?, ?, ?, ?, ?, 0)")
    .run(id, normalized, name, now, now);
  return requireUser(db, id);
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
  if (
    !COMPANY_SIGN_IN_RETURN.test(returnTo) ||
    !TOKEN_PATTERN.test(clientState) ||
    !TOKEN_PATTERN.test(clientChallenge)
  ) {
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
    .run(
      hash(state),
      connection.issuer,
      connection.client_id,
      connection.client_secret,
      verifier,
      nonce,
      returnTo,
      clientState,
      clientChallenge,
      email,
      now,
      now + 600,
    );

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
      {
        issuer: string;
        client_id: string;
        client_secret: string;
        verifier: string;
        nonce: string;
        return_to: string;
        client_state: string;
        client_challenge: string;
      },
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
      .query(
        "INSERT INTO company_codes (code_hash, user_id, client_challenge, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
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
  return json({ sessionToken: token, user: toAuthUser(requireUser(db, row.user_id)) });
}

function logout(db: Db, request: Request): Response {
  const token = bearer(request);
  if (token)
    db.raw.query("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").run(nowSeconds(), hash(token));
  return new Response(null, { status: 204 });
}

function me(db: Db, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  return json(toAuthUser(user));
}

/** Readiness for an orchestrator: the process answers and the database reads. */
function healthReady(db: Db): Response {
  try {
    db.raw.query("SELECT 1 AS ok").get();
    return json({ status: "ok" });
  } catch {
    return json({ status: "unavailable" }, 503);
  }
}

/** The limits of `INPUT_LIMITS` in the clients: 3 to 20 visible characters, 120 code units. */
const PROFILE_NAME_MIN = 3;
const PROFILE_NAME_MAX = 20;
const PROFILE_NAME_MAX_UNITS = 120;
const PROFILE_NAME_UNSAFE = /[\p{Cc}\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u;
const CHAT_COLOR_PATTERN = /^#[0-9a-f]{6}$/u;

/**
 * The display name in a `PATCH /v1/me/profile` body, as the clients normalize it: outer space
 * removed, each run of inner space one space. Null when the name breaks a client rule.
 */
function normalizeProfileName(value: string): string | null {
  const name = value.trim().replace(/\s+/gu, " ");
  if (name.length > PROFILE_NAME_MAX_UNITS || PROFILE_NAME_UNSAFE.test(name)) return null;
  const length =
    typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(name)].length
      : [...name].length;
  return length >= PROFILE_NAME_MIN && length <= PROFILE_NAME_MAX ? name : null;
}

/** The client sends at most 20 profile changes in 15 minutes. */
function profileChangeAllowed(db: Db, userId: string): boolean {
  return rateLimit(db, `profile:${userId}`, 20, 900);
}

/** Saves the display name that the desktop app and the mobile app edit. */
async function updateProfile(db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const name = typeof body.name === "string" ? normalizeProfileName(body.name) : null;
  if (!name) return apiError(400, "invalid_profile_name", "Enter a valid display name.");
  if (!profileChangeAllowed(db, user.id)) {
    return apiError(429, "rate_limited", "Too many changes. Try again later.");
  }
  db.raw.query("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(name, nowSeconds(), user.id);
  return json(toAuthUser(requireUser(db, user.id)));
}

/**
 * Saves the analytics answer of the account. The desktop app and the mobile app follow this
 * answer on every device: `true` identifies their events with the account, `false` uses the
 * install ID of each device. The last write wins; a client sends only a choice that the account
 * does not have yet, so this is normally the newest choice.
 */
async function updateAnalytics(db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const ageMs = body.ageMs === undefined ? 0 : body.ageMs;
  if (typeof body.enabled !== "boolean" || typeof ageMs !== "number" || !Number.isSafeInteger(ageMs) || ageMs < 0) {
    return apiError(400, "invalid_analytics_preference", "The analytics setting is not valid.");
  }
  if (!profileChangeAllowed(db, user.id)) {
    return apiError(429, "rate_limited", "Too many changes. Try again later.");
  }
  db.raw
    .query("UPDATE users SET analytics_enabled = ?, updated_at = ? WHERE id = ?")
    .run(body.enabled ? 1 : 0, nowSeconds(), user.id);
  return json(toAuthUser(requireUser(db, user.id)));
}

/** Saves the chat colour that a member's avatar uses. A null colour returns to the automatic hue. */
async function updateChatColor(db: Db, request: Request): Promise<Response> {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const body = await readJson(request);
  const value = body.chatColor;
  const color = value === null ? null : typeof value === "string" && CHAT_COLOR_PATTERN.test(value) ? value : undefined;
  if (color === undefined) return apiError(400, "invalid_chat_color", "The chat colour is not valid.");
  if (!profileChangeAllowed(db, user.id)) {
    return apiError(429, "rate_limited", "Too many changes. Try again later.");
  }
  db.raw.query("UPDATE users SET chat_color = ?, updated_at = ? WHERE id = ?").run(color, nowSeconds(), user.id);
  return json(toAuthUser(requireUser(db, user.id)));
}

/**
 * The mobile feature flags of one platform. The app gates the agent browser live view and the
 * hosted server plans on this answer, and reads it again at most once a minute. An older account
 * service that has no route leaves every feature off.
 *
 * The browser is on: it is a host capability (`browser-view`) and the account service is not in
 * its data path. The hosted server plans stay off: this deployment sells no servers.
 *
 * `latestVersion` is left out on purpose. A value would show an update header, and its link
 * opens the official OpenBot app in the store, which is not the app of this service.
 */
function mobileFeatures(url: URL): Response {
  const platform = url.searchParams.get("platform");
  const supported = platform === "android" || platform === "ios";
  return json({ features: { cloudServers: false, browser: supported } });
}

// ── server claims ─────────────────────────────────────────────────────────

async function createServerClaim(config: Config, db: Db, request: Request): Promise<Response> {
  if (!safeEqual(bearer(request) ?? "", config.serverClaimsAdminToken))
    return apiError(401, "unauthorized", "Bad admin token.");
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
  return json({ sessionToken: token, user: toAuthUser(requireUser(db, row.user_id)) });
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

/** Reads the host that a statement in the same request has just written. Never null in a working database. */
function requireHost(db: Db, hostId: string): HostRow {
  const host = loadHost(db, hostId);
  if (!host) throw new Error("host_missing_after_write");
  return host;
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
    host = requireHost(db, hostId);
  } else {
    const membership = membershipFor(db, hostId, user.id);
    if (!membership || membership.role !== "owner") return apiError(403, "forbidden", "Only the owner may register.");
    db.raw
      .query("UPDATE remote_hosts SET name = ?, device_public_key = ?, updated_at = ? WHERE host_id = ?")
      .run(name, devicePublicKey, now, hostId);
    host = requireHost(db, hostId);
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
  const membership = membershipFor(db, hostId, user.id);
  if (!membership) throw new Error("membership_missing_after_write");
  return json({
    hostId,
    name,
    membershipId: membership.membership_id,
    authEpoch: host.auth_epoch,
    machineToken,
  });
}

/**
 * This service has no invitations: hosts join with a server claim. The desktop Members screen
 * reads this route when it opens, so answer the empty list with the same access check.
 */
function listInvites(db: Db, hostId: string, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "Sign in is required.");
  const requester = membershipFor(db, hostId, user.id);
  if (!requester || requester.status !== "active") return apiError(403, "forbidden", "No access to this host.");
  return json({ invites: [] });
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
      {
        host_id: string;
        name: string;
        device_public_key: string | null;
        auth_epoch: number;
        membership_id: string;
        role: RemoteRole;
      },
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
  const expiresAt = PERSISTENT_SESSION_EXPIRES_AT_SECONDS;
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
  const handover = isJsonObject(body.handover) ? body.handover : undefined;
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
      typeof handover.previousPublicKey === "string" ? handover.previousPublicKey : (host.device_public_key ?? ""),
      handover.publicKey,
      typeof handover.previousSignature === "string" ? handover.previousSignature : "",
      typeof handover.signature === "string" ? handover.signature : "",
      now,
    );
  db.raw
    .query("UPDATE remote_hosts SET device_public_key = ?, updated_at = ? WHERE host_id = ?")
    .run(handover.publicKey, now, hostId);
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
  const expiresAt = PERSISTENT_SESSION_EXPIRES_AT_SECONDS;
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
    .query<
      { host_id: string; user_id: string; membership_id: string; expires_at: number; ended_at: number | null },
      [string]
    >("SELECT host_id, user_id, membership_id, expires_at, ended_at FROM remote_sessions WHERE session_id = ?")
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
  const raw = await readText(request, 8 * 1024);
  const timestamp = request.headers.get("OpenBot-Timestamp") ?? "";
  const signature = request.headers.get("OpenBot-Signature") ?? "";
  const expected = createHmac("sha256", config.authWebhookSecret).update(`${timestamp}.${raw}`).digest("base64url");
  if (!safeEqual(signature, expected)) return apiError(401, "invalid_signature", "Bad service signature.");
  let claims: unknown;
  try {
    claims = JSON.parse(raw);
  } catch {
    return apiError(400, "invalid_resume_claims", "Bad resume claims.");
  }
  if (!isJsonObject(claims)) return apiError(400, "invalid_resume_claims", "Bad resume claims.");
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

// ── Generic webhook routes ────────────────────────────────────────────────
//
// The host makes an opaque route ID for each webhook routine and registers it here; Signal serves
// `<signal>/v1/webhooks/<routeId>` and forwards each request over the host's ingress socket. This
// service stores only who owns a route ID. The HMAC secret and the events stay on the host.
// Revocation reaches Signal when the host reconnects its ingress socket (it does after a delete)
// or when the 5-minute route ticket expires; this service sends no auth events to Signal.

/** The host proves its machine token, as for a host ticket. */
async function authenticateHost(
  db: Db,
  hostId: string,
  request: Request,
): Promise<{ host: HostRow; body: Json } | Response> {
  const body = await readJson(request);
  const machineToken = typeof body.machineToken === "string" ? body.machineToken : "";
  const host = loadHost(db, hostId);
  if (
    !host?.machine_token_hash ||
    !machineToken ||
    !safeEqual(host.machine_token_hash, machineTokenHash(machineToken))
  ) {
    return apiError(401, "host_unauthorized", "The host credential is invalid.");
  }
  return { host, body };
}

function webhookRouteId(body: Json): string | null {
  const routeId = body.routeId;
  return typeof routeId === "string" && WEBHOOK_ROUTE_ID_PATTERN.test(routeId) ? routeId : null;
}

async function registerWebhookRoute(db: Db, hostId: string, request: Request): Promise<Response> {
  const auth = await authenticateHost(db, hostId, request);
  if (auth instanceof Response) return auth;
  const routeId = webhookRouteId(auth.body);
  if (!routeId) return apiError(400, "invalid_webhook_route", "The webhook route is invalid.");
  const accountId = auth.host.owner_user_id;
  const inserted = db.raw
    .query(
      `INSERT INTO webhook_routes (route_id, host_id, account_id, connected_at)
       SELECT ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM webhook_routes WHERE host_id = ? AND revoked_at IS NULL) < ?
       ON CONFLICT(route_id) DO NOTHING`,
    )
    .run(routeId, hostId, accountId, Date.now(), hostId, WEBHOOK_ROUTES_LIMIT);
  if (inserted.changes) return json({ routeId }, 201);
  const existing = db.raw
    .query<{ host_id: string; account_id: string; revoked_at: number | null }, [string]>(
      "SELECT host_id, account_id, revoked_at FROM webhook_routes WHERE route_id = ?",
    )
    .get(routeId);
  if (existing) {
    // A route ID is never freed: senders may still post to an old URL. The same live owner may
    // register it again (the host retries); anyone else gets a conflict.
    if (existing.revoked_at !== null || existing.host_id !== hostId || existing.account_id !== accountId) {
      return apiError(409, "webhook_route_conflict", "The webhook route is already registered to another host.");
    }
    return json({ routeId }, 201);
  }
  return apiError(409, "webhook_route_limit", "This host has reached its webhook route limit.");
}

async function revokeWebhookRoute(db: Db, hostId: string, request: Request): Promise<Response> {
  const auth = await authenticateHost(db, hostId, request);
  if (auth instanceof Response) return auth;
  const routeId = webhookRouteId(auth.body);
  if (!routeId) return apiError(400, "invalid_webhook_route", "The webhook route is invalid.");
  // The row stays as a tombstone so that no other host can take the same public URL.
  db.raw
    .query("UPDATE webhook_routes SET revoked_at = ? WHERE route_id = ? AND host_id = ? AND revoked_at IS NULL")
    .run(Date.now(), routeId, hostId);
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/** The route ticket that the host's Signal ingress socket presents for its webhook routes. */
async function webhookRouteTicket(db: Db, hostId: string, request: Request): Promise<Response> {
  const auth = await authenticateHost(db, hostId, request);
  if (auth instanceof Response) return auth;
  const rows = db.raw
    .query<{ route_id: string; connected_at: number }, [string, string, number]>(
      `SELECT route_id, connected_at FROM webhook_routes
       WHERE host_id = ? AND account_id = ? AND revoked_at IS NULL
       ORDER BY connected_at DESC LIMIT ?`,
    )
    .all(hostId, auth.host.owner_user_id, WEBHOOK_ROUTES_LIMIT);
  const routes: WebhookRoute[] = rows.map((row) => ({ id: row.route_id, linkedAt: row.connected_at }));
  const ticket = await mintWebhookRouteTicket(db, hostId, routes);
  return json({ ticket, routes: routes.map((route) => route.id) });
}

/** The service signature that Signal puts on its requests, with a replay window. */
const SERVICE_SIGNATURE_MAX_SKEW_SECONDS = 5 * 60;
function verifyServiceSignature(config: Config, request: Request, raw: string): boolean {
  const timestamp = request.headers.get("OpenBot-Timestamp") ?? "";
  const signature = request.headers.get("OpenBot-Signature") ?? "";
  if (!/^[0-9]{1,12}$/u.test(timestamp)) return false;
  if (Math.abs(nowSeconds() - Number(timestamp)) > SERVICE_SIGNATURE_MAX_SKEW_SECONDS) return false;
  const expected = createHmac("sha256", config.authWebhookSecret).update(`${timestamp}.${raw}`).digest("base64url");
  return safeEqual(signature, expected);
}

/**
 * Signal asks this when an ingress socket presents a route ticket after Signal started: the route
 * IDs that are still linked, live, to the same host, owner and link time.
 */
async function validateWebhookRoute(config: Config, db: Db, request: Request): Promise<Response> {
  const raw = await readText(request);
  if (!verifyServiceSignature(config, request, raw)) {
    return apiError(401, "invalid_signature", "The Remote service signature is invalid.");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return apiError(400, "invalid_webhook_route", "The webhook route is invalid.");
  }
  if (!isJsonObject(body)) return apiError(400, "invalid_webhook_route", "The webhook route is invalid.");
  const hostId =
    typeof body.hostId === "string" && body.hostId.length >= 1 && body.hostId.length <= 256 ? body.hostId : "";
  const routes = parseWebhookRoutes(body.routes);
  if (!hostId || !routes) return apiError(400, "invalid_webhook_route", "The webhook route is invalid.");
  if (routes.length === 0) return json({ routes: [] });
  const rows = db.raw
    .query<{ route_id: string; connected_at: number }, [string]>(
      `SELECT route.route_id, route.connected_at FROM webhook_routes route
       JOIN remote_hosts host ON host.host_id = route.host_id AND host.owner_user_id = route.account_id
       WHERE route.host_id = ? AND route.revoked_at IS NULL`,
    )
    .all(hostId);
  const linked = new Map(rows.map((row) => [row.route_id, row.connected_at]));
  return json({
    routes: routes.filter((route) => linked.get(route.id) === route.linkedAt).map((route) => route.id),
  });
}

/** The `routes` of a route ticket as Signal sends them, or null when one entry is malformed. */
function parseWebhookRoutes(value: JsonValue | undefined): WebhookRoute[] | null {
  if (!Array.isArray(value) || value.length > WEBHOOK_ROUTES_LIMIT) return null;
  const routes: WebhookRoute[] = [];
  for (const entry of value) {
    if (!isJsonObject(entry)) return null;
    const { id, linkedAt } = entry;
    if (typeof id !== "string" || id.length < 1 || id.length > 128) return null;
    if (typeof linkedAt !== "number" || !Number.isSafeInteger(linkedAt) || linkedAt < 0) return null;
    routes.push({ id, linkedAt });
  }
  return routes;
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
  if (!isJsonObject(value)) return null;
  if (typeof value.hostId !== "string") return null;
  const row = loadHost(db, value.hostId);
  if (!row) return null;
  const membership = membershipFor(db, value.hostId, userId);
  if (!membership || membership.status !== "active") return null;
  return { hostId: row.host_id, fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : "" };
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
  if (!hostId || !userId)
    return apiError(401, "invalid_mobile_ticket", "The Mobile Connect code is invalid or expired.");
  const token = newToken(32);
  db.raw
    .query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at, created_at, last_used_at, kind, device_id, device_name, platform, via, host_id)
       VALUES (?, ?, ?, ?, ?, ?, 'mobile', ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      userId,
      hash(token),
      now + config.authSessionTtlSeconds,
      now,
      now,
      deviceId,
      deviceName,
      platform,
      via,
      hostId,
    );
  return json({ sessionToken: token, user: toAuthUser(requireUser(db, userId)), host: { hostId, fingerprint } });
}

function mobileSession(db: Db, request: Request): Response {
  const user = findUser(db, bearer(request));
  if (!user) return apiError(401, "unauthorized", "The mobile session is invalid.");
  return json(toAuthUser(user));
}

function logoutMobile(db: Db, request: Request): Response {
  const token = bearer(request);
  if (token)
    db.raw.query("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ?").run(nowSeconds(), hash(token));
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
