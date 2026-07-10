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
- Reviewer: codex-cli 0.144.1 (`codex exec --json --sandbox workspace-write`,
  stdin prompt), disposable worktree `/private/tmp/pxpipe-review-slice3`.
- Reviewed SHA: `2334b9840b961c2a031ecbb2131da3e08315da15`;
  base SHA: `fbf9b0c6aec9696ca65974978c6d57f4d2574467`.
- `guard_confirmed: true` — reviewer ran the revert→FAIL→restore→PASS proof
  (15 focused failures reverted, including missing runtime partition
  metadata, missing native runtime manifest/tail, suffix left in the opening
  carrier; full suite 34 files / 698 green restored).
- Verdict: **reopened** (2026-07-10 ~09:20 UTC). Comment (verbatim):
  1. "src/core/anthropic-context.ts:238 — The unknown-sibling guard inspects
     only the last H1 before the runtime suffix. A multiline `# futureSibling`
     value containing a later `# Notes` bypasses it; reproduced output imaged
     the unknown instructional bytes and removed them from native text,
     violating the byte-exact fail-closed contract."

## Coder adjudication
**Accepted.** Reproduced the evasion at branch head with a live probe: the
`# futureSibling` bytes appeared inside `projectGuidance.text` (imaged as
governance) with runtime fields still recognized — exactly the fail-closed
violation the plan's §4.1 invariant forbids.

Fixed in commit `ee992d3`: the guard now refuses the partition when ANY
unrecognized lowerCamelCase H1 appears before the runtime suffix (the
structural `# claudeMd` at slice position 0 is skipped by the \n-anchored
pattern; `userEmail`/`currentDate` remain payload-eligible because their
exact-valid duplicates are refused separately; the `attachedProject` special
case is subsumed). Conservative direction: payloads using lowerCamel H1
headings now fall back to native — never dropped or elevated. Guard test red
before/green after; 751 tests, typecheck, build all clean. Focused r2
re-review dispatched on the fix; slice-1's delegated closure rides on the
same verdict (its findings were fixed by this slice's code).

- r2 (2026-07-10 ~09:35 UTC, codex-cli 0.144.1, reviewed SHA
  `ee992d3be0eda714dbd688ea16185b9f5afc0b0c`, base `38a08ba`): **reopened**,
  `guard_confirmed: true`. Reviewer verified the r1 closure (guard red
  against parent, 29/29 restored; its own repro fails closed) and confirmed
  slice-1's delegated closures (impossible-date and LF unknown-sibling both
  guarded at head). Its adversarial probing found one residual evasion —
  verbatim: "src/core/anthropic-context.ts:239 — A CRLF-terminated
  `# futureSibling` is captured as `futureSibling\r`, bypassing the
  lowerCamel check. The r1-shaped probe still produced projectGuidance/
  runtime partitions, and the transform removed the unknown bytes from
  native output. Normalize CRLF and add a regression guard."
- Adjudication: **accepted** — CRLF repo files embed verbatim in the
  LF-framed bundle, so mixed EOLs are realistic; LF/CRLF must behave
  identically. Fixed in commit `c3e8744` (strip trailing `\r` from the H1
  capture before the lowerCamel test). Guard red before/green after;
  752 tests, typecheck, build all clean. r3 dispatched.
