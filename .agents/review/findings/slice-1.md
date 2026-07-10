# slice-1: Lossless Claude context partitioner

**Severity**: N/A — implementation slice under review, not a defect finding
**Status**: In progress
**Branch**: `fix/provenance-safe-compression`
**Commit**: `1d25d570a30f0e6e61130f99426548047686033e` (base: parent `9f9a07c`)

## Plan authority
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` §4.1 and §Slice 1 (approved
2026-07-10). Read the plan copy at the head SHA.

## What the slice claims
- New leaf module `src/core/anthropic-context.ts`: pure partitioner that
  locates the exact `# claudeMd` span inside the captured first-user
  context-reminder framing (Claude Code 2.1.205), with exact original-block
  reassembly.
- Versioned exact project/runtime recognizers; unknown, malformed, forged,
  and unsupported shapes fail closed (remain byte-exact native).
- Nested imported `AGENTS.md` H1s and forged `Contents of ...` lines are
  payload, not delimiters; trailer located from the end.
- `Message.role` in `src/core/types.ts` extended for the captured literal
  `system` role.
- Sanitized structural fixtures in `tests/fixtures/anthropic-context.ts`
  (synthetic payloads only; no proprietary prompt content).
- **No request behavior change yet** — no transform wiring in this slice.

## Files changed
- `src/core/anthropic-context.ts` (+272, new)
- `src/core/types.ts` (+5/-1)
- `tests/anthropic-context.test.ts` (+218, new)
- `tests/fixtures/anthropic-context.ts` (+99, new)

## Guard proof (reviewer must perform independently)
In your own disposable worktree at the head SHA:
1. Revert only the implementation: `git checkout 1d25d57^ -- src/` (this
   deletes `src/core/anthropic-context.ts` and restores old `types.ts`).
2. Run `npx vitest run tests/anthropic-context.test.ts` — it must FAIL
   (module missing).
3. Restore: `git checkout 1d25d57 -- src/`.
4. Run the full suite (`npm test`) — all tests must PASS.
Also verify round-trip losslessness assertions exist: non-selected content
and metadata byte-exact after reassembly.

## Known gaps
- Fixture `userEmail` framing was simplified in this slice and corrected in
  slice-3 (plan §Slice 3 characterization correction) — do not report that
  as a new finding here.
- No fixture can prove live Claude Code framing; the plan accepts versioned
  recognizers + fail-closed unknowns as the mitigation.

## Reviewer comments
(pending)
