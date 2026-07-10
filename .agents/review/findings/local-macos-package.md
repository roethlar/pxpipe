# local-macos-package: Loopback-only macOS package and installer

**Severity**: N/A — owner-approved implementation slice, not a defect finding
**Status**: Verified
**Branch**: `fix/provenance-safe-compression`
**Commit**: `eab46e6aec752530f01dbbcc0ad8488854315f0a`

## Plan authority

`docs/LOCAL_MACOS_PACKAGE_PLAN.md` records the owner's approved local-only
Node package: a verified archive, manifest, per-user macOS LaunchAgent,
rollback, uninstall, no Cloudflare, and an unconditional `127.0.0.1` bind.

## What the slice claims

- `package.json` uses fork-distinct version
  `0.8.0-provenance-safe.1` and exposes `package:macos-local`.
- `scripts/package-macos-local.mjs` refuses dirty source, runs the full gate,
  packs the runtime, validates required files and `--version`, and emits a
  commit-bound archive plus SHA-256 manifest and installer under ignored
  `build/macos-local/`.
- `deploy/macos-local/install.sh` accepts only its adjacent verified bundle,
  installs without sudo/global package managers, writes a loopback-only
  per-user LaunchAgent, blocks occupied ports, rolls back failed health checks,
  and preserves logs/events on uninstall.
- `README.md` documents fork-local build/install/run/remove commands and does
  not direct the owner to Cloudflare or the public package.

## Files changed

- `package.json`
- `deploy/macos-local/install.sh`
- `scripts/package-macos-local.mjs`
- `tests/macos-local-installer.test.ts`
- `README.md`

## Guard proof

- Changing the installer bind from `127.0.0.1` to `0.0.0.0` made the focused
  installer suite fail its loopback assertion; restoration returned all
  focused tests to green.
- Bypassing the manifest/archive digest comparison made the focused installer
  suite accept a corrupt manifest and fail its checksum guard; restoration
  returned all focused tests to green.
- The restored focused suite has 10 passing tests covering install, validation
  failures, occupied port, update, rollback, uninstall, and dirty-source
  packaging refusal.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm test`: 803 passed.
- `pnpm run build`: passed; bundled `--version` reports the prerelease.
- `pnpm run package:macos-local`: passed from clean `eab46e6` and emitted a
  commit-bound archive plus manifest and installer.
- Isolated archive smoke: dashboard returned success on an unused port and
  `lsof` confirmed the packaged process listened on `127.0.0.1` only.
- No actual LaunchAgent was installed and no model call was made.

## Reviewer comments

- Reviewer: Claude Code 2.1.206 / Sonnet 5 (`claude -p`, structured output),
  run with pxpipe bypassed in a disposable worktree.
- Reviewed SHA: `aff8bf15dc824fbf037ab77f3a340cfc5a395db9`;
  base SHA: `926c90f687313dbd70ccb0766d8606a6ad9e9b91`.
- `guard_confirmed: true`.
- Verdict: **accepted** (2026-07-10 21:11 UTC), no material findings.
- Comments (verbatim):
  1. "No concrete observable failure found. Full gate reproduced clean: pnpm
     typecheck (pass), pnpm test (803/803 pass), pnpm build (version smoke
     check prints 0.8.0-provenance-safe.1), pnpm run package:macos-local
     (emits archive+manifest+install.sh bound to HEAD aff8bf1)."
  2. "Independently reversed two guards cited in the finding record and
     confirmed they are load-bearing: (1) changed HOST_BIND from 127.0.0.1 to
     0.0.0.0 in deploy/macos-local/install.sh:8 — the loopback-assertion test
     failed as expected; (2) bypassed the checksum comparison at
     deploy/macos-local/install.sh:168 — the checksum-mismatch test failed as
     expected. Both reverted (diff clean) and the full 10/10 focused suite
     passed again afterward."
  3. "Also manually attacked archive extraction safety, which is not covered
     by the automated test suite: built a crafted tgz with a
     `package/../../outside_pwned.txt` entry and a symlink entry pointing at
     /etc/passwd, matched each to a valid manifest, and ran the real install.sh
     against them in a sandboxed HOME. Both were correctly rejected before
     extraction ('package archive contains an unsafe path' at install.sh:172,
     'package archive contains a link or unsupported entry type' at
     install.sh:179) with no file escaping the staging tree — confirms the
     extraction-safety design (deploy/macos-local/install.sh:170-181) actually
     works, though it has no direct regression test (minor coverage gap, not a
     defect)."
  4. "Ran the real packaged archive directly (extracted in isolation,
     `PORT=48173 node package/bin/cli.js`, no launchd involved) and confirmed
     with lsof that the process bound only to 127.0.0.1:48173 and the dashboard
     returned 200, matching the finding record's smoke-test claim."
  5. "Reviewed update/rollback transaction logic (install.sh:206-280):
     new-release creation is gated on the port becoming free before any
     plist/symlink mutation; a failed health check restores the prior plist and
     `current` symlink and deletes only the newly staged release; a successful
     update prunes releases other than current+previous. Uninstall
     (install.sh:106-117) removes the LaunchAgent and INSTALL_ROOT while leaving
     ~/Library/Logs/pxpipe and ~/.pxpipe/events.jsonl untouched, matching the
     plan and the passing test."
  6. "Manifest/version/commit validation (install.sh:132-165) uses
     regex-anchored fields (40-hex commit, 64-hex sha256, safe version charset)
     to reconstruct the expected archive name before use, and rejects
     symlinked manifest/archive files — no path-injection surface found."
  7. "No LaunchAgent was installed on this machine, no push/commit/model call
     was made, and the worktree was restored to a clean aff8bf1 (build/ output
     removed) at the end of the review."

## Owner correction — stable delivery directory

The owner rejected generated deliverables under `/private` and required the
complete bundle in `~/Dev/pxpipe-deploy`. The first accepted implementation's
`build/macos-local` default was therefore reopened as a delivery defect.

- Plan correction: `6acbd1f`.
- Stable-output implementation: `23b3618`.
- pnpm separator fix found by the real command: `ca598a0`.
- `package:macos-local` now requires `--output`, rejects `/private` and source
  worktree destinations before running the gate, resolves symlinks before
  publishing, stages beside the destination, replaces only its own three
  outputs, and preserves unrelated files in `pxpipe-deploy`.
- README commands now build, install, and uninstall through
  `~/Dev/pxpipe-deploy`.
- Guard proof removed the `/private` rejection: the focused suite failed, then
  passed after restoration.
- Restored verification: 803 tests, typecheck, build, and the real pnpm
  package command passed. `~/Dev/pxpipe-deploy/manifest.json` records source
  `ca598a0`; no generated `build/macos-local` directory remains.

### Reviewer comments — output correction r2

- Reviewer: Claude Code 2.1.206 / Sonnet 5 (`claude -p`, structured output),
  run with pxpipe bypassed in a stable disposable worktree.
- Reviewed SHA: `2d683da7f5477b886836e116b88692a86d8208b7`;
  base SHA: `5c26d446346a2ee9009eaf7798ec736052da7f28`.
- `guard_confirmed: true`.
- Verdict: **accepted** (2026-07-10 21:42 UTC), no material findings.
- The reviewer reproduced the full 803-test/typecheck/build gate, removed the
  `/private` rejection and observed the focused failure, restored it, and
  observed all 10 focused tests pass.
- A real package run to a disposable stable directory emitted a commit-bound
  archive, matching digest, manifest, and installer. Staging stayed beside the
  destination rather than under `/private`.
- Direct checks confirmed that a prior generated archive is removed, unrelated
  deploy files survive, source-worktree destinations are rejected, symlinks
  into `/private` are rejected after canonicalization, and both pnpm argument
  shapes work.
- Minor non-blocking observation: an interrupted three-file publish can leave
  an unreferenced archive, but the manifest always references a complete
  archive, so installer correctness and safety are unaffected.
- No real LaunchAgent, owner deploy directory, model call, push, or source
  worktree was touched during review; reviewer scratch was removed.
