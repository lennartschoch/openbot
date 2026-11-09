// Checks that a real ntfy UnifiedPush endpoint passes the frozen v2 registration codec and that the
// host sends the sealed notification to that endpoint. The codec's host pattern used to accept only a
// single label and no query, so every real ntfy endpoint failed and no Android phone could register.
//
// It uses the real codec, the real store reader and the real notification service, with a send that
// records the request. The host name is the deployment's; the topic is a fixture.
// Run it with `bun scripts/push-notification-ntfy-e2e.ts`.
// Writes .openbot-build/push-notification-ntfy-e2e/report.json.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import {
  ANDROID_UNIFIED_PUSH_NOTIFICATIONS_CODECS,
  ANDROID_UNIFIED_PUSH_NOTIFICATIONS_ROUTES,
  type AndroidUnifiedPushNotificationRegistration,
} from "@openbot/contracts/team-protocol/push-notifications-android-v2";
import { createOpenBotLogger } from "@openbot/logging";
import { encodeLiveActivityBytes, LIVE_ACTIVITY_SECRET_BYTES } from "@openbot/team-client/live-activity-seal";
import { Effect } from "effect";
import { readAndroidUnifiedPushRegistration } from "../src/main/push-notification-store";
import { type NotificationRelayRequest, PushNotificationService } from "../src/main/push-notifications";

const OUT = resolve(import.meta.dirname, "../.openbot-build/push-notification-ntfy-e2e");
const ENDPOINT = "https://ntfy.example.com/openbot-topic?up=1";
const SESSION = "android-ntfy-session";
const MEMBER = "fixture-member";
const AGENT = "agent-a";
const logger = createOpenBotLogger("push-notification-ntfy-e2e");

interface Check {
  name: string;
  passed: boolean;
  detail?: string;
}

const checks: Check[] = [];
const sent: NotificationRelayRequest[] = [];
const events = new EventEmitter<{ event: [AgentEvent] }>();

async function check(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    checks.push({ name, passed: true });
  } catch (error) {
    checks.push({ name, passed: false, detail: String(error) });
  }
}

function registration(token: string): AndroidUnifiedPushNotificationRegistration {
  return {
    serverId: "fixture-server",
    token,
    secret: encodeLiveActivityBytes(randomBytes(LIVE_ACTIVITY_SECRET_BYTES)),
    locale: "en",
    away: true,
    level: "all",
    mutedUntil: null,
    preview: false,
    sound: "default",
  };
}

function agentSummary(): AgentSummary {
  return {
    id: AGENT,
    name: "Agent A",
    title: "",
    description: "",
    notifications: true,
    provider: "codex",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    threadId: AGENT,
    workspacePath: "",
    preview: "Done.",
    updatedAt: null,
    avatarSeed: AGENT,
    avatarHue: null,
    avatarUrl: null,
  };
}

const agents = {
  on: (_name: "event", listener: (event: AgentEvent) => void) => events.on("event", listener),
  off: (_name: "event", listener: (event: AgentEvent) => void) => events.off("event", listener),
  listAgents: () => [agentSummary()],
  readConversationPageFor: () => Effect.die(new Error("Previews are off in this check.")),
  readTask: () => {
    throw new Error("Previews are off in this check.");
  },
  getRuntimeSnapshot: () => ({
    agents: [
      {
        id: AGENT,
        name: "Agent A",
        notifications: true,
        preview: "Done.",
        updatedAt: null,
        avatarSeed: AGENT,
        avatarHue: null,
        avatarUrl: null,
      },
    ],
    activeTurns: [],
    work: [],
    latestMessages: [],
    attentionComplete: true,
    pendingPrompts: [],
    pendingApprovals: [],
    pendingBrowserTakeovers: [],
    failedTurns: [],
  }),
  listConversationReads: () => ({}),
};

const phones = new PushNotificationService({
  agents,
  store: { list: () => [], replace: () => Effect.void },
  send: (request) =>
    Effect.sync(() => {
      sent.push(request);
      return "sent" as const;
    }),
  hiddenAgentIds: () => new Set(),
  memberActive: (memberId) => memberId === MEMBER,
  lastUseElsewhere: () => null,
  atHostComputer: () => false,
  liveActivityShows: () => false,
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
});

phones.start();
const codec = ANDROID_UNIFIED_PUSH_NOTIFICATIONS_CODECS.get(ANDROID_UNIFIED_PUSH_NOTIFICATIONS_ROUTES.register);
assert.ok(codec, "The v2 registration codec is registered.");

/** Waits until the service sends, as the event listener runs in its own fiber. */
async function waitForSend(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (sent.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (sent.length === 0) throw new Error("The host sent no notification.");
}

let passed = false;
try {
  await check("a dotted ntfy host with the ?up=1 query passes the v2 codec", () => {
    const decoded = codec.request(registration(ENDPOINT));
    const value = readAndroidUnifiedPushRegistration(decoded);
    assert.ok(value, "The store reader accepts the decoded registration.");
    assert.equal(value.token, ENDPOINT);
  });

  await check("a bare ntfy topic URL without the query still passes", () => {
    const decoded = codec.request(registration("https://ntfy.sh/openbot-fixture-topic"));
    assert.ok(readAndroidUnifiedPushRegistration(decoded), "The store reader accepts the decoded registration.");
  });

  for (const [name, token] of [
    ["a plain HTTP endpoint is still rejected", "http://ntfy.example.com/openbot-fixture-topic"],
    ["credentials in the endpoint are still rejected", "https://user:pass@ntfy.example.com/topic"],
    ["a non-HTTPS scheme is still rejected", "ftp://ntfy.example.com/topic"],
  ] as const) {
    await check(name, () => {
      assert.throws(() => codec.request(registration(token)));
    });
  }

  await check("the real service registers the endpoint and posts the sealed notification to it", async () => {
    const decoded = codec.request(registration(ENDPOINT));
    const value = readAndroidUnifiedPushRegistration(decoded);
    assert.ok(value, "The registration decodes.");
    phones.register(
      SESSION,
      { memberId: MEMBER, protocol: 9, capabilities: new Set() },
      { platform: "android-unified", value },
    );
    events.emit("event", {
      type: "turn-completed",
      agentId: AGENT,
      threadId: AGENT,
      turnId: "turn-1",
      status: "completed",
    });
    await waitForSend();
    assert.equal(sent.length, 1, "One notification went out.");
    const request = sent[0];
    assert.ok(request, "The notification was recorded.");
    if (request.platform !== "android-unified") throw new Error(`Unexpected platform ${request.platform}.`);
    assert.equal(request.push.endpoint, ENDPOINT);
  });

  passed = checks.every((item) => item.passed);
} finally {
  await Effect.runPromise(phones.dispose());
  const listenersRemaining = events.listenerCount("event");
  if (listenersRemaining !== 0) passed = false;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(
    join(OUT, "report.json"),
    `${JSON.stringify(
      {
        passed,
        surface: "push-notifications-android-v2 codec -> PushNotificationService -> injected relay send",
        endpointShape: "https://<ntfy host with DNS labels>/<topic>?up=1",
        checks,
        sends: sent.map((request) => ({
          platform: request.platform,
          endpointHost: request.platform === "android-unified" ? new URL(request.push.endpoint).host : null,
        })),
        listenersRemaining,
      },
      null,
      2,
    )}\n`,
  );
}
logger.info(`push-notification-ntfy-e2e: ${passed ? "passed" : "failed"} (${join(OUT, "report.json")})`);
process.exit(passed ? 0 : 1);
