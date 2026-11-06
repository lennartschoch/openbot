// Bootstrap: create the signing key, register the Authelia company connection, and
// optionally mint a server claim for the host's first login.
//
//   OPENBOT_ACCOUNT_PUBLIC_URL=https://account.example.com \
//   OPENBOT_AUTH_WEBHOOK_SECRET=... OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN=... \
//   OPENBOT_SIGNAL_URL=wss://signal.example.com/v1/signal \
//   OPENBOT_OIDC_ISSUER=https://auth.example.com OPENBOT_OIDC_CLIENT_ID=openbot-account \
//   OPENBOT_OIDC_CLIENT_SECRET=... OPENBOT_OIDC_DOMAIN=example.com \
//   OPENBOT_BOOTSTRAP_EMAIL=you@example.com \
//   bun run src/seed.ts

import { loadConfig } from "./config";
import { hash, newToken, nowSeconds, openDb } from "./db";
import { activeKey, jwks } from "./tickets";

const config = loadConfig();
const db = openDb(config.databasePath);
await activeKey(db);

const now = nowSeconds();
if (config.oidcIssuer && config.oidcClientId) {
  // Single-tenant: with no configured domain, key the connection by `*` so
  // company/start (which selects the single enabled row) finds it.
  const domain = config.oidcDomain || "*";
  db.raw
    .query(
      `INSERT INTO company_connections (domain, issuer, client_id, client_secret, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id,
         client_secret = excluded.client_secret, enabled = 1, updated_at = excluded.updated_at`,
    )
    .run(domain, config.oidcIssuer, config.oidcClientId, config.oidcClientSecret, now, now);
  console.log(`company sign-in: ${config.oidcDomain || "(any domain)"} via ${config.oidcIssuer} (client ${config.oidcClientId})`);
}

const email = process.env.OPENBOT_BOOTSTRAP_EMAIL?.trim().toLowerCase();
if (email) {
  let user = db.raw.query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!user) {
    const id = `user_${newToken(16)}`;
    db.raw
      .query("INSERT INTO users (id, email, name, created_at, updated_at, analytics_enabled) VALUES (?, ?, NULL, ?, ?, 0)")
      .run(id, email, now, now);
    user = { id };
  }
  const claim = newToken(32);
  const expiresAt = now + 900;
  db.raw
    .query("INSERT INTO server_claims (claim_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hash(claim), user.id, now, expiresAt);
  console.log(`\nserver claim for ${email} (valid 15 min):\n  ${claim}\n`);
  console.log(`run on the server:  sudo openbot login --claim --name my-host`);
}

console.log(`\nJWKS:`);
console.log(JSON.stringify(jwks(db), null, 2));
