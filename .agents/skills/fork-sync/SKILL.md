---
name: fork-sync
description: Merge the newest upstream OpenBot release into the fork, cut a fork release, and report the GitHub release. Use when the scheduled fork sync runs.
---

# Fork sync

The repository is `lennartschoch/openbot`, a fork of `nightly-labs/openbot`.
`origin` is the fork; `upstream` is `nightly-labs/openbot`. Read `FORK.md` for the
release design, the secrets and the files that need care at each merge.

## Run the sync

From the fork checkout (normally `/home/agent/workspace/openbot`):

```bash
node scripts/fork/sync-upstream.mjs --push
```

The script fetches the upstream tags, takes the newest upstream release tag that
`main` does not contain (prereleases included), merges it, writes
`.fork/state.json`, bumps the fork version, commits, tags
`fork-v<base>-fork.<n>`, and pushes `main` and the tag. The tag starts the
`Fork release` workflow.

Exit codes:

- `0` — synced and pushed, or upstream was already included. Report which.
- `2` — the merge has conflicts. Resolve them as below, then continue.
- anything else — stop and report. Do not push a partial result.

Never force-push `main`. Never cut a second release for one upstream tag.

## Resolve a conflict

1. Read `git status` and the conflicted files. `HEAD` is the fork side; the
   incoming side is the upstream release.
2. Keep both sides unless they disagree. Protect these fork-only parts:
   - `apps/mobile/app.json` — `com.lennartschoch.openbot`, app group, no
     `eas.projectId`, `updates.enabled: false`; the scheme stays `openbot`
     because the host emits `openbot://mobile-connect` links.
   - `apps/mobile/google-services.json` — deleted. The fork uses the UnifiedPush
     transport, not Firebase Cloud Messaging.
   - `apps/mobile/src/features/app-update/model/app-update.ts` and
     `packages/ui/src/features/mobile-app/android-play-store.ts` — links to this
     repository's releases.
   - `apps/mobile/src/features/push-notifications/push-notifications-native.ios.ts`
     and `apps/mobile/src/features/share/model/share-extension.ts` — app group
     `group.com.lennartschoch.openbot`.
   - `apps/mobile/modules/quick-actions/.../QuickActionsModule.kt` — the action
     names use `com.lennartschoch.openbot`.
   - `account/` — the drop-in account service. Upstream `apps/auth-api` stays
     unmodified only for merges.
   - `FORK.md`, `README.md` (the fork note), `.fork/state.json`,
     `scripts/fork/`, `.github/workflows/fork-release.yml`,
     `.github/workflows/account-image.yml`.
3. Check the touched area, not the whole tree:
   ```bash
   bun install --frozen-lockfile            # only when a lockfile changed
   bunx biome check <changed files>          # formatting and lint
   bun run mobile:typecheck                  # only when apps/mobile changed
   bun run typecheck:node                    # only when src/ changed
   cd account && bun run typecheck           # only when account/ changed
   ```
   The account self-test is fast and needs no network:
   ```bash
   cd account && bun run src/selftest.ts
   ```
4. Stage the result, then finish the merge, tag, and push:
   ```bash
   git add -A
   node scripts/fork/sync-upstream.mjs --continue --tag <upstream-tag> --push
   ```

## Verify the release

The tag starts the build; Linux and macOS take 30–60 minutes, the Android APK up
to 90 minutes on its first run.

```bash
gh run list --repo lennartschoch/openbot --workflow fork-release.yml --limit 3
gh release view fork-v<version> --repo lennartschoch/openbot --json isDraft,isPrerelease,assets
```

The release stays a draft until Linux, macOS and Android all succeed. If a job
fails, read that job's log, fix the cause, and re-run the workflow for the same
tag. Never reuse a version for a changed build.

Report: upstream tag and commit, fork version and tag, release URL, whether it is
a prerelease, and any platform that failed.

## If there is no new upstream release

The script exits `0` with `Upstream <tag> is already part of main; nothing to do.`
Report that and stop. Do not cut a release just to have one.

## Fork-only release

When `main` has fixes that must ship without an upstream merge:

```bash
node scripts/fork/cut-release.mjs --push
```

This tags another `-fork.<n>` build of the same upstream base. Use it
deliberately, not as a retry for a failed build.

## Prerequisites on the machine that runs this

- The fork is checked out at the path above, with `upstream` pointing at
  `https://github.com/nightly-labs/openbot.git`.
- `gh` is authenticated and can push to `lennartschoch/openbot`.
- Bun 1.4.2 and Node 24 are on `PATH` (the sync scripts themselves need only
  Node).
- The worktree is clean and on `main`. The script refuses otherwise; do not
  stash, reset, or discard changes to get past that.
