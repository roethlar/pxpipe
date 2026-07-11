# context-hijack-correction-plan: Remove context rewriting and negative returns

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: Pending Claude review — implementation remains owner-gated
**Branch**: `fix/provenance-safe-compression`
**Commit**: `489292a42d336e3f99661d3ea2407ab9636b680b`

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

## Reviewer comments

- Pre-r1 (2026-07-11T01:03:01Z): Claude Code 2.1.206 / Sonnet 5 was dispatched
  against `dd0c5a3` with base `94470f7`, then deliberately terminated before any
  verdict because new owner evidence made the plan stale. Outcome: **no verdict;
  fail closed**.
- Fresh r1 pending. Record the Claude version, reviewed/base SHA, verdict, UTC
  timestamp, and all comments before acting on them.
