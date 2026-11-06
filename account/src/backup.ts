// A consistent copy of the account database, for backup.
//
//   bun run src/backup.ts [target]
//
// The service can keep running: `VACUUM INTO` reads one snapshot and writes a new file.
// The copy holds the ES256 ticket key and the admin token, so keep it as secret as `/data`.
// The default target is a dated file next to the database.

import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve(process.env.OPENBOT_ACCOUNT_DB?.trim() || "account.sqlite");
const target = resolve(
  process.argv[2] ?? `${source.replace(/\.sqlite$/u, "")}-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}.sqlite`,
);

try {
  statSync(source);
} catch {
  console.error(`The database does not exist: ${source}`);
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });

const db = new Database(source);
try {
  // A parameter is not valid in `VACUUM INTO`, so the path is quoted as a SQL string.
  db.exec(`VACUUM INTO '${target.replace(/'/gu, "''")}'`);
} finally {
  db.close();
}

console.log(target);
