# local-macos-package: Loopback-only macOS package and installer

**Severity**: N/A — owner-approved implementation slice, not a defect finding
**Status**: In progress
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

Pending independent Claude review.
