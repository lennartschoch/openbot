// The account server that this app signs in to, saved by the Server URL setting. The file holds the
// saved choice; the environment variable `OPENBOT_AUTH_API_URL` stays the stronger override, and
// with neither the app uses its default server. Main reads the file once before the windows open,
// so the invite links and the Content-Security-Policy see the same server that the account runtime
// signs in with, and the setting applies at the next start.

import { readFileSync } from "node:fs";
import type { ServerUrlPreference, SetServerUrlPreferenceInput } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect, Semaphore } from "effect";
import { type PreferenceFileFailure, writePreferenceFile } from "./preference-file";

export const SERVER_URL_PREFERENCE_FILE = "server-url-v1.json";

/** The saved choice. Null uses the default server, and an invalid saved value reads as null. */
export interface SavedServerConfig {
  url: string | null;
  signalUrl: string | null;
}

/**
 * The origin of the account server: `https:` anywhere, or `http:` on this computer only. The same
 * rule as `readCentralAuthApiUrl`, with a message that names the setting instead of the variable.
 */
export function parseServerUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.pathname !== "/") {
    throw new Error(sourceText("error.app.serverUrlInvalid"));
  }
  return url.origin;
}

/** The origin of a self-hosted Signal service: `wss:` with no user name and no password. */
export function parseSignalUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "wss:" || url.username !== "" || url.password !== "") {
    throw new Error(sourceText("error.app.serverUrlSignalInvalid"));
  }
  return url.origin;
}

function savedOrigin(value: unknown, parse: (value: string) => string): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    return parse(value);
  } catch {
    return null;
  }
}

/**
 * The saved choice, read once before the windows open. A file that is missing, unreadable as JSON,
 * or of another version reads as the default, and so does a value that is not a valid URL: the app
 * then starts on its default server rather than failing to start.
 */
export function readSavedServerConfig(path: string): SavedServerConfig {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!isDynamicRecord(parsed) || parsed.version !== 1) return { url: null, signalUrl: null };
    return {
      url: savedOrigin(parsed.url, parseServerUrl),
      signalUrl: savedOrigin(parsed.signalUrl, parseSignalUrl),
    };
  } catch {
    return { url: null, signalUrl: null };
  }
}

export interface ServerUrlService {
  /** The saved choice and the server that this run signs in with. */
  get(): ServerUrlPreference;
  /** Saves the changed values, or clears them with null. An invalid URL throws. */
  set(input: SetServerUrlPreferenceInput): Effect.Effect<ServerUrlPreference, PreferenceFileFailure>;
}

/** One service over one `server-url-v1.json`. `effectiveUrl` and the env flag cannot change in a run. */
export function createServerUrlService(options: {
  path: string;
  initial: SavedServerConfig;
  effectiveUrl: string;
  environmentUrlSet: boolean;
}): ServerUrlService {
  const { path, effectiveUrl, environmentUrlSet } = options;
  let value: SavedServerConfig = options.initial;
  const writes = Semaphore.makeUnsafe(1);

  const preference = (): ServerUrlPreference => ({
    url: value.url,
    signalUrl: value.signalUrl,
    effectiveUrl,
    fromEnvironment: environmentUrlSet,
  });

  return {
    get: preference,
    set: (input) =>
      writes.withPermit(
        Effect.gen(function* () {
          const current = value;
          const url = input.url === undefined ? current.url : input.url === null ? null : parseServerUrl(input.url);
          const signalUrl =
            input.signalUrl === undefined
              ? current.signalUrl
              : input.signalUrl === null
                ? null
                : parseSignalUrl(input.signalUrl);
          yield* writePreferenceFile(path, { version: 1, url, signalUrl });
          value = { url, signalUrl };
          return preference();
        }),
      ),
  };
}
