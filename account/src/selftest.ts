// End-to-end self-test of the core protocol (no Authelia needed):
// admin claim -> redeem -> register host -> list -> host ticket -> verify with JWKS
// -> start session -> session ticket -> resume validate.
//
//   bun run src/selftest.ts

import { createHmac } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { activeKey, REMOTE_TICKET_AUDIENCE } from "./tickets";

process.env.OPENBOT_ACCOUNT_PUBLIC_URL = "https://api.example.test";
process.env.OPENBOT_AUTH_WEBHOOK_SECRET = "test-webhook-secret-at-least-32-bytes-long";
process.env.OPENBOT_SERVER_CLAIMS_ADMIN_TOKEN = "test-admin-token";
process.env.OPENBOT_SIGNAL_URL = "wss://signal.example.test/v1/signal";
process.env.OPENBOT_ACCOUNT_DB = "/tmp/openbot-account-selftest.sqlite";

import { rmSync } from "node:fs";
rmSync("/tmp/openbot-account-selftest.sqlite", { force: true });
rmSync("/tmp/openbot-account-selftest.sqlite-wal", { force: true });
rmSync("/tmp/openbot-account-selftest.sqlite-shm", { force: true });

const config = loadConfig();
const db = openDb(config.databasePath);
await activeKey(db);
const app = createApp(config, db);

let requests = 0;
async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  requests += 1;
  const response = await app(
    new Request(`http://local${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

// 1. Admin makes a claim for the owner.
const claimResponse = await call("POST", "/v2/admin/server-claims", { email: "you@example.test" }, config.serverClaimsAdminToken);
assert(claimResponse.status === 200 && typeof claimResponse.json.claim === "string", "admin mints a server claim");
const claim: string = claimResponse.json.claim;

// 2. The host redeems it for a session.
const redeem = await call("POST", "/v2/server-claims/redeem", { claim });
assert(redeem.status === 200 && redeem.json.sessionToken, "server claim redeems to a session");
const sessionToken: string = redeem.json.sessionToken;

// 3. Register the host.
const register = await call(
  "POST",
  "/v2/remote/hosts/register",
  { hostId: "agent-machine", name: "agent-machine", ownerMembershipId: "owner-1", devicePublicKey: "pk-1", rotateCredential: true },
  sessionToken,
);
assert(register.status === 200 && register.json.machineToken, "host registers and gets a machine token");
assert(register.json.authEpoch === 1 && register.json.membershipId === "owner-1", "registration returns epoch 1 + owner membership");
const machineToken: string = register.json.machineToken;

// 4. List hosts.
const list = await call("GET", "/v2/remote/hosts/", undefined, sessionToken);
assert(list.status === 200 && list.json.hosts.length === 1 && list.json.hosts[0].hostId === "agent-machine", "host list shows the host");

// 5. Host ticket.
const hostTicket = await call("POST", "/v2/remote/hosts/agent-machine/ticket", { machineToken, signalHome: false });
assert(hostTicket.status === 200 && hostTicket.json.ticket && hostTicket.json.signalUrl === config.signalUrl, "host ticket issued");

// 6. Verify the ticket against the published JWKS, exactly as Signal and the app do.
const jwksResponse = await call("GET", "/.well-known/jwks.json");
const keySet = createLocalJWKSet(jwksResponse.json);
const verified = await jwtVerify(hostTicket.json.ticket, keySet, { audience: REMOTE_TICKET_AUDIENCE, algorithms: ["ES256"] });
assert(verified.payload.hostId === "agent-machine" && verified.payload.role === "host", "host ticket verifies with JWKS (ES256)");
assert(verified.payload.protocolMinimum === 2 && verified.payload.protocolMaximum === 2, "ticket protocol range is [2,2]");

// 7. Client session + ticket.
const started = await call("POST", "/v2/remote/sessions/", { hostId: "agent-machine" }, sessionToken);
assert(started.status === 201 && started.json.sessionId, "client session starts");
const clientTicket = await call(
  "POST",
  `/v2/remote/sessions/${started.json.sessionId}/ticket`,
  { clientPublicKey: "client-pk" },
  sessionToken,
);
assert(clientTicket.status === 200 && clientTicket.json.ticket, "client session ticket issued");
const verifiedClient = await jwtVerify(clientTicket.json.ticket, keySet, { audience: REMOTE_TICKET_AUDIENCE, algorithms: ["ES256"] });
assert(verifiedClient.payload.role === "owner" && verifiedClient.payload.clientPublicKey === "client-pk", "client ticket binds the client key");

// 8. Resume validation, signed exactly as Signal signs it.
const resumeClaims = {
  sessionId: verifiedClient.payload.sessionId,
  hostId: "agent-machine",
  userId: verifiedClient.payload.userId,
  membershipId: "owner-1",
  role: "owner",
  authEpoch: 1,
  sessionExpiresAt: verifiedClient.payload.sessionExpiresAt,
};
const resumeBody = JSON.stringify(resumeClaims);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", config.authWebhookSecret).update(`${timestamp}.${resumeBody}`).digest("base64url");
const resume = await app(
  new Request("http://local/v2/remote/resume/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "OpenBot-Timestamp": timestamp, "OpenBot-Signature": signature },
    body: resumeBody,
  }),
);
const resumeJson = (await resume.json()) as { valid: boolean };
assert(resume.status === 200 && resumeJson.valid === true, "resume validate accepts an active session");

// 9. A tampered signature is refused.
const badResume = await app(
  new Request("http://local/v2/remote/resume/validate", {
    method: "POST",
    headers: { "OpenBot-Timestamp": timestamp, "OpenBot-Signature": "nope" },
    body: resumeBody,
  }),
);
assert(badResume.status === 401, "resume validate refuses a bad signature");

// 10. Company sign-in is off by default here -> email/start says disabled.
const emailStart = await call("POST", "/v1/auth/email/start", { email: "you@example.test" });
assert(emailStart.status === 400, "email sign-in is disabled when no OIDC connection is configured");

// 11. Mobile Connect: the host shows a QR ticket; the phone redeems it once.
const mobileTicket = await call(
  "POST",
  "/v1/mobile-auth/ticket",
  { host: { hostId: "agent-machine", fingerprint: "fp" } },
  sessionToken,
);
assert(mobileTicket.status === 200 && mobileTicket.json.ticket, "host creates a Mobile Connect ticket");
const redeemed = await call("POST", "/v1/mobile-auth/redeem", {
  ticket: mobileTicket.json.ticket,
  deviceId: "dev-1",
  deviceName: "Pixel",
  platform: "android",
});
assert(
  redeemed.status === 200 && redeemed.json.sessionToken && redeemed.json.host?.hostId === "agent-machine",
  "phone redeems the ticket and is bound to the host",
);
const mobileToken: string = redeemed.json.sessionToken;
const mobileMe = await call("GET", "/v1/mobile-auth/session", undefined, mobileToken);
assert(mobileMe.status === 200 && mobileMe.json.id === redeemed.json.user.id, "mobile session is valid");
const devices = await call("GET", "/v1/mobile-auth/devices", undefined, sessionToken);
assert(
  devices.status === 200 && devices.json.devices.length === 1 && devices.json.devices[0].platform === "android",
  "the desktop lists the connected phone",
);
const reuse = await call("POST", "/v1/mobile-auth/redeem", {
  ticket: mobileTicket.json.ticket,
  deviceId: "dev-2",
  deviceName: "Other",
  platform: "ios",
});
assert(reuse.status === 401, "a one-time Mobile Connect ticket cannot be redeemed twice");

console.log(`\nAll ${requests} requests passed.`);
