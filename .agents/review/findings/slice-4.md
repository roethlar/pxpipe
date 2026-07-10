# slice-4: Independent tool bucket, per-bucket telemetry, host wiring

**Severity**: N/A — implementation slice under review, not a defect finding
**Status**: Verified
**Branch**: `fix/provenance-safe-compression`
**Commit**: `525cb5bce12c0089c657a8238278da5e523c3bf8` (base: parent `2334b98`)

## Plan authority
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` §4.4, §4.5, §4.6 and §Slice 4,
including the in-slice characterization correction (transaction order:
project guidance → closed history → surviving live-tail tool results →
optional tool reference → runtime tail; shared recursive 100-image budget;
one caller cache marker per collapsed message; JSON-escaped ordinal
per-entry digest framing for tool stubs).

## What the slice claims
- Native tools are the safe default on Node, Worker, and library paths;
  Anthropic `compressTools`/generic `compressReminders` default `false`;
  `compressProjectGuidance` default `true`.
- Experimental image tools: separate manifest/gate/reference; stubs installed
  only after successful rendering; tool gate failure leaves original tool
  definitions byte-exact.
- No double counting; project and tool profitability independent; tool size
  cannot rescue an unprofitable project render.
- Cache marker count never increases; caller marker ownership preserved,
  including markers nested in tool-result content; marker mismatch fails the
  history bucket closed.
- Worker omits provider-specific option properties when env vars are unset —
  Anthropic tool default off must not disable OpenAI's independent tool
  compression default.
- Session/dashboard/stats warmth identity prefers
  `cache_prefix_sha8 ?? system_sha8`; new telemetry fields optional and
  backward-compatible with old event rows; telemetry omits source text.

## Files changed
- `src/core/transform.ts` (+762), `src/core/tracker.ts` (+254),
  `src/core/history.ts` (±60), `src/core/baseline.ts`,
  `src/core/schema-strip.ts`, `src/core/library.ts`
- Hosts: `src/node.ts`, `src/worker.ts`, `src/sessions.ts`,
  `src/dashboard.ts`, `src/dashboard/fragments.ts`, `src/stats.ts`
- Tests: `tests/anthropic-tool-adversarial.test.ts` (+563, new),
  `tests/anthropic-tool-reference.test.ts` (+332, new), role-integrity
  updates, plus tracker/proxy-usage/render/cache-align updates
- Docs touched: `docs/CACHING_AND_SAVINGS.md`, `docs/TRANSFORM_INFO.md`,
  plan checkpoint

## Guard proof (reviewer must perform independently)
In your own disposable worktree at the head SHA (`525cb5b`):
1. `git checkout 525cb5b^ -- src/`
2. Run `npx vitest run tests/anthropic-tool-reference.test.ts
   tests/anthropic-tool-adversarial.test.ts` — must FAIL (defaults/bucket
   isolation absent in the reverted implementation).
3. Restore: `git checkout 525cb5b -- src/`.
4. Full suite must PASS: expected 748 tests, plus `npm run typecheck` and
   `npm run build` clean (this is the branch head — final checkpoint state).

## Known gaps
- Slice 5 (docs/migration/eval harness) not yet landed; TRANSFORM_INFO and
  CACHING_AND_SAVINGS received only contract-critical touches here.
- Live A/B matrix (plan §7) is separately owner-gated and has NOT run.

## Reviewer comments
- Reviewer: codex-cli 0.144.1 (`codex exec --json --sandbox workspace-write`,
  stdin prompt), disposable worktree `/private/tmp/pxpipe-review-slice4`.
- Reviewed SHA: `525cb5bce12c0089c657a8238278da5e523c3bf8`;
  base SHA: `2334b9840b961c2a031ecbb2131da3e08315da15`.
- `guard_confirmed: true` — reviewer ran the revert→FAIL→restore→PASS proof
  (18 focused assertions failed with `src/` reverted; full suite 748 green
  restored at this SHA) plus typecheck/build and a static edge-case audit
  (post-history tool-result ordering, shared recursive 100-image budget,
  nested cache-marker accounting, ordinal JSON-framed tool digests).
- Verdict: **accepted** (2026-07-10 ~10:45 UTC), zero comments.

**Slice-4 review closed: accepted at r1.** Merge remains owner-gated.
