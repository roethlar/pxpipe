# one-port-subscription-plan: One-service persistent subscription routing plan

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: Pending Claude review — implementation remains owner-gated
**Branch**: `fix/provenance-safe-compression`
**Commit**: `41fd63876f514a45a4d0135dc5639f7e322c9647`

## Plan authority

The owner rejected the earlier multi-terminal workflow. The required outcome is
one installed loopback service, one-time Codex and Grok configuration, then plain
`codex` and `grok` using their existing subscription logins. API keys, wrappers,
aliases, extra terminals, extra services, and per-run environment variables are
failures.

The plan under review is
`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`. It supersedes only the operator
workflow in `docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md`; the earlier file remains a
historical implementation and review receipt.

## Review contract

Claude must review the pinned plan and current source together, checking:

- that the two client configuration shapes are supported by the installed clients
  and preserve subscription authentication;
- that the reserved route contract cannot confuse Codex, Grok, generic OpenAI,
  Anthropic, or Cloudflare traffic;
- that credentials cannot be replaced, stored, or sent to the wrong upstream;
- that every failure named in the plan can be tested without a live model call;
- that the implementation slices cover the current core, Node host, installer,
  documentation, deployment, and machine-local configuration paths;
- that the required outcome needs no extra terminal, wrapper, alias, port,
  process, or per-run setup.

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

A clean review is valid. Any must-fix or should-fix item needs a cited location,
an observable failure, and a concrete correction. Off-schema output, a wrong
reviewed SHA, or a failed command is not acceptance.

## Coder adjudication

Pending review.

## Reviewer comments

Pending review. Record the Claude version, reviewed/base SHA, verdict, UTC
timestamp, and all comments before acting on them.
