// Configuration for the thin OpenBot account service.
//
// Everything is read once at startup. The service is single-tenant by design: one human,
// one host, a handful of clients. See ../PROTOCOL.md for the protocol contract.

export interface Config {
  /** Public base URL of this service, e.g. https://openbot-account-api.lennart.codes. Used for the OIDC redirect URI. */
  publicUrl: string;
  /** Where to listen. */
  host: string;
  port: number;
  /** SQLite file. */
  databasePath: string;
  /** Shared secret with Signal for `/v2/remote/resume/validate` (HMAC). Matches Signal's REMOTE_AUTH_WEBHOOK_SECRET. */
  authWebhookSecret: string;
  /** Operator token for the server-claim admin endpoint. */
  serverClaimsAdminToken: string;
  /** The `wss://` Signal URL handed to peers in a ticket. */
  signalUrl: string;
  /** Authelia OIDC issuer, e.g. https://auth.lennart.codes. Empty disables company sign-in. */
  oidcIssuer: string;
  /** OIDC client credentials registered in Authelia for this service. */
  oidcClientId: string;
  oidcClientSecret: string;
  /** The email domain that company sign-in accepts, e.g. lennart.codes. Empty = any domain. */
  oidcDomain: string;
  /** Comma-separated emails allowed to sign in. Empty = any user the issuer authenticates. */
  allowedEmails: string[];
  /** Ticket/session lifetimes, seconds. */
  ticketTtlSeconds: number;
  sessionTtlSeconds: number;
  /** Session lifetime for a human login (desktop/phone), seconds. */
  authSessionTtlSeconds: number;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

export function loadConfig(): Config {
  const publicUrl = required("OPENBOT_ACCOUNT_PUBLIC_URL").replace(/\/+$/, "");
  if (!publicUrl.startsWith("https://") && !publicUrl.startsWith("http://127.0.0.1")) {
    throw new Error("OPENBOT_ACCOUNT_PUBLIC_URL must be https (or http://127.0.0.1 for local tests).");
  }
  const oidcIssuer = process.env.OPENBOT_OIDC_ISSUER?.trim() ?? "";
  return {
    publicUrl,
    host: process.env.OPENBOT_ACCOUNT_HOST?.trim() || "0.0.0.0",
    port: intEnv("OPENBOT_ACCOUNT_PORT", 3100),
    databasePath: process.env.OPENBOT_ACCOUNT_DB?.trim() || "account.sqlite",
    authWebhookSecret: required("OPENBOT_AUTH_WEBHOOK_SECRET"),
    serverClaimsAdminToken: required("OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN"),
    signalUrl: required("OPENBOT_SIGNAL_URL"),
    oidcIssuer,
    oidcClientId: process.env.OPENBOT_OIDC_CLIENT_ID?.trim() ?? "",
    oidcClientSecret: process.env.OPENBOT_OIDC_CLIENT_SECRET?.trim() ?? "",
    oidcDomain: (process.env.OPENBOT_OIDC_DOMAIN?.trim() ?? "").toLowerCase(),
    allowedEmails: (process.env.OPENBOT_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    ticketTtlSeconds: intEnv("OPENBOT_TICKET_TTL_SECONDS", 300),
    sessionTtlSeconds: intEnv("OPENBOT_SESSION_TTL_SECONDS", 3600),
    authSessionTtlSeconds: intEnv("OPENBOT_AUTH_SESSION_TTL_SECONDS", 60 * 60 * 24 * 30),
  };
}
