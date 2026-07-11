# subscription-model-persistence: Persist the installed three-model scope

**Severity**: HIGH — the installed service visibly contradicted the owner's
explicit model selection and lost dashboard changes at restart
**Status**: Pending Claude review
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

## Known gaps

The currently installed bundle still records source `8dd128a` and therefore
does not yet contain this correction. Rebuild and reinstall only after
independent acceptance.

## Reviewer comments

Pending independent Claude review and guard proofs.
