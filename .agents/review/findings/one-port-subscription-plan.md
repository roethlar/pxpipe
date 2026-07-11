# one-port-subscription-plan: One-service persistent subscription routing plan

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: Reopened after R1 — coder audit found required client routes and
installer/query gaps the reviewer missed
**Branch**: `fix/provenance-safe-compression`
**Commit**: `1bf3f5ebd2522336903959152ffb20751ce72b53` (base
`cc79310e5476f62e09aa1dbe4ee51b6204380002`)

## Plan authority

The owner rejected the earlier multi-terminal workflow. The required outcome is
one installed loopback service, one-time Codex and Grok configuration, then plain
`codex` and `grok` using their existing subscription logins. API keys, wrappers,
aliases, extra terminals, extra services, and per-run environment variables are
failures.

The corrected package is installed and its local gate is closed. The amended
plan under review is
`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`. It supersedes only the operator
workflow in `docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md`; the earlier file remains a
historical implementation and review receipt.

The original draft expected positive Sol/Grok image counts. The later approved
correction instead requires exact OpenAI pass-through. This amendment makes
that higher-authority rule explicit and adds the raw-path, installer transaction,
hostile-environment, parser-only, and port-synchronization requirements found by
the final read-only audit.

## Review contract

Claude must review the pinned plan and current source together, checking:

- that the two client configuration shapes are supported by the installed clients
  and preserve subscription authentication without a manual edit;
- that the reserved route contract cannot confuse Codex, Grok, generic OpenAI,
  Anthropic, or Cloudflare traffic;
- that credentials cannot be replaced, stored, or sent to the wrong upstream;
- that OpenAI bodies remain byte-exact with zero images/savings regardless of
  model names, dashboard selection, or ambient generic settings;
- that raw Node request validation precedes WHATWG normalization and every
  malformed/lookalike route has a pinned local failure with zero fetches;
- that the installer owns both TOML edits as one atomic, idempotent,
  rollback-safe transaction and cannot overwrite later owner changes;
- that the default/alternate install port is synchronized across the one
  service and both clients;
- that every failure named in the plan can be tested without a live model call;
- that `codex features list` and `grok inspect --json` are parser-only and can be
  run with network denied;
- that the implementation slices cover the current core, Node host, installer,
  documentation, deployment, and machine-local configuration paths;
- that the required outcome needs no extra terminal, wrapper, alias, port,
  process, or per-run setup.

The reviewer must also compare upstream `8b525a1` and confirm whether it supplies
any non-conflicting one-port solution that should be preferred.

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

R1's clean verdict is recorded, but it is not sufficient evidence to implement.
Concurrent read-only audits produced new concrete failures:

- The installed Codex 0.144.1 native binary contains the dedicated compact
  endpoint and literal `/responses/compact`. The plan would return 404 for
  `POST /_pxpipe/codex/responses/compact`, breaking Codex remote compaction.
- Grok 0.2.93 names exact cli-chat-proxy auxiliaries `/models-v2`,
  `/login-config`, and `/subagents/bundle`; the plan would 404 them without
  deciding which plain-Grok startup/refresh paths are required.
- Preserving existing modes conflicts with saying all existing config files and
  directories become owner-only. On this Mac, an existing Grok config is 0644
  and both existing config directories are 0755; silently changing owner files
  would exceed the requested minimal edit.
- `URL.search` drops a trailing empty `?`, so the implementation rule must name
  the exact serialized query suffix rather than assume the current path helper
  is byte-exact.
- The current fixed request-header strip set omits standard hop-by-hop names and
  headers nominated by `Connection`; the plan promises those are removed.
- Eager generic gateway resolution can throw before a reserved route is seen,
  contradicting the hostile-generic-setting bypass requirement.

These are observable compatibility/security gaps, not style preferences. The
plan is reopened for an R2 amendment and fresh Claude review.

## Reviewer comments

- R1 (2026-07-11T05:07:49Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, read-only disposable worktree
  `/Users/michael/Dev/pxpipe-review-one-port-plan-r1`.
  - Reviewed SHA: `13db4e5198f85ddb99a50a79e53fd7baae882f1c`.
  - Base SHA: `cc79310e5476f62e09aa1dbe4ee51b6204380002`.
  - Verdict: **accepted**.
  - Must-fix: none.
  - Should-fix: none.
  - Open questions: none.

The envelope exited zero, matched the custom plan-review schema, and returned
both pinned SHAs exactly. Three ancillary Bash attempts were denied; the
review completed without file changes, live calls, or web access. The coder's
post-dispatch evidence above reopens the plan despite the clean model verdict.
