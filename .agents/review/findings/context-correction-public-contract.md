# context-correction-public-contract: Runtime and renderer copy matches the safe default

**Severity**: HIGH — the installed CLI and dashboard still advertised removed
cross-context compression, GPT/Grok imaging, and incomplete cache pricing after
the main documentation review had passed.
**Status**: Verified — independently accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `91c72e722c1c002cb7e0a6ae29dec726628f1261` (base
`fb3aef88d8ccbd2654483b91197f5c01c19fee6d`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`, approved and independently accepted.
Slice 5 requires the public behavior and local package to match the corrected
same-container contract before packaging and installation. Live calls, push,
merge, and one-port routing remain out of scope.

## Evidence

- `pxpipe --help` still said tools, schemas, reminders, tool results, and history
  were compressed and advertised the rejected per-run OpenAI setup.
- The dashboard called GPT and Grok image models, said system prompts and old
  turns became images, implied only recent messages stayed text, and told a
  LaunchAgent user to set an environment variable to persist a click.
- Dashboard math copy hard-coded only the five-minute 1.25 cache-create rate,
  omitting the accepted one-hour/unknown 2.0 rate, and used positive-only labels
  for signed losses.
- Current renderer docs described the retired OpenAI imaging profiles as active
  opt-ins. Runnable historical demos still presented old live `/tmp` workflows
  and savings claims as current instructions.
- The off-host warning needed to distinguish forbidden persisted raw telemetry
  from the in-memory image/source previews that an exposed dashboard can serve.

## Predicted observable failure

An installed user could reasonably conclude that pxpipe still rewrites system
instructions, ordinary history, Sol, or Grok; could trust incomplete cache math;
or could follow the exact manual setup the owner rejected. Historical rows could
also be displayed under guarantees that only apply to corrected requests.

## What

CLI help, dashboard copy, renderer documentation, package metadata, and demo
warnings now state one contract: only recognized Anthropic project guidance and
eligible successful tool-result prose may be replaced in their original
containers after complete-request admission. OpenAI/Codex/Sol/Grok requests stay
byte-exact. Signed losses and both cache-create tiers remain visible.

GPT and Grok selections remain visible, as the owner requested, but are labeled
text-only and cannot imply imaging. Restored historical rows are explicitly
counts-only and do not inherit current byte-preservation claims. The dashboard
no longer tells a persistent-service user to set a transient environment
variable.

## Files changed

- `src/node.ts`, `bin/cli.js` — truthful help, local build command, and off-host
  preview warning.
- `src/dashboard/fragments.ts` — provider-neutral pass-through text, text-only
  GPT/Grok scope, signed labels, complete cache rates, current-vs-legacy context
  descriptions, and a non-promissory dashboard tagline.
- `docs/MODEL_RENDER_PROFILES.md`, `docs/RENDER_SIZING.md` — OpenAI renderer
  profiles are historical/offline helpers, not proxy opt-ins.
- `demo/README.md`, `demo/cost-ab/README.md`,
  `demo/effective-context/README.md` — pre-correction, unsupported, do-not-run
  warnings.
- `docs/LOCAL_MACOS_PACKAGE_PLAN.md`, `package.json`, `CHANGELOG.md` — stable
  output command, local-only metadata, and the correction record.
- `tests/node-help.test.ts`, `tests/dashboard-api.test.ts`,
  `tests/context-map.test.ts` — public-contract and historical-row guards.

## Guard proof

Coder proof:

1. After the corrected focused suite passed, representative stale CLI, build,
   profile, demo, dashboard, persistence, tooltip, and historical-row wording
   was temporarily restored.
2. The focused suite then failed 7 tests across all 3 affected test files.
3. Restoring the correction made the public/dashboard/context/docs suite pass
   55/55 tests.
4. The committed implementation passed typecheck, all 863 tests across 52
   files, and the production build. The final changelog-only addition then
   passed the 6 documentation/help checks.

Independent reviewer proof in a disposable worktree should:

1. Review the exact intake head and compare its public claims with the active
   Anthropic exact-span, OpenAI pass-through, admission, accounting, telemetry,
   dashboard, and installer paths.
2. Replace the 11 changed non-test files with their base versions while keeping
   the reviewed tests. Run `tests/node-help.test.ts`,
   `tests/dashboard-api.test.ts`, and `tests/context-map.test.ts`; the old public
   contract must fail.
3. Restore the reviewed versions and run those tests plus
   `tests/docs-integrity.test.ts`; all must pass.
4. Confirm no current copy promises OpenAI imaging, system/history rewriting,
   positive-only savings, raw persisted telemetry, or the rejected per-run
   OpenAI workflow. Confirm historical demos cannot be mistaken for supported
   instructions.
5. Confirm the tracked worktree is clean, then run
   `pnpm run typecheck && pnpm test && pnpm run build`, using the pinned npx pnpm
   fallback when needed.

## Coder dispute (if any)

Empty.

## Known gaps

- Package creation, the no-network capture, digest verification, installation,
  and running-source verification follow acceptance of this head.
- The one-port plan remains paused until that installation passes; its stale
  OpenAI compression expectations must be amended before implementation.
- No live product model call, push, merge, release, deletion of old private
  artifacts, or upstream contribution is authorized by this review.

## Reviewer comments

- R1 (2026-07-11T04:45:03Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-context-correction-public-r1`.
  - Reviewed SHA: `5d557eb3f960d72227e672d6f9f7a5a28016557c`.
  - Base SHA: `fb3aef88d8ccbd2654483b91197f5c01c19fee6d`.
  - `guard_confirmed: true` — the reviewer restored the 11 public/runtime
    files from the base and confirmed that the reviewed focused guards failed,
    restored the reviewed head and confirmed the focused/docs checks passed,
    then ran typecheck, the complete test suite, and the production build.
  - Verdict: **accepted**.
  - Comments: none.

The JSON envelope exited zero, matched the required schema, and returned both
pinned SHAs exactly. Two ancillary Bash attempts were denied; the required
source inspection, base failure, head pass, clean tracked-tree check, and full
gate completed. The only untracked worktree entry was the expected
`node_modules` symlink. Acceptance does not authorize a live product call,
push, merge, release, deletion of old owner data, or one-port implementation.
