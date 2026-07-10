# subscription-harness-plan: No-key local harness routing and smoke plan

**Severity**: N/A — owner-requested plan review, not a defect finding
**Status**: Pending r2 after adopted should-fix
**Branch**: `fix/provenance-safe-compression`
**Commit**: `e8be447b3aefe2da565847131d58b2b58f6b4b11`

## Plan authority

The owner requested a plan to test Fable, Codex/Sol, and Grok through the local
fork using existing subscription logins and no API keys.

## Reviewer comments — r1

- Reviewer: Claude Code 2.1.206 / Sonnet 5 (`claude -p`, structured output),
  run with pxpipe bypassed in a disposable worktree under `~/Dev`.
- Reviewed SHA: `e8be447b3aefe2da565847131d58b2b58f6b4b11`.
- Verdict: **accepted** (2026-07-10), zero MUST_FIX comments, one SHOULD_FIX
  comment, two open questions.
- Comment (verbatim):
  1. "SHOULD_FIX; docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md:85-88;
     src/node.ts:113 reads `openAIApiKey: process.env.OPENAI_API_KEY` directly
     from the pxpipe proxy process's own ambient environment, and
     src/core/proxy.ts:784-785 uses that value to overwrite the forwarded
     `authorization` header. The plan states OPENAI_API_KEY 'must be absent
     from the relevant smoke child processes' but never specifies the
     enforcement mechanism. If the operator's shell happens to have
     OPENAI_API_KEY exported for unrelated tooling and the Sol/Codex proxy is
     spawned inheriting that ambient environment, pxpipe would silently
     replace the forwarded ChatGPT subscription bearer. Concrete correction:
     state explicitly that each proxy child must use an explicit, constructed
     environment object that omits all API-key variables rather than inheriting
     `process.env`."
- Open questions (verbatim):
  1. "Does Claude Code's OAuth/subscription auth mode ever call `/v1/models`
     (or another `/v1/*` route) using only an `Authorization: Bearer` header
     with no `x-api-key`?"
  2. "Has the owner already been made aware of the out-of-band live Codex call,
     separate from approving this plan?"

## Coder adjudication

- **ADOPTED** — the ambient-key risk is observable and the proposed correction
  is smaller and safer than relying on the current shell environment.
- Open question 1: pending a local-only capture that records path/header
  presence but no values and never forwards to a model.
- Open question 2: resolved yes; the owner was told in the immediately
  preceding response that one diagnostic Codex prompt bypassed pxpipe through
  the normal subscription and that route was stopped.

No source code or live smoke call has been authorized.
