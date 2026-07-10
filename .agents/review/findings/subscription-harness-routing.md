# subscription-harness-routing: Local subscription routing

**Severity**: N/A — owner-approved implementation slice, not a defect finding
**Status**: Pending Claude review
**Branch**: `fix/provenance-safe-compression`
**Commits**: `80172ae` through `dfeb07f`

## Plan authority

`docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md` records the independently accepted
plan and the owner's later approval to implement its code slice. Live
subscription calls, installation, and push remain separate owner gates.

## What the slice claims

- Plain POST `/responses` reaches the configured OpenAI service and receives
  the existing Responses compression for an opted-in Sol model.
- Authenticated plain `/models` paths and exact `/v1/settings` reach the
  configured OpenAI service without changing their path, query, or login
  headers.
- Grok's existing `/v1/models` and `/v1/responses` routes remain direct and
  unchanged.
- Other methods on plain `/responses`, unauthenticated model paths, Anthropic
  authentication, and settings lookalikes stay on the generic service.
- README commands use stored subscription login, explicitly opt in the three
  requested models, isolate each provider, and distinguish manual examples
  from the separately gated acceptance smoke.

## Files changed

- `src/core/proxy.ts` — narrow direct-route recognition.
- `tests/gateway.test.ts` — exact paths, queries, login headers, authentication,
  method, and lookalike routing.
- `tests/proxy-usage.test.ts` — Sol Responses compression and positive image
  count.
- `README.md` — no-key manual Codex and Grok routing commands.

## Guard proof

- Removing plain `/responses` and `/models` recognition made four focused tests
  fail; restoration returned all 52 then-current focused tests to green.
- Removing exact `/v1/settings` classification made its focused test fail while
  the lookalike cases stayed green; restoration returned all 52 focused tests
  to green.
- The authenticated GET `/responses` test failed against the initial
  implementation, then passed after `aa1102e` limited the plain route to POST.
- Temporarily removing the established Grok `/v1/models` and `/v1/responses`
  classifications made both new direct-route tests fail; restoration returned
  the gateway suite to green.

## Pre-review audit adjudication

- **Adopted** in `aa1102e`: plain `/responses` must be POST-only.
- **Adopted** in `ea8671d`: pin direct Grok model and response routes.
- **Adopted** in `7302ff1`: remove the smoke-local config file rather than rely
  on a non-stopping shell test.
- **Adopted** in `bc8a139`: copy optional user and locale fields only when they
  are defined; the helper passed both Bash and Zsh probes.
- **Clarified** in `dfeb07f`: README commands are manual connectivity examples,
  not the stricter acceptance smoke. The live smoke remains owner-gated.
- The installed bundle still records source `102b983`. This is expected until
  review acceptance; rebuilding and installing before review would put an
  unaccepted binary into the login service.

## Verification

- Focused final suites: 55 passed.
- `pnpm run typecheck`: passed.
- `pnpm test`: 818 passed.
- `pnpm run build`: passed; `--version` reports
  `0.8.0-provenance-safe.1`.
- No real credential was read or logged. No model request, installation, or
  push occurred during implementation verification.

## Known gaps

- No live Fable, Sol, or Grok smoke has run.
- The reviewed bundle has not yet been regenerated or installed.
- The larger provenance A/B matrix remains separately owner-gated.

## Reviewer comments

Pending independent Claude review and guard proofs.
