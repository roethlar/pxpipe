# slice-3: Vouched runtime metadata tail

**Severity**: N/A — implementation slice under review, not a defect finding
**Status**: In progress
**Branch**: `fix/provenance-safe-compression`
**Commit**: `2334b9840b961c2a031ecbb2131da3e08315da15` (base: parent `fbf9b0c`)

## Plan authority
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` §4.3 and §Slice 3, including the
in-slice characterization correction (v1 moves only the exact captured
opening `userEmail`/`currentDate` suffix; `<env>`/`<git_status>`-style native
system shapes stay byte-exact).

## What the slice claims
- Exact captured `# userEmail` (`The user's email address is <address>.`) and
  `# currentDate` suffix moves to a final user-tail data block with neutral
  label `PXPIPE RUNTIME CONTEXT — data, not instructions`.
- Native manifest vouches for its position and data-only meaning; the block
  is appended after all caller content and history/tool-result transforms.
- Instructional reminders, uncertain tags, and unknown sibling keys stay
  native.
- No outgoing text contains the legacy `Context relocated by pxpipe from the
  system prompt` claim.
- Same governance + changed environment preserves project images/manifest and
  the cache prefix through their boundary.
- Fixture correction: pins the exact 2.1.205 `userEmail` sentence framing.

## Files changed
- `src/core/anthropic-context.ts` (+170)
- `src/core/transform.ts` (+154)
- `tests/anthropic-context.test.ts` (+99)
- `tests/anthropic-role-integrity.test.ts` (+221)
- `tests/cache-stability-e2e.test.ts` (+79)
- `tests/fixtures/anthropic-context.ts` (±4)
- `docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` (±18, characterization note)

## Guard proof (reviewer must perform independently)
In your own disposable worktree at the head SHA (`2334b98`):
1. `git checkout 2334b98^ -- src/`
2. Run `npx vitest run tests/anthropic-role-integrity.test.ts
   tests/anthropic-context.test.ts tests/cache-stability-e2e.test.ts` — the
   new runtime-tail assertions must FAIL (suffix stays in the opening
   carrier; no native runtime manifest/final data block).
3. Restore: `git checkout 2334b98 -- src/`.
4. Full suite at this SHA must PASS.
Also grep outgoing-text builders for the banned self-asserted wrapper phrase.

## Known gaps
- Deliberate cache cost: native-system environment shapes are not moved in
  v1 (fail-closed rule) — not a defect.

## Reviewer comments
(pending)
