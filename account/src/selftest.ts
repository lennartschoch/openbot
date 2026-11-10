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
import { activeKey, jwks, REMOTE_TICKET_AUDIENCE, WEBHOOK_ROUTE_AUDIENCE } from "./tickets";

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

/** A value that a service answer can hold, as `app.ts` defines it for its bodies. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

let requests = 0;
/** Sends one request and parses the answer body. Every route answers JSON, even an error. */
async function call<T extends JsonObject>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: T }> {
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
  return { status: response.status, json: JSON.parse(await response.text()) };
}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok: ${message}`);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 1. Admin makes a claim for the owner.
const claimResponse = await call<{ claim: string }>(
  "POST",
  "/v2/admin/server-claims",
  { email: "you@example.test" },
  config.serverClaimsAdminToken,
);
assert(claimResponse.status === 200 && typeof claimResponse.json.claim === "string", "admin mints a server claim");
const claim: string = claimResponse.json.claim;

// 2. The host redeems it for a session.
const redeem = await call<{ sessionToken: string }>("POST", "/v2/server-claims/redeem", { claim });
assert(redeem.status === 200 && redeem.json.sessionToken, "server claim redeems to a session");
const sessionToken: string = redeem.json.sessionToken;

// 3. Register the host.
const register = await call<{
  machineToken: string;
  authEpoch: number;
  membershipId: string;
}>(
  "POST",
  "/v2/remote/hosts/register",
  { hostId: "host-1", name: "host-1", ownerMembershipId: "owner-1", devicePublicKey: "pk-1", rotateCredential: true },
  sessionToken,
);
assert(register.status === 200 && register.json.machineToken, "host registers and gets a machine token");
assert(
  register.json.authEpoch === 1 && register.json.membershipId === "owner-1",
  "registration returns epoch 1 + owner membership",
);
const machineToken: string = register.json.machineToken;

// 4. List hosts.
const list = await call<{ hosts: { hostId: string }[] }>("GET", "/v2/remote/hosts/", undefined, sessionToken);
assert(
  list.status === 200 && list.json.hosts.length === 1 && list.json.hosts[0].hostId === "host-1",
  "host list shows the host",
);

// 4b. The Members screen reads the invite list; this service has none.
const invites = await call<{ invites: JsonValue[] }>("GET", "/v2/remote/hosts/host-1/invites", undefined, sessionToken);
assert(invites.status === 200 && invites.json.invites.length === 0, "invite list answers empty");

// 5. Host ticket.
const hostTicket = await call<{ ticket: string; signalUrl: string }>("POST", "/v2/remote/hosts/host-1/ticket", {
  machineToken,
  signalHome: false,
});
assert(
  hostTicket.status === 200 && hostTicket.json.ticket && hostTicket.json.signalUrl === config.signalUrl,
  "host ticket issued",
);

// 6. Verify the ticket against the published JWKS, exactly as Signal and the app do.
const jwksResponse = await call<JsonObject>("GET", "/.well-known/jwks.json");
const publishedKeys = jwks(db);
assert(
  jwksResponse.status === 200 && JSON.stringify(jwksResponse.json) === JSON.stringify(publishedKeys),
  "the JWKS route publishes the active keys",
);
const keySet = createLocalJWKSet(publishedKeys);
const verified = await jwtVerify(hostTicket.json.ticket, keySet, {
  audience: REMOTE_TICKET_AUDIENCE,
  algorithms: ["ES256"],
});
assert(
  verified.payload.hostId === "host-1" && verified.payload.role === "host",
  "host ticket verifies with JWKS (ES256)",
);
assert(
  verified.payload.protocolMinimum === 2 && verified.payload.protocolMaximum === 2,
  "ticket protocol range is [2,2]",
);

// 7. Client session + ticket.
const started = await call<{ sessionId: string }>("POST", "/v2/remote/sessions/", { hostId: "host-1" }, sessionToken);
assert(started.status === 201 && started.json.sessionId, "client session starts");
const clientTicket = await call<{ ticket: string }>(
  "POST",
  `/v2/remote/sessions/${started.json.sessionId}/ticket`,
  { clientPublicKey: "client-pk" },
  sessionToken,
);
assert(clientTicket.status === 200 && clientTicket.json.ticket, "client session ticket issued");
const verifiedClient = await jwtVerify(clientTicket.json.ticket, keySet, {
  audience: REMOTE_TICKET_AUDIENCE,
  algorithms: ["ES256"],
});
assert(
  verifiedClient.payload.role === "owner" && verifiedClient.payload.clientPublicKey === "client-pk",
  "client ticket binds the client key",
);

// 8. Resume validation, signed exactly as Signal signs it.
const resumeClaims = {
  sessionId: verifiedClient.payload.sessionId,
  hostId: "host-1",
  userId: verifiedClient.payload.userId,
  membershipId: "owner-1",
  role: "owner",
  authEpoch: 1,
  sessionExpiresAt: verifiedClient.payload.sessionExpiresAt,
};
const resumeBody = JSON.stringify(resumeClaims);
const timestamp = Math.floor(Date.now() / 1000).toString();
const signature = createHmac("sha256", config.authWebhookSecret)
  .update(`${timestamp}.${resumeBody}`)
  .digest("base64url");
const resume = await app(
  new Request("http://local/v2/remote/resume/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "OpenBot-Timestamp": timestamp, "OpenBot-Signature": signature },
    body: resumeBody,
  }),
);
const resumeJson = await resume.json();
assert(
  resume.status === 200 && isJsonObject(resumeJson) && resumeJson.valid === true,
  "resume validate accepts an active session",
);

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
const emailStart = await call<{ error: { code: string } }>("POST", "/v1/auth/email/start", {
  email: "you@example.test",
});
assert(emailStart.status === 400, "email sign-in is disabled when no OIDC connection is configured");

// 11. Mobile Connect: the host shows a QR ticket; the phone redeems it once.
const mobileTicket = await call<{ ticket: string }>(
  "POST",
  "/v1/mobile-auth/ticket",
  { host: { hostId: "host-1", fingerprint: "fp" } },
  sessionToken,
);
assert(mobileTicket.status === 200 && mobileTicket.json.ticket, "host creates a Mobile Connect ticket");
const redeemed = await call<{
  sessionToken: string;
  host?: { hostId: string };
  user: { id: string };
}>("POST", "/v1/mobile-auth/redeem", {
  ticket: mobileTicket.json.ticket,
  deviceId: "dev-1",
  deviceName: "Pixel",
  platform: "android",
});
assert(
  redeemed.status === 200 && redeemed.json.sessionToken && redeemed.json.host?.hostId === "host-1",
  "phone redeems the ticket and is bound to the host",
);
const mobileToken: string = redeemed.json.sessionToken;
const mobileMe = await call<{ id: string }>("GET", "/v1/mobile-auth/session", undefined, mobileToken);
assert(mobileMe.status === 200 && mobileMe.json.id === redeemed.json.user.id, "mobile session is valid");
const devices = await call<{ devices: { platform: string }[] }>(
  "GET",
  "/v1/mobile-auth/devices",
  undefined,
  sessionToken,
);
assert(
  devices.status === 200 && devices.json.devices.length === 1 && devices.json.devices[0].platform === "android",
  "the desktop lists the connected phone",
);
const reuse = await call<JsonObject>("POST", "/v1/mobile-auth/redeem", {
  ticket: mobileTicket.json.ticket,
  deviceId: "dev-2",
  deviceName: "Other",
  platform: "ios",
});
assert(reuse.status === 401, "a one-time Mobile Connect ticket cannot be redeemed twice");

// 12. Mobile feature flags: the browser is on, the hosted server plans are off, no store update.
type MobileFeatures = { features?: { browser?: boolean; cloudServers?: boolean }; latestVersion?: string };
const androidFeatures = await call<MobileFeatures>("GET", "/v1/mobile/features?platform=android&version=1.4.6");
assert(
  androidFeatures.status === 200 &&
    androidFeatures.json.features?.browser === true &&
    androidFeatures.json.features?.cloudServers === false &&
    androidFeatures.json.latestVersion === undefined,
  "android gets the browser feature and no store update",
);
const unknownFeatures = await call<MobileFeatures>("GET", "/v1/mobile/features?platform=desktop&version=1.4.6");
assert(
  unknownFeatures.status === 200 &&
    unknownFeatures.json.features?.browser === false &&
    unknownFeatures.json.features?.cloudServers === false,
  "an unknown platform gets no features",
);

// 13. The routes that the apps use to edit the profile of the account.
const named = await call<{ name: string }>("PATCH", "/v1/me/profile", { name: "  Lena  " }, mobileToken);
assert(named.status === 200 && named.json.name === "Lena", "a mobile session saves the display name");
const shortName = await call<JsonObject>("PATCH", "/v1/me/profile", { name: "a" }, mobileToken);
assert(shortName.status === 400, "a too-short display name is refused");
const colored = await call<{ chatColor: string }>("PUT", "/v1/me/chat-color", { chatColor: "#a1b2c3" }, mobileToken);
assert(colored.status === 200 && colored.json.chatColor === "#a1b2c3", "a mobile session saves the chat colour");
const badColor = await call<JsonObject>("PUT", "/v1/me/chat-color", { chatColor: "purple" }, mobileToken);
assert(badColor.status === 400, "an invalid chat colour is refused");
const analyticsOn = await call<{ analyticsEnabled: boolean }>(
  "PUT",
  "/v1/me/analytics",
  { enabled: true, ageMs: 1000 },
  mobileToken,
);
assert(analyticsOn.status === 200 && analyticsOn.json.analyticsEnabled === true, "the analytics answer is saved");
const analyticsOff = await call<{ analyticsEnabled: boolean }>(
  "PUT",
  "/v1/me/analytics",
  { enabled: false },
  mobileToken,
);
assert(
  analyticsOff.status === 200 && analyticsOff.json.analyticsEnabled === false,
  "the analytics answer can be turned off again",
);
const ready = await call<{ status: string }>("GET", "/health/ready");
assert(ready.status === 200 && ready.json.status === "ok", "readiness answers when the database works");
const oversized = await call<JsonObject>("POST", "/v1/auth/company/start", { returnTo: "a".repeat(70 * 1024) });
assert(oversized.status === 413, "an oversized request body is refused");

// 14. Generic webhook routes: the host registers an opaque route ID, gets a route ticket for its
// Signal ingress socket, and Signal re-checks the ticket's routes with a signed request.
type RouteAnswer = { routeId: string };
type RouteError = { error: { code: string } };
const routeId = "route_AbC-123";
const registered = await call<RouteAnswer>("POST", "/v2/remote/hosts/host-1/webhook-routes", { machineToken, routeId });
assert(registered.status === 201 && registered.json.routeId === routeId, "host registers a webhook route");
const again = await call<RouteAnswer>("POST", "/v2/remote/hosts/host-1/webhook-routes", { machineToken, routeId });
assert(again.status === 201, "registering the same route again is idempotent for its owner");
const badRouteId = await call<JsonObject>("POST", "/v2/remote/hosts/host-1/webhook-routes", {
  machineToken,
  routeId: "a/b",
});
assert(badRouteId.status === 400, "a route ID outside the public URL syntax is refused");
const wrongToken = await call<JsonObject>("POST", "/v2/remote/hosts/host-1/webhook-routes", {
  machineToken: "wrong",
  routeId: "other",
});
assert(wrongToken.status === 401, "a wrong machine token cannot register a route");

const routeTicket = await call<{ ticket: string; routes: string[] }>("POST", "/v2/remote/hosts/host-1/webhook-route", {
  machineToken,
});
assert(routeTicket.status === 200 && routeTicket.json.routes[0] === routeId, "host gets a webhook route ticket");
const routeClaims = await jwtVerify(routeTicket.json.ticket, keySet, {
  audience: WEBHOOK_ROUTE_AUDIENCE,
  algorithms: ["ES256"],
  requiredClaims: ["exp"],
});
const ticketRoutes: { id: string; linkedAt: number }[] = [];
for (const entry of Array.isArray(routeClaims.payload.routes) ? routeClaims.payload.routes : []) {
  if (isJsonObject(entry) && typeof entry.id === "string" && typeof entry.linkedAt === "number") {
    ticketRoutes.push({ id: entry.id, linkedAt: entry.linkedAt });
  }
}
assert(
  routeClaims.payload.hid === "host-1" && ticketRoutes.length === 1 && ticketRoutes[0].id === routeId,
  "the route ticket verifies with JWKS and names the host and route",
);
assert(
  Number.isSafeInteger(ticketRoutes[0].linkedAt) && ticketRoutes[0].linkedAt > 1_000_000_000_000,
  "linkedAt is in milliseconds",
);
const deniedTicket = await call<JsonObject>("POST", "/v2/remote/hosts/host-1/webhook-route", { machineToken: "wrong" });
assert(deniedTicket.status === 401, "a wrong machine token gets no route ticket");

/** Posts to Signal's validation route, signed as Signal signs it. */
async function validateRoutes(
  payload: unknown,
  at = Math.floor(Date.now() / 1000),
  sign = true,
): Promise<{ status: number; routes: string[] }> {
  requests += 1;
  const body = JSON.stringify(payload);
  const stamp = at.toString();
  const signature = sign
    ? createHmac("sha256", config.authWebhookSecret).update(`${stamp}.${body}`).digest("base64url")
    : "nope";
  const response = await app(
    new Request("http://local/v2/remote/webhook-route/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "OpenBot-Timestamp": stamp, "OpenBot-Signature": signature },
      body,
    }),
  );
  const answer = JSON.parse(await response.text());
  const routes = isJsonObject(answer) && Array.isArray(answer.routes) ? answer.routes : [];
  return { status: response.status, routes: routes.filter((route) => typeof route === "string") };
}
const validated = await validateRoutes({
  hostId: "host-1",
  routes: [...ticketRoutes, { id: routeId, linkedAt: 1 }, { id: "unknown", linkedAt: ticketRoutes[0].linkedAt }],
});
assert(
  validated.status === 200 && validated.routes.length === 1 && validated.routes[0] === routeId,
  "Signal's validation keeps only live routes with the stored link time",
);
assert(
  (await validateRoutes({ hostId: "host-1", routes: ticketRoutes }, undefined, false)).status === 401,
  "validation refuses a bad signature",
);
assert(
  (await validateRoutes({ hostId: "host-1", routes: ticketRoutes }, Math.floor(Date.now() / 1000) - 3600)).status ===
    401,
  "validation refuses a stale timestamp",
);
assert((await validateRoutes({ hostId: "host-1", routes: "x" })).status === 400, "validation refuses a malformed body");

// Another host of the same account cannot take the route.
const register2 = await call<{ machineToken: string }>(
  "POST",
  "/v2/remote/hosts/register",
  { hostId: "host-2", name: "host-2", ownerMembershipId: "owner-2", rotateCredential: true },
  sessionToken,
);
const stolen = await call<RouteError>("POST", "/v2/remote/hosts/host-2/webhook-routes", {
  machineToken: register2.json.machineToken,
  routeId,
});
assert(
  stolen.status === 409 && stolen.json.error.code === "webhook_route_conflict",
  "another host cannot take a live route",
);

requests += 1;
const revoked = await app(
  new Request("http://local/v2/remote/hosts/host-1/webhook-routes", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ machineToken, routeId }),
  }),
);
assert(revoked.status === 204, "host revokes its webhook route");
const afterRevoke = await validateRoutes({ hostId: "host-1", routes: ticketRoutes });
assert(afterRevoke.status === 200 && afterRevoke.routes.length === 0, "a revoked route no longer validates");
const emptyTicket = await call<{ routes: string[] }>("POST", "/v2/remote/hosts/host-1/webhook-route", { machineToken });
assert(emptyTicket.status === 200 && emptyTicket.json.routes.length === 0, "a revoked route leaves the route ticket");
const reused = await call<RouteError>("POST", "/v2/remote/hosts/host-1/webhook-routes", { machineToken, routeId });
assert(
  reused.status === 409 && reused.json.error.code === "webhook_route_conflict",
  "a revoked route ID is never reused",
);

console.log(`\nAll ${requests} requests passed.`);
