import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseForkVersion, stripForkSuffix } from "./version-utils.mjs";

export function repoRootFromModule(moduleUrl) {
  return path.resolve(path.dirname(new URL(moduleUrl).pathname), "..", "..");
}

export function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

export function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();
}

export function git(root, args, options = {}) {
  return capture("git", args, { cwd: root, ...options });
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

const statePath = (root) => path.join(root, ".fork", "state.json");

export function readState(root) {
  if (!existsSync(statePath(root))) return { upstreamTag: "", upstreamCommit: "" };
  return readJson(statePath(root));
}

export function writeState(root, state) {
  writeJson(statePath(root), state);
}

export function readRootVersion(root) {
  return readJson(path.join(root, "package.json")).version;
}

/**
 * The Android version code of a fork build, in the shape of the Paseo fork:
 *
 *   (major*10^6 + minor*10^3 + patch) * 10000 + forkBuildNumber
 *
 * The fork build number keeps rising across upstream bases, so it also orders a
 * prerelease and the stable release that follows it. 0.63.0-fork.1 gives 630000001.
 */
const FORK_BUILD_SLOTS = 10_000;
const MAX_FORK_BUILD = 9_999;

export function androidVersionCode(baseVersion, buildNumber) {
  const [major, minor, patch] = stripForkSuffix(baseVersion)
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10));
  if (![major, minor, patch].every((part) => Number.isSafeInteger(part) && part >= 0)) {
    throw new Error(`Cannot read a version from ${baseVersion}.`);
  }
  if (minor > 999 || patch > 999) {
    throw new Error(`Cannot make a collision-free Android version code from ${baseVersion}.`);
  }
  if (!Number.isSafeInteger(buildNumber) || buildNumber < 1 || buildNumber > MAX_FORK_BUILD) {
    throw new Error(`The fork build number must be between 1 and ${MAX_FORK_BUILD}.`);
  }
  const code = (major * 1_000_000 + minor * 1_000 + patch) * FORK_BUILD_SLOTS + buildNumber;
  // Google Play and Android accept at most 2,100,000,000. This scheme reaches that
  // near minor version 200, so it has room for years of upstream releases.
  if (code > 2_100_000_000) {
    throw new Error(`The Android version code is out of range: ${code}.`);
  }
  return code;
}

/**
 * Writes the fork version into the files that the two release trains read. The desktop app takes
 * the root version. The mobile app keeps its own marketing version, because it follows the store
 * train of upstream, and gets an Android version code that the local Gradle build can use.
 *
 * app.json is patched as text: a JSON round trip reflows every short array, and each such line is
 * a conflict at the next merge of upstream.
 */
export function applyVersion(root, version) {
  const baseVersion = stripForkSuffix(version);
  const { buildNumber } = parseForkVersion(version);
  const versionCode = androidVersionCode(baseVersion, buildNumber);

  const packagePath = path.join(root, "package.json");
  const pkg = readJson(packagePath);
  pkg.version = version;
  writeJson(packagePath, pkg);

  const appPath = path.join(root, "apps", "mobile", "app.json");
  const app = readFileSync(appPath, "utf8");
  let patched = app;
  if (/"versionCode"\s*:\s*\d+/u.test(patched)) {
    patched = patched.replace(/"versionCode"\s*:\s*\d+/u, `"versionCode": ${versionCode}`);
  } else {
    patched = patched.replace(
      /("android"\s*:\s*\{\s*\n\s*"package"\s*:\s*"[^"]*",\n)/u,
      `$1      "versionCode": ${versionCode},\n`,
    );
    if (patched === app) throw new Error("app.json: the android block has no package line.");
  }
  if (/"buildNumber"\s*:\s*"[^"]*"/u.test(patched)) {
    patched = patched.replace(/"buildNumber"\s*:\s*"[^"]*"/u, `"buildNumber": "${versionCode}"`);
  } else {
    const before = patched;
    patched = patched.replace(
      /("ios"\s*:\s*\{\s*\n\s*"bundleIdentifier"\s*:\s*"[^"]*",\n)/u,
      `$1      "buildNumber": "${versionCode}",\n`,
    );
    if (patched === before) throw new Error("app.json: the ios block has no bundleIdentifier line.");
  }
  writeFileSync(appPath, patched);

  return { baseVersion, buildNumber, versionCode };
}

/**
 * The next fork build number: one above the highest of all fork tags. It does not
 * restart at 1 for a new upstream base, because the Android version code and the
 * macOS update both need one rising number.
 */
export function nextForkNumber(root) {
  let highest = 0;
  for (const tag of git(root, ["tag", "--list", "fork-v*"]).split("\n").filter(Boolean)) {
    const match = tag.match(/-fork\.(\d+)$/u);
    if (match) highest = Math.max(highest, Number.parseInt(match[1], 10));
  }
  return highest + 1;
}

export function currentBranch(root) {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function assertCleanWorktree(root) {
  if (git(root, ["status", "--porcelain"])) {
    throw new Error("The worktree has changes. Commit or discard them before a release.");
  }
}

export function mergeHeadExists(root) {
  return git(root, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]).length > 0;
}

export function hasUnmergedPaths(root) {
  return git(root, ["ls-files", "--unmerged"]).length > 0;
}

/** The merge commits that are in progress: one for a merge, none otherwise. */
export function commitAll(root, message) {
  run("git", ["add", "--all"], { cwd: root });
  run("git", ["commit", "--message", message], { cwd: root });
}

export function tagRelease(root, version, message) {
  const tag = `fork-v${version}`;
  run("git", ["tag", "--annotate", tag, "--message", message], { cwd: root });
  return tag;
}
