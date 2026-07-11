# context-hijack-correction-plan: Remove context rewriting and negative returns

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: Pending final r3 after answering the r2 clarification
**Branch**: `fix/provenance-safe-compression`
**Commit**: `5daab974a34fcf94df0b8ec039a57d911ab0957b`

## Plan authority

The installed provenance-safe design failed the owner's real acceptance test. A
model-side report from the installed build showed proxy metadata fused to live user
text, proxy-authored trust/priority claims, and a cache-aware effective-token loss.
The owner directed that the plan be revised and reviewed by Claude.

The plan under review is
`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`. It reopens
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` and pauses
`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`.

## Review contract

Claude must review the pinned plan, current source/tests, the installed-build
receipts, and the machine-local incident report together. Check:

- whether the plan removes every model-visible manifest, label, pointer, banner,
  factsheet, paging notice, guard, and other proxy-authored prose from the default
  completion path;
- whether an unlabeled project image can replace only its exact source span while
  preserving Anthropic role, message, block order, prefix, suffix, metadata, and
  cache-marker ownership;
- whether every unsupported system/developer/tool/history shape fails exact native
  on Anthropic, OpenAI Chat, and OpenAI Responses;
- whether the four no-model token probes and conservative cache pricing are
  implementable with current provider/request shapes and include complete-request
  image/text/cache-rebuild cost;
- whether the 10% plus 256-effective-token reserve, missing-measurement fallback,
  and negative-feedback breaker can prevent the reported negative return without
  hiding it;
- whether five-minute and one-hour cache creation are priced separately and one
  shared signed function keeps live, replay, session, and statistics totals equal;
- whether final provider-structure validation rejects the reproduced invalid
  Anthropic system-before-synthetic-user sequence and restores the original body;
- whether the current stale-model and hook-order evidence justifies only guards,
  not speculative cache or ordering code;
- whether the five slices and guard proofs are complete, independently reviewable,
  and consistent with current public options, Node, Worker, library, dashboard,
  installer, and documentation paths.

This is a preimplementation plan review, so `guard_confirmed` does not apply.
The structured result payload is:

```json
{
  "verdict": "accepted|reopened|invalid",
  "reviewed_sha": "<head-sha>",
  "base_sha": "<base-sha>",
  "must_fix": [
    "SEVERITY; plan-or-source:line; predicted observable failure; concrete correction"
  ],
  "should_fix": [
    "SEVERITY; plan-or-source:line; predicted observable failure; concrete correction"
  ],
  "open_questions": ["question"]
}
```

A clean review is valid. Every finding needs a cited plan/source location, an
observable failure, and a concrete correction. Off-schema output, a wrong reviewed
SHA, incomplete termination, or a failed command is not acceptance.

## Coder adjudication

The pre-r1 dispatch at reviewed SHA `dd0c5a3` was stopped before a verdict when the
owner reported a new live Anthropic role-order 400. The plan was revised at
`489292a` to cover provider-structure validation, the reproduced history-collapse
cause, cache-tier pricing, shared signed accounting, overlap, and fault-injection
guards. No partial reviewer output is treated as a verdict.

R1 adjudication:

- **ADOPTED should-fix 1** — the four-probe request-wide result is now the only
  runtime profitability verdict. Active per-bucket
  `isCompressionProfitable`/`priorWarm*` gates are retired, not retained as a
  second pre-filter.
- **ADOPTED should-fix 2** — admission math and structural validation live in the
  Workers-safe core. The owner's local Node service owns the process-local breaker
  and per-fingerprint in-flight lock. Worker has no claimed cross-isolate state and
  relies on the strict per-request gate or stays native.
- **ADOPTED should-fix 3** — v1 builds one candidate from all safety-qualified
  buckets. If its authoritative full-request probes fail, the complete original
  request is forwarded; there is no subset search.
- **ANSWERED open question 1** — shared core admission, Node-only process breaker;
  no KV or Durable Object.
- **ANSWERED open question 2** — cache tier comes from the unambiguous covering
  caller `cache_control.ttl`; absent, unknown, uncovered, or mixed coverage uses
  conservative 2.0 cache-create pricing.

These refinements were committed at `5cfcf2b`. Fresh r2 must grade the full pinned
plan; r1 acceptance does not authorize implementation.

R2 clarification:

- **ANSWERED yes** — `rendered.droppedChars > 0` or any non-empty
  dropped-codepoint map is explicitly a render failure. The complete affected
  source bucket stays native before economic admission; no caller may treat the
  signal as telemetry-only. Slice 1, Slice 2, and acceptance now pin this behavior
  at `5daab97`.

## Reviewer comments

- Pre-r1 (2026-07-11T01:03:01Z): Claude Code 2.1.206 / Sonnet 5 was dispatched
  against `dd0c5a3` with base `94470f7`, then deliberately terminated before any
  verdict because new owner evidence made the plan stale. Outcome: **no verdict;
  fail closed**.
- R1 (2026-07-11T01:19:37Z): Claude Code 2.1.207 / Sonnet 5, structured output,
  pxpipe bypassed, read-only disposable worktree under `~/Dev`.
  - Reviewed SHA: `d9909650a8f4fe9998d24f1a5f545a1ebe777d37`.
  - Base SHA: `94470f73c1390fd7c405027ac5bd9a7123d725cf`.
  - Verdict: **accepted**.
  - Must-fix: none.
  - Should-fix 1 (verbatim): "LOW;
    docs/CONTEXT_HIJACK_CORRECTION_PLAN.md:183-210 vs
    src/core/transform.ts:1535-1600,1792-1873 (per-bucket
    isCompressionProfitable/priorWarm gates); predicted failure: an implementer
    could leave the old per-bucket cold-estimate gate
    (isCompressionProfitable/priorWarmTokens plumbing) running alongside the new
    request-wide 4-probe admission gate, so two divergent 'is this profitable'
    formulas coexist and a future edit to one silently drifts from the other;
    correction: state explicitly in Slice 1/2 whether the legacy per-bucket
    priorWarm-based profitability functions are retired/superseded by the
    request-wide gate or retained only as a cheap pre-filter before the
    authoritative probe-based gate."
  - Should-fix 2 (verbatim): "LOW;
    docs/CONTEXT_HIJACK_CORRECTION_PLAN.md:219-223 vs src/worker.ts (no
    module-level/Durable-Object shared state observed); predicted failure:
    'atomically disables ... for the rest of the process' reads as a single
    shared-memory guarantee, but a Cloudflare Worker deployment spreads concurrent
    requests across many isolates with no shared state today, so the circuit
    breaker would only suppress repeats within one isolate, not fleet-wide, and a
    reviewer could later treat the acceptance check as proven globally when it is
    only proven per-isolate; correction: state explicitly that the
    negative-feedback breaker is defense-in-depth scoped to a single Node process /
    single Worker isolate (the per-request strict admission gate is the actual
    safety net), or specify a cross-isolate mechanism (KV/Durable Object) if
    fleet-wide suppression is required."
  - Should-fix 3 (verbatim): "LOW;
    docs/CONTEXT_HIJACK_CORRECTION_PLAN.md:186-210 (admission bullets) vs rule 8 at
    docs/CONTEXT_HIJACK_CORRECTION_PLAN.md:130-132 ('leaves the complete source
    bucket native'); predicted failure: it is unspecified whether the request-wide
    'candidate full request' probe is built once from every simultaneously
    safety-qualified bucket (so one unprofitable bucket fails the whole multi-bucket
    request to native) or is evaluated iteratively per bucket combination; an
    implementer could pick either and both satisfy the acceptance checks, but they
    yield materially different compression coverage; correction: add one sentence
    specifying the combinatorial strategy (e.g., 'evaluate the full candidate
    first; on failure, drop the least-profitable eligible bucket and re-probe' vs
    'any one unprofitable bucket fails the entire request native')."
  - Open question 1 (verbatim): "Should the request-wide admission probes and the
    negative-feedback fingerprint state live entirely in the Workers-safe core
    (src/core/*.ts, no node:/process globals) so Worker and Node share identical
    admission logic, or is the circuit breaker intentionally Node-only
    (dashboard/sessions are already node:fs-only) with Worker relying solely on the
    per-request strict gate?"
  - Open question 2 (verbatim): "For the cache-tier pricing (1.25 5m vs 2.0 1h),
    will tier selection read the governing cache_control marker's existing `ttl`
    field (src/core/types.ts:41-44) on the caller-owned breakpoint that covers the
    changed span, and default to the conservative 2.0 rate whenever the changed
    span isn't clearly covered by a single caller marker with an explicit ttl?"

The structured envelope completed successfully with the pinned SHAs and no
permission denials. Coder adjudication is recorded in the next revision before r2.

- R2 (2026-07-11T01:27:46Z): Claude Code 2.1.207 / Sonnet 5, structured output,
  pxpipe bypassed, fresh read-only disposable worktree under `~/Dev`.
  - Reviewed SHA: `48df87eea9eaa069934f3729045719f321ff3d73`.
  - Base SHA: `94470f73c1390fd7c405027ac5bd9a7123d725cf`.
  - Verdict: **accepted**.
  - Must-fix: none.
  - Should-fix: none.
  - Open question (verbatim):
    "docs/CONTEXT_HIJACK_CORRECTION_PLAN.md:126-129 (rule 6, 'any unrenderable
    codepoint leaves the bucket native') vs src/core/render.ts:779-782 and its
    callers in src/core/transform.ts:1638-1645,1874-1885,2034-2036
    (project-guidance, tool-reference, and default-eligible tool-result image
    paths): those call sites already compute rendered.droppedChars/droppedCodepoints
    per glyph miss but today only add it to telemetry (info.droppedChars,
    droppedCodepointsTop) and still apply/accept the image unconditionally. Should
    Slice 1/2 explicitly require gating admission on that existing droppedChars
    signal (treat droppedChars>0 as a render failure under rule 8) rather than
    leaving 'render failure' to be interpreted as only hard/thrown rendering
    errors?"

The r2 envelope completed successfully with the pinned SHAs and no permission
denials. The open question is answered durably before a final narrow r3.
