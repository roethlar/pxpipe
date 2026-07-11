# context-correction-slice-2: Anthropic exact in-place compression

**Severity**: HIGH — the installed Anthropic path could move host metadata,
insert proxy-authored instructions, invalidate message role order, and admit
requests that cost more after cache pricing.
**Status**: Verified — independently accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `5b98406c450eab5a841741480109806fda239c64` (base: parent
`911a7811371db57b2d1cf0b5f4e5a42c6fb9df17`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`, approved and independently accepted
through r3. This record covers implementation Slice 2 only. OpenAI defaults,
incident follow-ons, packaging, installation, push, and merge are out of scope.

## Evidence

- The owner-provided incident recorded in the plan observed runtime metadata
  fused to live prose and a 400 after history collapse left a literal `system`
  message before a synthetic `user` message.
- The pre-slice active Anthropic path called project placeholder/manifest,
  history collapse, tool-reference, runtime-tail, reflow, factsheet, paging, and
  truncation helpers before Slice 1 rejected the candidate at final admission.
- Slice 1 deliberately supplied `changedSpanCache: [{ kind: 'unknown' }]`, so no
  safe Anthropic candidate could pass the authoritative request-wide gate.
- During coder audit, three additional observable gaps were reproduced before
  correction: unknown exact identifiers were imaged, the 100-image ceiling
  greedily selected only a subset of eligible buckets, and prefix probes omitted
  `tool_choice`, `thinking`, and `mcp_servers`.

## Predicted observable failure

Without this slice, enabling Anthropic compression either remains wholly native
or re-enables the old context rewrite. Re-enabling it can move email/date text,
add model-readable proxy claims, synthesize invalid history roles, truncate tool
output, silently drop glyphs, select only a profitable-looking subset, or admit a
cache-aware loss because the candidate and its prefix were not measured exactly.

## What

Anthropic now builds one candidate from only two same-container operations: an
exact recognized project-guidance substring in its original user text block, and
complete exact plain-prose text inside a successful `tool_result`. Every prefix,
suffix, role, message, container, cache marker, and unrelated caller value stays
in place. The candidate contains unlabeled images and no proxy-authored text.

## Approach

`src/core/render.ts` adds a source-span-preserving single-column renderer that
never minifies, reflows, labels, truncates, or normalizes and reports every
unrenderable codepoint. `src/core/anthropic-exact.ts` applies all original-coordinate
splices atomically and emits final-coordinate no-hijack descriptors. The active
Anthropic orchestration in `src/core/transform.ts` no longer calls runtime,
history, reminder, tool-reference, factsheet-emission, paging, or per-bucket
profitability paths. `src/core/measurement.ts` binds every changed source to the
caller's final cache marker, and `src/core/proxy.ts` supplies the descriptors and
coverage to Slice 1's four-probe admission transaction.

Structured data, logs, recognized or explicitly labelled identifiers, mixed
alphanumeric tokens, and long opaque blobs remain native. Per-result overflow is
native; request-wide overflow aborts the whole candidate rather than selecting a
subset. Failed or uncertain provider measurements forward the exact original
bytes.

## Files changed

- `src/core/anthropic-exact.ts`, `src/core/no-hijack.ts` — atomic exact splices,
  final descriptor coordinates, cache-marker ownership, and multi-part
  normalization.
- `src/core/render.ts`, `src/core/transform.ts` — exact renderer and the safe
  Anthropic candidate builder; legacy flags are inert on the active path.
- `src/core/measurement.ts`, `src/core/proxy.ts` — changed-span cache coverage,
  complete prefix controls, descriptors, four-probe admission, and admitted
  prefix digest.
- Anthropic transform, role, history, paging, cache, proxy, renderer,
  recoverability, and adversarial suites — safe-default guards and removal of
  obsolete unsafe expectations.

## Guard proof

Coder evidence before the implementation landed:

- With the new active-path history guards present and the old transform still in
  place, `tests/history.test.ts` failed both exact-message guards while its sixty
  pure history utility tests passed. The old path inserted a synthetic user and
  changed the reported `[user, system, assistant]` sequence.
- Audit fixtures independently observed unknown `job_id=qz91lm2n` output being
  imaged, two eligible tool results being greedily split at the global image
  ceiling, and cache-prefix bodies dropping all three accepted top-level controls.
  Each matching focused guard passes at the implementation commit.

Independent reviewer proof in a disposable worktree should at minimum:

1. Check out the reviewed head, then replace only `src/core/transform.ts` with
   `911a7811371db57b2d1cf0b5f4e5a42c6fb9df17` and run
   `pnpm exec vitest run tests/history.test.ts`. The two active-path exact-history
   guards must fail.
2. Restore `src/core/transform.ts`, replace only `src/core/proxy.ts` with the base
   version, and run
   `pnpm exec vitest run tests/cache-stability-e2e.test.ts tests/proxy-usage.test.ts`.
   The safe admitted-candidate/four-probe guards must fail.
3. Restore the reviewed head, confirm the worktree is clean, then run
   `pnpm run typecheck && pnpm test && pnpm run build` (using the pinned npx pnpm
   fallback when pnpm is off PATH). It must pass.

The final coder gate passed typecheck, all 866 tests, and the production build.
The bundled Node path contains none of the legacy Anthropic runtime label,
manifests, project placeholder, boundary, or synthetic-history prose.

## Coder dispute (if any)

Empty.

## Known gaps

- OpenAI Chat and Responses retain their prior context transformer until Slice 3.
- Explicit ANSI/CSI preflight and cross-request model/source isolation are Slice 4;
  the exact renderer already rejects any candidate with a missing control glyph.
- Private dead legacy Anthropic helpers remain temporarily for source compatibility
  but are unreachable from `buildAnthropicCandidate`; the bundled Node path
  tree-shakes their proxy prose.
- No live model call, subscription smoke, package build/install, push, merge, or
  paused one-port routing work is authorized by this review.

## Reviewer comments

- R1 (2026-07-11T03:08:16Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-context-correction-s2-r1`.
  - Reviewed SHA: `1ec9f280efbb711a6341b0a5442ab74b96cbc18c`.
  - Base SHA: `911a7811371db57b2d1cf0b5f4e5a42c6fb9df17`.
  - `guard_confirmed: true` — the reviewer independently observed the named
    transform and proxy reversions fail their focused guards, restored the
    reviewed head, and completed the post-restore typecheck, full test suite,
    and production build.
  - Verdict: **accepted**.
  - Comments: none.

The JSON envelope exited zero, matched the required schema, and returned the
pinned SHAs. The disposable worktree was tracked-clean after restoration; its
only untracked entry was the temporary `node_modules` symlink used for the gate.
Acceptance does not authorize installation, live product calls, push, merge, or
the paused routing work.
