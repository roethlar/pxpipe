# context-correction-slice-1: Shared no-hijack and no-loss admission

**Severity**: HIGH — the installed path could move trusted context, emit an
invalid Anthropic role sequence, and spend more effective input tokens than the
unchanged request.
**Status**: Verified — independently accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `a0386b6d8be76913e34d298cc27902e4c931cc1c` (base: parent
`b2a5389555d531cc880db76a296e5924d4d67afb`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`, approved and independently accepted
through r3. This is implementation Slice 1 only. The paused one-port routing
work is out of scope.

## Evidence

- The owner-provided installed-session report and live 400 are recorded in the
  plan: runtime metadata was moved beside live user prose, generated manifests
  asserted trust/priority, and history collapse left a literal `system` message
  before a synthetic `user` message.
- The installed dashboard measured 155k effective input tokens through pxpipe
  versus 147k unchanged. Existing accounting assumed every cache creation cost
  1.25 and accepted incomplete probe evidence.
- The pre-slice proxy performed only original full/prefix probes after building
  and forwarding a candidate; it had no final no-hijack comparison, candidate
  probes, provider role-order validation, or Node negative-result breaker.

## Predicted observable failure

Without this slice, the shipped proxy can forward a request containing moved or
proxy-authored text, reproduce the observed Anthropic 400, admit a complete
request that is more expensive after cache pricing, or report divergent savings
between live, replay, sessions, and statistics.

## What

The slice adds a fail-native shell around the existing Anthropic candidate. A
candidate must preserve every caller text atom and structure except explicitly
described same-container exact-span image replacements, pass final Anthropic role
validation, lose no rendered codepoints, and beat four complete-request token
measurements by both 10% and 256 effective tokens. Until Slice 2 emits proven
replacement descriptors, the old candidate is rejected byte-for-byte native.

## Approach

`src/core/no-hijack.ts` inventories and compares model-visible text for all three
provider shapes and validates the only permitted Anthropic exact-span image
replacement. `src/core/admission.ts` performs final structure validation,
four-probe cache-tier pricing, and exact-original rollback in Workers-safe code.
`src/core/proxy.ts` applies that transaction before forward. The Node host adds an
exact-fingerprint in-flight lock and negative-result breaker; Worker safety still
comes from per-request admission. `src/core/baseline.ts` is now the single signed
accounting implementation used by live dashboard, replay, session, and statistics
consumers.

## Files changed

- `src/core/no-hijack.ts`, `src/core/admission.ts`, `src/core/measurement.ts` —
  model-visible inventory, exact-span contract, provider validation, four probes,
  cache tier, and strict reserves.
- `src/core/proxy.ts`, `src/core/transform.ts`, `src/node-admission.ts`,
  `src/node.ts` — fail-native forwarding shell, standalone-library fallback, and
  Node coordination.
- `src/core/baseline.ts`, `src/core/tracker.ts`, `src/dashboard.ts`,
  `src/sessions.ts`, `src/stats.ts`, dashboard fragments/types — shared tier-aware
  signed accounting and persisted evidence.
- `tests/admission.test.ts`, `tests/no-hijack.test.ts`,
  `tests/transform-admission.test.ts`, `tests/node-admission.test.ts`, and updated
  proxy/accounting suites — behavioral guards and obsolete-assumption removal.

## Guard proof

In a disposable worktree at the reviewed head:

1. Revert only the proxy integration:
   `git checkout b2a5389555d531cc880db76a296e5924d4d67afb -- src/core/proxy.ts`.
2. Run
   `npx -y -p pnpm@10.21.0 pnpm exec vitest run tests/proxy-usage.test.ts tests/cache-stability-e2e.test.ts`.
   It must fail the exact-native, contract-first, and zero-probe guards.
3. Restore `src/core/proxy.ts` from
   `a0386b6d8be76913e34d298cc27902e4c931cc1c`.
4. Revert the accounting implementation and consumers:
   `git checkout b2a5389555d531cc880db76a296e5924d4d67afb -- src/core/baseline.ts src/core/tracker.ts src/dashboard.ts src/sessions.ts src/stats.ts`.
5. Run
   `npx -y -p pnpm@10.21.0 pnpm exec vitest run tests/baseline.test.ts tests/dashboard-api.test.ts tests/sessions.test.ts tests/stats.test.ts tests/tracker.test.ts`.
   It must fail the strict-status and 5m/1h/unknown signed-accounting guards.
6. Restore those files from the reviewed head, confirm the worktree is clean, then
   run `pnpm run typecheck && pnpm test && pnpm run build` (using the pinned npx
   pnpm fallback when pnpm is off PATH). It must pass.

Also inspect the focused assertions: the current legacy candidate is proven to
contain its old generated manifests/runtime tail before the proxy test proves it
was rejected; this prevents a vacuous fixture that never built the unsafe shape.

## Coder dispute (if any)

Empty.

## Known gaps

- Slice 1 intentionally leaves all existing Anthropic image candidates native;
  Slice 2 must emit only exact in-place project/tool-result replacements plus
  cache-coverage descriptors before compression can resume.
- OpenAI Chat and Responses still use their prior transformer until Slice 3.
- ANSI/CSI preflight and full top-level model parsing are Slice 4.
- No live model call, subscription smoke, package install, push, or merge is
  authorized by this review.

## Reviewer comments

- R1 (2026-07-11T02:18:03Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-context-correction-s1-r1`.
  - Reviewed SHA: `717464e451deeb1bab97307275bd23fd19eb509b`.
  - Base SHA: `b2a5389555d531cc880db76a296e5924d4d67afb`.
  - `guard_confirmed: true` — the reviewer independently observed both named
    source reversions fail their focused guards, restored the reviewed head,
    and completed the post-restore gate.
  - Verdict: **accepted**.
  - Comments: none.

The JSON envelope exited zero, matched the required schema, and returned the
pinned SHAs. Six ancillary compound diagnostic Bash attempts (`ls`/`stat`/`echo`
combined with other commands) were denied by the narrow allowlist; none was a
required revert, focused test, restore, or final gate command, and the structured
guard result completed successfully. Acceptance does not authorize installation,
live product calls, push, merge, or the paused routing work.
