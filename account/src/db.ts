// SQLite schema + small helpers. Bun's built-in SQLite, synchronous.

import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

export interface Db {
  raw: Database;
}

export function openDb(path: string): Db {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  ensureSessionColumns(db);
  return { raw: db };
}

/** Lowercase hex sha256 of a string. Tokens are stored as hashes, never plaintext. */
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function newId(): string {
  return randomBytes(16).toString("hex");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Fixed-window limiter, keyed by an opaque string (e.g. `company:start:<ip>`). */
export function rateLimit(db: Db, key: string, limit: number, windowSeconds: number): boolean {
  const now = nowSeconds();
  const windowStart = Math.floor(now / windowSeconds) * windowSeconds;
  const keyHash = hash(key);
  db.raw
    .query(
      `INSERT INTO auth_rate_limits (key_hash, window_start, attempts) VALUES (?, ?, 1)
       ON CONFLICT(key_hash, window_start) DO UPDATE SET attempts = attempts + 1`,
    )
    .run(keyHash, windowStart);
  const row = db.raw
    .query<{ attempts: number }, [string, number]>(
      "SELECT attempts FROM auth_rate_limits WHERE key_hash = ? AND window_start = ?",
    )
    .get(keyHash, windowStart);
  return (row?.attempts ?? 0) <= limit;
}

/** Drop rows that can no longer be used, so public traffic cannot grow the DB forever. */
export function prune(db: Db): void {
  const now = nowSeconds();
  db.raw.query("DELETE FROM company_flows WHERE expires_at <= ?").run(now);
  db.raw.query("DELETE FROM company_codes WHERE expires_at <= ?").run(now);
  db.raw.query("DELETE FROM server_claims WHERE expires_at <= ?").run(now);
  db.raw.query("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now);
  db.raw.query("DELETE FROM remote_sessions WHERE expires_at <= ?").run(now);
  db.raw.query("DELETE FROM auth_rate_limits WHERE window_start <= ?").run(now - 3600);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  analytics_enabled INTEGER,
  chat_color TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS identity_links (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, subject)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'desktop'
);
CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS remote_hosts (
  host_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  logo_key TEXT,
  device_public_key TEXT,
  machine_token_hash TEXT UNIQUE,
  auth_epoch INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_memberships (
  membership_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(host_id, user_id)
);

CREATE TABLE IF NOT EXISTS remote_sessions (
  session_id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL,
  client_public_key TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS remote_host_key_handovers (
  host_id TEXT NOT NULL REFERENCES remote_hosts(host_id) ON DELETE CASCADE,
  issued_at INTEGER NOT NULL,
  previous_public_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  previous_signature TEXT NOT NULL,
  signature TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (host_id, signature)
);

-- Ticket signing keys (ES256). The private JWK is sensitive; the row is the source of truth.
CREATE TABLE IF NOT EXISTS ticket_keys (
  kid TEXT PRIMARY KEY,
  private_jwk TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- Company (OIDC) sign-in connection, keyed by email domain. We seed a single row.
-- Not tied to a host: the desktop can sign in before any host exists.
CREATE TABLE IF NOT EXISTS company_connections (
  domain TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One in-flight OIDC login. verifier is OUR PKCE verifier for Authelia;
-- client_challenge is the desktop app's challenge, checked at exchange.
CREATE TABLE IF NOT EXISTS company_flows (
  state_hash TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT NOT NULL,
  client_state TEXT NOT NULL,
  client_challenge TEXT NOT NULL,
  login_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS company_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_challenge TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
);

CREATE TABLE IF NOT EXISTS server_claims (
  claim_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  PRIMARY KEY (key_hash, window_start)
);

-- Mobile Connect: a one-time ticket shown as a QR by the host.
CREATE TABLE IF NOT EXISTS mobile_tickets (
  claim_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER
);

-- A permanent Mobile Connect link, one per host; each use signs in a phone.
CREATE TABLE IF NOT EXISTS mobile_links (
  host_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
`;

/** Add a column to an existing table once, for schema growth without a migration tool. */
function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/** The mobile-session columns on `auth_sessions`, added after the first release. */
function ensureSessionColumns(db: Database): void {
  ensureColumn(db, "auth_sessions", "device_id", "device_id TEXT");
  ensureColumn(db, "auth_sessions", "device_name", "device_name TEXT");
  ensureColumn(db, "auth_sessions", "platform", "platform TEXT");
  ensureColumn(db, "auth_sessions", "via", "via TEXT");
  ensureColumn(db, "auth_sessions", "host_id", "host_id TEXT");
}
