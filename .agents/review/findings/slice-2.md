# slice-2: Role-bound project-guidance transform

**Severity**: N/A — implementation slice under review, not a defect finding
**Status**: In progress
**Branch**: `fix/provenance-safe-compression`
**Commit**: `fbf9b0c6aec9696ca65974978c6d57f4d2574467` (base: parent `1d25d57`)

## Plan authority
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` §4.2, §4.5 (partial), §Slice 2.

## What the slice claims
- Native system manifest vouches for role-bound project-guidance pages;
  image labels are inert (`PROJECT GUIDANCE · ref <id>`), no self-attestation.
- Deterministic reference/page-count/position binding; pages sit before the
  caller-owned live-prompt cache marker; marker count never increases.
- One exported boundary constant/helper shared by every emitter/detector in
  `transform.ts` and `history.ts`; no duplicated marker literal.
- Only the selected `claudeMd` span becomes an inert placeholder; reminder
  wrapper, siblings, and live user block stay verbatim.
- Legacy monolithic system/tool slab and stubs do not run on the safe default
  path; base/unknown system content and tools stay native.
- Generic/unknown reminders stay native; the recognized project carrier
  cannot enter generic reminder compression.
- History collapse cannot absorb or detach the vouched-for leading range;
  protection extends through contiguous leading `role: "system"` attachments;
  privileged role inside a later collapse range fails closed.
- `cachePrefixDigest`, `historyImageSha8`, `firstUserSha8` use the shared
  boundary/synthetic marker/live-user position.
- Gate/render failure restores the original request region byte-exact.

## Files changed
- `src/core/transform.ts` (major rework, ±1710)
- `src/core/history.ts` (+210)
- `src/core/render.ts` (±20)
- `tests/anthropic-role-integrity.test.ts` (+368, new)
- Updated: render, design-behavior-e2e, history, anthropic-cache-align,
  cache-stability-e2e, keep-sharp, proxy-usage, public-api, savings-math-e2e
  tests.

## Guard proof (reviewer must perform independently)
In your own disposable worktree at the head SHA (`fbf9b0c`):
1. Revert implementation only, keep new tests:
   `git checkout fbf9b0c^ -- src/`
2. Run `npx vitest run tests/anthropic-role-integrity.test.ts` — must FAIL
   (legacy transform: native system text leaves `system`, no manifest,
   wholesale reminder imaging, tool docs in the slab).
3. Restore: `git checkout fbf9b0c -- src/`.
4. Run the full suite at this SHA — must PASS (note: full-suite count at this
   SHA predates slices 3–4; expect all green, not necessarily 748).
Check specifically for a history-collapse case using the shared marker and
system-role protection, and that no duplicated boundary literal survives
(`grep` for the old literal in both files).

## Known gaps
- §4.3 runtime metadata and §4.4 tool bucket land in slices 3–4; their
  absence here is by design.

## Reviewer comments
- Reviewer: codex-cli 0.144.1 (`codex exec --json --sandbox workspace-write`,
  prompt via stdin), disposable worktree `/private/tmp/pxpipe-review-slice2`.
- Reviewed SHA: `fbf9b0c6aec9696ca65974978c6d57f4d2574467`;
  base SHA: `1d25d570a30f0e6e61130f99426548047686033e`.
- `guard_confirmed: true` — reviewer ran the revert→FAIL→restore→PASS proof
  (all 9 role-integrity tests failed with `src/` reverted; full suite passed
  restored at the reviewed SHA).
- Verdict: **reopened** (2026-07-10, ~05:45 UTC).
- Comments (verbatim):
  1. `src/core/transform.ts:718` — With a project ref, the synthetic-history
     scan starts at msgs.length and never runs. Reproduced marked
     collapsed-history changes altering historyImageSha while cachePrefixSha8
     stayed unchanged at the earlier project boundary, so the claimed exact
     cache-boundary digest cannot diagnose those cache busts.
  2. `src/core/history.ts:372` — typedUserText accepts the genuine project
     boundary in every collapsed user message rather than only the vouched
     opening range. A later copied same-ref marker after the latest task made
     the synthetic recency pointer select an older user turn, so copied
     identifiers are not inert and current-task context is misidentified.
  3. `src/core/history.ts:262` — messageCacheControl retains only the last
     block marker and loses its block position before collapse re-emits it
     after the full message. A valid message with two marked text blocks
     reproduced a 2-to-1 marker loss; a non-final marker also moves across
     later content, changing caller-owned breakpoint and TTL semantics.

## Coder adjudication
Adjudicated 2026-07-10 against the branch head. All three findings valid at
the reviewed slice-2 SHA; dispositions differ:

1. **Fixed at head by slice 4, guarded.** `cachePrefixDigest`
   (`src/core/transform.ts:770-869`) now scans all messages for the marked
   synthetic-history image; a caller-owned history boundary wins over the
   earlier project boundary. Guard:
   `tests/anthropic-tool-adversarial.test.ts:278` ("selects a later
   caller-owned history boundary over an earlier project boundary",
   asserting `cacheBoundaryKind: 'history'` and the digest through the
   marker). No further action.
2. **Live at head — fixed now, commit `371322d`.** Verified the repro shape:
   a text block equal to the genuine boundary (`makeProjectGuidanceBoundary(ref)`)
   placed AFTER the typed task text in a later collapsed user turn emptied
   `typedUserText` and rolled the recency pointer to an older turn.
   Fix binds the boundary/carrier rules to absolute message index 0 in
   `latestCollapsedUserPointer` and `demoteProtectedHeadText`. Guard test
   red before fix, green after; full suite 749 green + typecheck + build.
3. **Fixed at head by slice 4, guarded.** Multiple caller markers in one
   collapse-range message fail the bucket closed
   (`ambiguous_cache_markers_in_collapse_range`, `src/core/history.ts:659`)
   and a rendered-marker mismatch fails closed (`cache_marker_mismatch`,
   `src/core/history.ts:797`). Guards: `tests/history.test.ts:564,611`.
   Positional note: within a single-marker collapsed message the marker is
   re-planted at the collapsed chunk end — the plan's slice-4 contract
   promises count/value preservation, not intra-message positional fidelity;
   treated as within-contract.

Disposition: findings 1 and 3 closed by existing slice-4 code+guards;
finding 2 closed by fix commit `371322d`. Focused re-review of the fix-up
dispatched per the playbook's reopened flow.

Re-review dispatch log:
- r2 attempt 1 (2026-07-10 ~05:38 UTC): failed before any review work —
  codex returned `turn.failed: usage limit` (resets ~06:52 UTC). Recorded
  fail-closed as a harness failure, NOT a verdict. Re-dispatch queued for
  after the reset.
