// The account server that this desktop app signs in to, saved in the app instead of only in
// `OPENBOT_AUTH_API_URL`. The saved URL applies at the next start; the environment variable stays
// the stronger override, and an empty choice uses the hosted server on openbot.run.

import { decodeRecord, nullableString, requiredBoolean, requiredString } from "./ipc-decoding";

/**
 * The server URLs of the account service, as they are saved and as this run uses them.
 * `url` and `signalUrl` are what the user saved; `effectiveUrl` is what this run signed in with.
 */
export interface ServerUrlPreference {
  /** The saved account server origin, or null when the app uses its default. */
  url: string | null;
  /**
   * The saved `wss:` address of a self-hosted Signal service, for team connections on a
   * self-hosted server. Null otherwise.
   */
  signalUrl: string | null;
  /** The account server origin that this run uses. */
  effectiveUrl: string;
  /** True when `OPENBOT_AUTH_API_URL` set the server URL, so the saved choice is not in use. */
  fromEnvironment: boolean;
}

/** The values to change. Null clears a saved value; an absent key keeps it. */
export interface SetServerUrlPreferenceInput {
  url?: string | null;
  signalUrl?: string | null;
}

/** Decodes the server URL preference that main answers. */
export function decodeServerUrlPreference(value: unknown): ServerUrlPreference {
  const preference = decodeRecord(value, "server URL preference");
  return {
    url: nullableString(preference, "url"),
    signalUrl: nullableString(preference, "signalUrl"),
    effectiveUrl: requiredString(preference, "effectiveUrl"),
    fromEnvironment: requiredBoolean(preference, "fromEnvironment"),
  };
}
