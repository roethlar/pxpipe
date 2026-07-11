# one-port-subscription-plan: One-service persistent subscription routing plan

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: In Review — R4 closes the R3 durability, ownership, and isolation gaps
**Branch**: `fix/provenance-safe-compression`
**Commit**: `2aeca41cc385789d4456c3473a22cb112c389e84` (base
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
R2 addresses them by:

- adding exact Codex compact and installed-Grok auxiliary routes;
- pinning serialized query-suffix preservation, full hop-by-hop filtering, raw
  malformed/absolute target rejection, and independent reserved/generic config
  resolution;
- specifying a source-preserving fixed-target config helper, existing/new mode
  rules, ambiguous/API-key-flow refusal, network-denied pre/post parsing, and a
  fixed transaction/rollback order; and
- making reinstall/uninstall surgical around managed keys so unrelated later
  owner edits survive.

That amendment was sent for R2. No implementation was authorized by the R1
verdict.

R2 also returned a clean verdict, but a concurrent installer audit found five
observable gaps after dispatch:

- value-only receipt ownership could erase a later inline comment or table
  trivia during uninstall;
- reinstall did not say what happens when an owner changes a managed key;
- ERR/INT/TERM rollback did not cover process death or power loss between
  service/config/receipt mutations;
- whole-file rollback and the no-overwrite promise conflicted when an owner edit
  raced rollback; and
- `grok inspect --json` could attach to the owner's running default Grok leader
  instead of remaining an isolated parser check.

R3 records exact owned source spans, fails reinstall before mutation on managed
drift, journals every mutation durably for next-run recovery, retains a
fail-closed conflict state instead of overwriting a third identity, and gives
every Grok parser check a fresh private `--leader-socket` path. The clean R2
model verdict is recorded below but does not authorize implementation of R2.

R3 was reopened by Claude and by a concurrent installer audit. Their concrete
evidence was:

- plain fsync cannot support a sudden-power-loss guarantee on macOS without
  `F_FULLFSYNC`;
- a nested Grok Unix-socket path can exceed macOS's fixed path limit, and cleanup
  had not ruled out an orphan leader;
- simultaneous installers needed a lock, and snapshots needed a preparing
  journal before their first byte was staged;
- receipt absence, first adoption of the verified pre-ledger service, created
  config files/directories, and partial-uninstall receipt state were undefined;
- surrounding anchors conflicted with allowing unrelated edits, while the
  no-overwrite claim overstated what portable rename can guarantee against an
  uncooperative editor's final syscall race; and
- running parser checks against the real home could still read credentials or
  write/spawn locally despite network denial.

R4 adjudicates every item: it limits plain-fsync recovery to process/signal/OS
restart rather than power loss; uses a byte-budgeted short private socket with
fork denied; serializes installers with an atomically complete lock; journals
before snapshots; enumerates first-install footprints and all file/directory/
receipt ownership states; preflights the whole uninstall before mutation; scopes
the final editor race honestly; and parses only byte-identical config plus staged
native binaries under a filesystem/process/network sandbox. No R3 implementation
is authorized.

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

- R2 (2026-07-11T05:27:16Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, read-only disposable worktree
  `/Users/michael/Dev/pxpipe-review-one-port-plan-r2`.
  - Reviewed SHA: `35ea0341d3e2ab3db1b5bf82313362dd2c2ac2d8`.
  - Base SHA: `cc79310e5476f62e09aa1dbe4ee51b6204380002`.
  - Verdict: **accepted**.
  - Must-fix: none.
  - Should-fix: none.
  - Open questions: none.

- R3 (2026-07-11T05:41:08Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, read-only disposable worktree
  `/Users/michael/Dev/pxpipe-review-one-port-plan-r3`.
  - Reviewed SHA: `e2025475bd1e9c82dd1a6fc898ad7b8639586878`.
  - Base SHA: `35ea0341d3e2ab3db1b5bf82313362dd2c2ac2d8`.
  - Verdict: **reopened**.
  - Must-fix:
    - Plain fsync cannot prove the promised drive-cache ordering across sudden
      power loss; require macOS `F_FULLFSYNC` or narrow the guarantee.
  - Should-fix:
    - Bound the private Grok Unix-socket path below macOS's limit.
    - Serialize simultaneous installer invocations.
    - Create the pending journal before staging snapshots.
  - Open questions:
    - Prove the private Grok check cannot leave a background leader.
    - Define receipt state after any partial uninstall/conflict.

The R3 envelope exited zero after 74 turns, matched the custom schema, and
returned both pinned SHAs exactly. Eight ancillary Bash attempts were denied;
the review completed without tracked changes, live calls, or web access. R4's
coder adjudication above addresses every returned item plus the concurrent audit.

The R2 envelope exited zero after 82 turns, matched the custom schema, and
returned both pinned SHAs exactly. Three ancillary Bash attempts were denied;
the review completed without tracked changes, live calls, or web access. The
coder's concurrent evidence above reopens R2 and sends the exact R3 amendment
for a fresh review.
