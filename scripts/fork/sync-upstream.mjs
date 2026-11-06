import {
  assertCleanWorktree,
  capture,
  commitAll,
  currentBranch,
  git,
  readRootVersion,
  repoRootFromModule,
  run,
  writeState,
} from "./lib.mjs";
import { isUpstreamReleaseTag, stripForkSuffix } from "./version-utils.mjs";

// Moves the fork onto an upstream release. The merge keeps the fork commits; the version of the
// fork stays its own, so the release after the sync adds a fork build number.
//
//   node scripts/fork/sync-upstream.mjs --tag v0.63.0 [--push]
//
// Without --tag, the newest release tag of the upstream remote is used.

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  const args = { tag: "", push: false, upstreamRemote: "upstream", forkRemote: "origin", branch: "main" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--tag":
        args.tag = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--push":
        args.push = true;
        break;
      case "--upstream-remote":
        args.upstreamRemote = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--fork-remote":
        args.forkRemote = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--branch":
        args.branch = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--help":
      case "-h":
        process.stdout.write("Usage: node scripts/fork/sync-upstream.mjs [--tag v0.63.0] [--push]\n");
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (currentBranch(root) !== args.branch) {
  throw new Error(`Check out ${args.branch} before a sync (currently on ${currentBranch(root)}).`);
}
assertCleanWorktree(root);

run("git", ["fetch", args.upstreamRemote, "--tags", "--force"], { cwd: root });

const tag =
  args.tag ||
  git(root, ["tag", "--list", "v*", "--sort=-v:refname", "--merged", `${args.upstreamRemote}/main`])
    .split("\n")
    .filter(Boolean)
    .find((candidate) => isUpstreamReleaseTag(candidate)) ||
  "";

if (!tag || !isUpstreamReleaseTag(tag)) {
  throw new Error("No upstream release tag found. Pass --tag v<version>.");
}

const commit = git(root, ["rev-list", "-n", "1", tag]);
run("git", ["merge", "--no-edit", commit], { cwd: root });

writeState(root, { upstreamTag: tag, upstreamCommit: commit });

const baseVersion = stripForkSuffix(readRootVersion(root));
const ahead = git(root, ["rev-list", "--count", `${tag}..HEAD`]);

run("git", ["add", ".fork/state.json"], { cwd: root });
const staged = git(root, ["diff", "--cached", "--name-only"]);
if (staged) commitAll(root, `chore(fork): sync ${tag}`);

process.stdout.write(
  `\nSynced ${tag} (${commit.slice(0, 12)}).\n` +
    `Fork version base: ${baseVersion}. Commits after the tag: ${ahead}.\n` +
    (args.push
      ? ""
      : `Push it with:\n  git push ${args.forkRemote} ${args.branch}\n`),
);

if (args.push) run("git", ["push", args.forkRemote, args.branch], { cwd: root });
