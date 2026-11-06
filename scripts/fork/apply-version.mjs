import path from "node:path";

import { applyVersion, readRootVersion, repoRootFromModule } from "./lib.mjs";
import { stripForkSuffix } from "./version-utils.mjs";

const root = repoRootFromModule(import.meta.url);

function parseArgs(argv) {
  let version = "";
  let print = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      version = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--print") {
      print = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (print) {
    process.stdout.write(`${stripForkSuffix(readRootVersion(root))}\n`);
    process.exit(0);
  }
  if (!version) throw new Error("Usage: node scripts/fork/apply-version.mjs --version <version>");
  return version;
}

const version = parseArgs(process.argv.slice(2));
const applied = applyVersion(root, version);
process.stdout.write(
  `${path.relative(process.cwd(), root) || "."}: version ${version} (Android version code ${applied.versionCode})\n`,
);
