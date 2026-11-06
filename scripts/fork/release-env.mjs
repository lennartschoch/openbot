import { androidVersionCode, git, readState, repoRootFromModule } from "./lib.mjs";
import { parseForkTag } from "./version-utils.mjs";

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  let tag = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") {
      tag = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!tag) tag = process.env.GITHUB_REF_NAME ?? "";
  if (!tag) throw new Error("Usage: node scripts/fork/release-env.mjs --tag fork-v<version>");
  return tag;
}

const tag = parseArgs(process.argv.slice(2));
const { version, baseVersion, buildNumber } = parseForkTag(tag);
const state = readState(root);
const isPrerelease = baseVersion.includes("-");
const releaseChannel = isPrerelease ? "beta" : "latest";

let previousForkTag = "";
try {
  previousForkTag = git(root, ["describe", "--tags", "--abbrev=0", "--match", "fork-v*", `${tag}^`]);
} catch {
  previousForkTag = "";
}

const entries = [
  ["FORK_TAG", `fork-v${version}`],
  ["FORK_VERSION", version],
  ["FORK_BASE_VERSION", baseVersion],
  ["FORK_BUILD_NUMBER", String(buildNumber)],
  ["FORK_ANDROID_VERSION_CODE", String(androidVersionCode(baseVersion, buildNumber))],
  ["FORK_IS_PRERELEASE", isPrerelease ? "true" : "false"],
  ["FORK_RELEASE_CHANNEL", releaseChannel],
  ["FORK_UPSTREAM_TAG", state.upstreamTag ?? ""],
  ["FORK_UPSTREAM_COMMIT", state.upstreamCommit ?? ""],
  ["PREVIOUS_FORK_TAG", previousForkTag],
];

for (const [key, value] of entries) process.stdout.write(`${key}=${value}\n`);
