// The most capabilities that a peer of each Team protocol reads in one list. A host of protocol 6 or
// older refuses a longer WebRTC request (`unsupported_operation`) and reads a longer HTTP header as no
// capabilities. Each list that a client can send to a peer must fit the limit of that peer's protocol;
// a list for an unknown protocol must fit the smallest limit. These values are released wire limits:
// do not change one.
//
// Fork: protocol 9 reads 384, not upstream's 256. Upstream's own protocol 9 list reached exactly 256 in
// 0.73.0, and the fork's `push-notifications-android-v2` made it 257, so every fork 0.73 host refused
// every request of a fork 0.73 client with `unsupported_operation`. 384 names stay under the 8 KB
// protocol 9 header limit in `src/main/team-api/request-helpers.ts`. See FORK.md.
export const TEAM_PROTOCOL_CAPABILITY_LIMITS = {
  1: 64,
  2: 64,
  3: 64,
  4: 64,
  5: 64,
  6: 64,
  7: 128,
  8: 128,
  9: 384,
  10: 384,
} as const;

/**
 * The limit of `protocol`. An unknown protocol gets the limit of protocol 1, which every released
 * peer reads. A protocol newer than the table gets the newest limit.
 */
export function teamProtocolCapabilityLimit(protocol: number | null | undefined): number {
  let limit: number = TEAM_PROTOCOL_CAPABILITY_LIMITS[1];
  if (protocol === null || protocol === undefined) return limit;
  // Integer keys come in ascending order.
  for (const [version, value] of Object.entries(TEAM_PROTOCOL_CAPABILITY_LIMITS))
    if (protocol >= Number(version)) limit = value;
  return limit;
}
