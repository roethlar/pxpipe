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
(pending)
