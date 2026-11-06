import {
  applyVersion,
  assertCleanWorktree,
  commitAll,
  currentBranch,
  git,
  nextForkNumber,
  readRootVersion,
  repoRootFromModule,
  run,
  tagRelease,
} from "./lib.mjs";
import { formatForkVersion, stripForkSuffix } from "./version-utils.mjs";

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  const args = { push: false, upstreamRemote: "upstream", forkRemote: "origin", branch: "main" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
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
          "Usage: node scripts/fork/cut-release.mjs [--push] [--upstream-remote upstream] [--fork-remote origin]\n",
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
  throw new Error(`Check out ${args.branch} before a release (currently on ${currentBranch(root)}).`);
}
assertCleanWorktree(root);

const baseVersion = stripForkSuffix(readRootVersion(root));
const buildNumber = nextForkNumber(root, baseVersion);
const version = formatForkVersion(baseVersion, buildNumber);

const applied = applyVersion(root, version);
commitAll(root, `chore(fork): release ${version}`);
const tag = tagRelease(root, version, `OpenBot fork ${version} (upstream ${baseVersion})`);

process.stdout.write(
  `\n${tag}\n  version ${version}\n  Android version code ${applied.versionCode}\n\n` +
    `Push it with:\n  git push ${args.forkRemote} ${args.branch} ${tag}\n`,
);

if (args.push) {
  run("git", ["push", args.forkRemote, args.branch, tag], { cwd: root });
}

// The upstream remote is read so that a sync before the release can be checked.
try {
  git(root, ["fetch", args.upstreamRemote, "--tags", "--quiet"]);
} catch {
  process.stderr.write("The upstream remote was not fetched. The release does not need it.\n");
}
