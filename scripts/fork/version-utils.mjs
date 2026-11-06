const baseVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const forkVersionPattern =
  /^(?<base>\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)-fork\.(?<build>\d+)$/;

const stableTagPattern = /^v\d+\.\d+\.\d+$/;
const upstreamReleaseTagPattern = /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const forkTagPattern = /^fork-v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-fork\.\d+)$/;

export function isBaseVersion(value) {
  return typeof value === "string" && baseVersionPattern.test(value) && !value.includes("-fork.");
}

export function formatForkVersion(baseVersion, buildNumber) {
  if (!isBaseVersion(baseVersion)) {
    throw new Error(
      `Unsupported base version "${baseVersion}". Expected semver like 0.13.0 or 0.13.0-beta.1.`,
    );
  }
  if (!Number.isInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Invalid fork build number: ${buildNumber}`);
  }
  return `${baseVersion}-fork.${buildNumber}`;
}

export function parseForkVersion(value) {
  const match = typeof value === "string" ? value.match(forkVersionPattern) : null;
  if (!match?.groups) {
    throw new Error(`Unsupported fork version "${value}". Expected <base>-fork.<build>.`);
  }
  const buildNumber = Number.parseInt(match.groups.build, 10);
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1) {
    throw new Error(`Invalid fork build number in "${value}".`);
  }
  return {
    version: value,
    baseVersion: match.groups.base,
    buildNumber,
  };
}

export function isForkVersion(value) {
  return typeof value === "string" && forkVersionPattern.test(value);
}

export function formatForkTag(version) {
  parseForkVersion(version);
  return `fork-v${version}`;
}

export function parseForkTag(tag) {
  const normalized = typeof tag === "string" ? tag.trim().replace(/^refs\/tags\//, "") : "";
  const match = normalized.match(forkTagPattern);
  if (!match?.groups) {
    throw new Error(`Unsupported fork tag "${tag}". Expected fork-v<base>-fork.<build>.`);
  }
  return parseForkVersion(match.groups.version);
}

export function isUpstreamReleaseTag(tag) {
  return typeof tag === "string" && upstreamReleaseTagPattern.test(tag.trim());
}

export function isStableUpstreamTag(tag) {
  return typeof tag === "string" && stableTagPattern.test(tag.trim());
}

export function stripForkSuffix(version) {
  return isForkVersion(version) ? parseForkVersion(version).baseVersion : version;
}
