# slice-1: Lossless Claude context partitioner

**Severity**: N/A — implementation slice under review, not a defect finding
**Status**: Verified
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
- Reviewer: codex-cli 0.144.1 (`codex exec --json --sandbox workspace-write`,
  prompt via stdin), disposable worktree `/private/tmp/pxpipe-review-slice1`.
- Reviewed SHA: `1d25d570a30f0e6e61130f99426548047686033e`;
  base SHA: `9f9a07c86c834cae29e5f263f85bb21248083874`.
- `guard_confirmed: true` — reviewer independently ran the revert→FAIL→
  restore→PASS proof (focused suite failed on missing module; full suite
  passed, 33 files / 665 tests at this SHA).
- Verdict: **reopened** (2026-07-10, ~05:25 UTC).
- Comments (verbatim):
  1. `src/core/anthropic-context.ts:146` — The parser absorbs an unknown
     sibling such as `# futureSibling\nopaque data` into `projectGuidance`
     instead of failing closed, so unknown host/runtime data can be treated
     as governance.
  2. `src/core/anthropic-context.ts:109` — The date recognizer validates
     only digit layout; an impossible date such as `2026-02-30` is accepted
     with `projectGuidance` populated and no uncertainty instead of leaving
     the malformed carrier native.
  3. `src/core/anthropic-context.ts:98` — Runtime recognition is explicitly
     deferred and every successful partition returns `runtimeMetadata: []`;
     an exact captured runtime tail therefore has no locator, leaving
     Slice 1's versioned runtime-recognizer deliverable absent.

## Coder adjudication
All three findings adjudicated **valid at the reviewed slice-1 SHA** and
**already resolved at the branch head** (`525cb5b`) by slice 3, verified two
ways on 2026-07-10:

1. Live probe against HEAD (`partitionAnthropicContext` via tsx):
   - baseline captured shape → `project: true`, runtime fields
     `[userEmail, currentDate]`;
   - `# futureSibling` unknown sibling → fail-closed (`project: false`,
     1 uncertain);
   - impossible date `2026-02-30` → fail-closed (`project: false`,
     1 uncertain).
2. Guarding tests exist at HEAD: `tests/anthropic-context.test.ts:225-250`
   ("impossible date", "unknown lowerCamel sibling" in the
   leaves-framing-unpartitioned matrix) and the runtime-recognizer cases.
   The unknown-sibling guard is `src/core/anthropic-context.ts:233-246`; the
   semantic date guard is `isExactCapturedDate`
   (`src/core/anthropic-context.ts:167-173`).

Finding 3 is additionally a **sequencing note**: the plan's Slice 1 bullet
("versioned exact project/runtime recognizers") overstated slice 1; v1
runtime recognition deliberately landed in slice 3, whose plan section and
characterization correction own that scope. No live defect.

Disposition: the `reopened` verdict required no new code — the fix-ups
already exist on the same branch (slice 3). Closure of this reopen is
delegated to the slice-3 review, which covers the commits containing the
guards. Slice-1 status stays "In progress" until the slice-3 verdict lands.

## Closure
Delivered by the slice-3 review chain (see
`.agents/review/findings/slice-3.md`): its r2 pass explicitly confirmed both
delegated guards at head — "Slice-1's impossible-date rejection is guarded
and passes at head" and the unknown-sibling rejection likewise (the CRLF gap
it found there was fixed in `c3e8744`) — and slice-3 closed **accepted** at
r3 on 2026-07-10. Finding 3 (runtime recognizer) was confirmed present by
the same review's guard proof (reverting src at the slice-3 SHA failed 15
runtime-partition assertions). **Slice-1 review closed.** Merge remains
owner-gated.
