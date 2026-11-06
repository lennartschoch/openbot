import { spawnSync } from "node:child_process";

import {
  applyVersion,
  assertCleanWorktree,
  commitAll,
  currentBranch,
  git,
  hasUnmergedPaths,
  mergeHeadExists,
  nextForkNumber,
  repoRootFromModule,
  run,
  tagRelease,
  writeState,
} from "./lib.mjs";
import { formatForkVersion, isUpstreamReleaseTag } from "./version-utils.mjs";

// Moves the fork onto the newest upstream release and cuts the fork release.
//
//   node scripts/fork/sync-upstream.mjs [--tag v0.64.0] [--push]
//
// Exit 0: synced, or upstream is already part of main. Exit 2: the merge has conflicts.
// Resolve them, then run the same command with --continue and the upstream tag.

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  const args = {
    tag: "",
    continue: false,
    push: false,
    upstreamRemote: "upstream",
    forkRemote: "origin",
    branch: "main",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--tag":
        args.tag = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--continue":
        args.continue = true;
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
        process.stdout.write(
          "Usage: node scripts/fork/sync-upstream.mjs [--tag v<version>] [--continue] [--push]\n",
        );
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

/** The newest upstream release tag that main does not contain. Includes prereleases. */
function newestMissingTag() {
  run("git", ["fetch", args.upstreamRemote, "--tags", "--force"], { cwd: root });
  const tags = git(root, ["tag", "--list", "v*", "--sort=-v:refname"])
    .split("\n")
    .filter((tag) => isUpstreamReleaseTag(tag));
  for (const tag of tags) {
    if (!isAncestor(tag)) return tag;
  }
  return tags[0] ?? "";
}

function isAncestor(tag) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", tag, "HEAD"], { cwd: root });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Unable to compare ${tag} with HEAD.`);
}

function cutAndPush(tag) {
  const commit = git(root, ["rev-list", "-n", "1", tag]);
  // The base version comes from the upstream tag, not from the file: a sync moves the base.
  const baseVersion = tag.replace(/^v/u, "");
  const version = formatForkVersion(baseVersion, nextForkNumber(root, baseVersion));

  const applied = applyVersion(root, version);
  writeState(root, { upstreamTag: tag, upstreamCommit: commit });
  commitAll(root, `chore(fork): sync ${tag} and release ${version}`);
  const forkTag = tagRelease(root, version, `OpenBot fork ${version} (upstream ${baseVersion})`);

  process.stdout.write(
    `\nUpstream ${tag} (${commit.slice(0, 12)}) is merged.\n` +
      `Fork version ${version}, Android version code ${applied.versionCode}.\n` +
      `Tag ${forkTag}.\n`,
  );

  if (args.push) {
    run("git", ["push", args.forkRemote, args.branch], { cwd: root });
    run("git", ["push", args.forkRemote, forkTag], { cwd: root });
    process.stdout.write(`Pushed ${args.branch} and ${forkTag} to ${args.forkRemote}.\n`);
  } else {
    process.stdout.write(`Push it with:\n  git push ${args.forkRemote} ${args.branch} ${forkTag}\n`);
  }
  return { tag, forkTag, version };
}

if (args.continue) {
  if (!args.tag) throw new Error("--continue needs --tag <upstream-tag>.");
  if (!mergeHeadExists(root)) throw new Error("No merge is in progress.");
  if (hasUnmergedPaths(root)) {
    process.stderr.write("The merge still has unmerged paths. Resolve and stage them first.\n");
    process.exit(2);
  }
  if (git(root, ["diff", "--cached", "--name-only"])) {
    run("git", ["commit", "--no-edit"], { cwd: root });
  } else if (mergeHeadExists(root)) {
    run("git", ["commit", "--no-edit", "--allow-empty"], { cwd: root });
  }
  cutAndPush(args.tag);
  process.exit(0);
}

assertCleanWorktree(root);

const tag = args.tag || newestMissingTag();
if (!tag) throw new Error("The upstream remote has no release tag.");
if (!isUpstreamReleaseTag(tag)) throw new Error(`"${tag}" is not an upstream release tag.`);
if (isAncestor(tag)) {
  process.stdout.write(`Upstream ${tag} is already part of ${args.branch}; nothing to do.\n`);
  process.exit(0);
}

const commit = git(root, ["rev-list", "-n", "1", tag]);

let mergeFailed = false;
try {
  run("git", ["merge", "--no-edit", commit], { cwd: root });
} catch (error) {
  if (!hasUnmergedPaths(root) && !mergeHeadExists(root)) throw error;
  mergeFailed = true;
}

if (mergeFailed) {
  process.stderr.write(
    `\nThe merge of ${tag} (${commit.slice(0, 12)}) has conflicts.\n\n` +
      "1. Resolve them. Keep both sides unless they disagree; FORK.md lists the fork-only files.\n" +
      "2. Stage the result: git add -A\n" +
      `3. Continue: node scripts/fork/sync-upstream.mjs --continue --tag ${tag}${args.push ? " --push" : ""}\n`,
  );
  process.exit(2);
}

const { forkTag } = cutAndPush(tag);
const url = git(root, ["config", "--get", `remote.${args.forkRemote}.url`]);
const slug = /github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/u.exec(url)?.groups?.slug;
process.stdout.write(
  slug ? `Release: https://github.com/${slug}/releases/tag/${forkTag}\n` : `Release tag: ${forkTag}\n`,
);
