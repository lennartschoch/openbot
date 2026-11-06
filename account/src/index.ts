// Entrypoint. Ensures a ticket-signing key exists, then serves.

import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { activeKey } from "./tickets";

const config = loadConfig();
const db = openDb(config.databasePath);
await activeKey(db);

const fetch = createApp(config, db);
const server = Bun.serve({ hostname: config.host, port: config.port, fetch });

console.log(`openbot-account listening on http://${server.hostname}:${server.port}`);
console.log(`public url: ${config.publicUrl}`);
console.log(`signal url: ${config.signalUrl}`);
console.log(`oidc: ${config.oidcIssuer || "(disabled)"} domain=${config.oidcDomain || "-"}`);
