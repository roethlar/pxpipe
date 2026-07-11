# subscription-model-persistence: Persist the installed three-model scope

**Severity**: HIGH — the installed service visibly contradicted the owner's
explicit model selection and lost dashboard changes at restart
**Status**: Verified — corrected bundle installed from `3e07e08`
**Branch**: `fix/provenance-safe-compression`
**Commits**: `7b7ac1c`, `d4f0b1d`, and `6cc440c`

## Plan authority

`docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md` records the owner's correction after
the first reviewed installation. The prior Fable-only installed-service choice
is superseded: the macOS login service must persist exactly Fable, Sol, and
Grok, and the dashboard must distinguish saved startup state from temporary
runtime changes.

## Evidence

- The installed LaunchAgent and generated installer contained only `HOST` and
  `PORT`, so `PXPIPE_MODELS` was absent and the built-in Fable-only fallback
  selected only Fable.
- `src/dashboard/fragments.ts` printed three environment-variable persistence
  warnings unconditionally, even when active and configured model sets
  matched.

## Predicted observable failure

After install or restart, only Fable is selected. Selecting Sol or Grok in the
dashboard is temporary, and the dashboard continues to demand an environment
setting even after the installer saves it.

## What changed

- `deploy/macos-local/install.sh` writes the exact fixed startup value
  `claude-fable-5,gpt-5.6-sol,grok-4.5`. It does not inherit an installer-shell
  override.
- `src/dashboard/fragments.ts` compares active and configured scopes as sets.
  A matching scope says `selection saved for restart`; a runtime difference
  says `runtime only · set PXPIPE_MODELS to persist`.
- `README.md` distinguishes the packaged three-model service from standalone
  runs' Fable-only built-in fallback.

## Guard proof

- Adding the exact LaunchAgent assertion made the installer test fail because
  `PXPIPE_MODELS` was missing. The test supplies ambient `PXPIPE_MODELS=off`;
  the fixed installer ignores it, writes the required exact value, and all ten
  installer tests pass.
- Adding the installed-scope dashboard test made it fail because no saved-state
  message existed and the unconditional warning remained. The fixed fragment
  shows Fable, Sol, and Grok selected with no persistence warning, then shows
  the warning after a runtime-only Grok toggle; all 36 dashboard tests pass.

## Verification

- `pnpm run typecheck`: passed.
- `pnpm test`: 819 passed.
- `pnpm run build`: passed; `--version` reports
  `0.8.0-provenance-safe.1`.
- No model call, installation, or push occurred during this correction.

## Installation verification

- Packaging from clean source `3e07e08b7126b9ec4274dec7aafe8584a91e8970`
  reran typecheck, all 819 tests, and build before writing the durable bundle
  directly to `~/Dev/pxpipe-deploy`.
- The deploy manifest and installed receipt match that source and archive
  digest.
- The LaunchAgent file and the running launch service both carry exact
  `PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol,grok-4.5`.
- Local GETs returned success for the dashboard and model fragment. Fable, Sol,
  and Grok were selected, `selection saved for restart` was present, and
  `set PXPIPE_MODELS` was absent.
- The service listens only on `127.0.0.1:47821`. No model call or push occurred.

## Reviewer comments

- Reviewer: Claude Code 2.1.206 / Sonnet 5 (`claude -p`, structured output),
  run with pxpipe bypassed in a disposable worktree under `~/Dev`.
- Reviewed SHA: `7416c94316e3b8eff839ddb4fdfbace860268db5`;
  base SHA: `262eecdae341cf0b1c760853b682e1d2131beb0e`.
- `guard_confirmed: true`.
- Verdict: **accepted** (2026-07-11 00:09 UTC), no material findings.
- Comments (verbatim):
  1. "Guard 1 (deploy/macos-local/install.sh:63): removed the
     `<key>PXPIPE_MODELS</key><string>$(xml_escape
     "$PERSISTED_MODELS")</string>` line — the named test 'installs a
     loopback-only service and passes its health check' failed exactly on the
     missing plist key; restored, and all 10 installer tests pass, including
     with `PXPIPE_MODELS=off` set both as the harness's ambient install-time
     env (tests/macos-local-installer.test.ts:190) and in my own shell —
     install.sh never reads $PXPIPE_MODELS at all, so the fixed
     PERSISTED_MODELS value (install.sh:10) cannot be overridden by any ambient
     value."
  2. "Guard 2 (src/dashboard/fragments.ts:137-155): reverted to the old
     unconditional per-section hint strings ('runtime only · persist with
     PXPIPE_MODELS', 'set PXPIPE_MODELS to persist' x2) — the named test 'shows
     the installed three-model scope as selected and saved until a runtime
     change' (tests/dashboard-api.test.ts:209) failed as predicted (missing
     'selection saved for restart'); restored, and all 36 dashboard tests
     pass. Verified directly: with
     PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol,grok-4.5 and no runtime override,
     the fragment shows 'Fable 5 ✓', 'GPT 5.6 Sol ✓', 'Grok 4.5 ✓', says
     'selection saved for restart', and contains no 'set PXPIPE_MODELS' text;
     toggling grok-4.5 off at runtime (handleModelsToggle) brings the 'runtime
     only · set PXPIPE_MODELS to persist' warning back — matches
     src/core/applicability.ts's per-call env read
     (getConfiguredModelBases/getAllowedModelBases), so the scope comparison
     is live, not cached."
  3. "Full gate: pnpm run typecheck (clean), pnpm test (819/819 passed), pnpm
     run build (clean, --version reports 0.8.0-provenance-safe.1) all pass. One
     transient failure appeared on the first `pnpm test` run
     (tests/provenance-ab-collect.test.ts 'validates the selected source before
     prepare-only can succeed', expecting a non-git directory probe to fail) —
     root-caused to this reviewer session's TMPDIR
     (/Users/michael/Dev/pxpipe/.codex/review-tmp) being nested inside the
     coder's own git working tree, so git's upward .git discovery found a repo
     where the test expected none. Confirmed by rerunning with TMPDIR pointed
     outside any repo: the single test and the full suite both pass (819/819).
     This is a pre-existing environment artifact unrelated to the reviewed
     diff (eval/provenance-ab/ is untouched by this diff) and not a defect in
     the reviewed change."
  4. "README.md and docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md were checked for
     stale Fable-only installed-service claims: none found. Both consistently
     distinguish the installed macOS service (persists Fable+Sol+Grok,
     README.md:85-87,103) from standalone/source runs (Fable-only built-in
     default, README.md:227-230), and the plan's 'Owner correction' section and
     'Boundaries' section agree with the shipped code (no persistent
     login/provider-routing config, only the three-model compression scope)."
  5. "Worktree confirmed clean and at the reviewed head after the full run
     (git status --short empty; only gitignored dist/ and node_modules/
     present); no commit, push, merge, install, or model call was made."

The coder worktree's complete gate also passed all 819 tests before dispatch.
