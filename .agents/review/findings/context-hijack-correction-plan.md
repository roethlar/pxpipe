# context-hijack-correction-plan: Remove context rewriting and negative returns

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: Pending Claude review — implementation remains owner-gated
**Branch**: `fix/provenance-safe-compression`
**Commit**: `26c82cc8012004dfea7c085bbae6dd142e3ce75c`

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

Pending review.

## Reviewer comments

Pending review. Record the Claude version, reviewed/base SHA, verdict, UTC
timestamp, and all comments before acting on them.
