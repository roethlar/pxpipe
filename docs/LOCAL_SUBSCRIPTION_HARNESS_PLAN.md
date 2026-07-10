# Local subscription-harness routing and smoke tests

Status: **DRAFT — code and live calls await separate owner approval**.

Plan base: `102b983` on `fix/provenance-safe-compression`. Canonical upstream
`main` was still `8d7ba3e` when this plan was drafted. Recheck upstream before
implementation and prefer any upstream solution that overlaps or conflicts.

This is a narrow follow-on to the completed provenance-safe compression and
local-package plans. It does not reopen their architecture or acceptance. The
provenance plan correctly recorded that its implementation did not change
OpenAI behavior; this plan owns the newly requested subscription-harness
compatibility work.

## Outcome

Test the installed local fork through the owner's existing subscriptions,
without API keys:

- Claude Code with Fable 5 exercises the provenance-safe Anthropic path.
- Codex with `gpt-5.6-sol` exercises the OpenAI Responses transform.
- Grok Build with `grok-4.5` exercises the same OpenAI-compatible transform.

Every smoke proxy explicitly uses:

```text
PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol,grok-4.5
```

The installed login service keeps its Fable-only default. Sol and Grok are
enabled only inside bounded smoke processes.

## Evidence and current gap

Local loopback probes recorded only path, model, and whether login headers were
present; token values were never read or logged.

- Grok 0.2.93 sent its stored subscription bearer to a local
  `GROK_CLI_CHAT_PROXY_BASE_URL`, including `/v1/models` and
  `/v1/settings`.
- Codex 0.144.1 sent its stored ChatGPT bearer and account header to a custom
  provider using `requires_openai_auth=true`. With
  `supports_websockets=false` it used HTTP `/models` and `/responses` when
  the local provider base omitted `/v1`.
- Codex's subscription upstream base is
  `https://chatgpt.com/backend-api/codex`. pxpipe does not recognize plain
  `/models` or `/responses` today, so those requests take the Anthropic route
  and the Responses body is not transformed.
- Grok's subscription base is `https://cli-chat-proxy.grok.com/v1`. When its
  client points at local `/v1`, pxpipe can preserve that path, but exact
  authenticated `/v1/settings` currently selects the Anthropic upstream.

A diagnostic using only Codex's `chatgpt_base_url` did not intercept model
traffic because Codex retained its direct WebSocket transport. It sent one
ordinary subscription prompt outside pxpipe before this was observed. That
route is forbidden for the smoke test.

## Chosen design

Recognize the exact additional OpenAI-compatible HTTP shapes; do not add a path
rewriter or infer behavior from a hostname:

- POST `/responses` is the plain-base equivalent of `/v1/responses`.
- Authenticated `/models` and descendants are the plain-base equivalents of
  `/v1/models`.
- Exact authenticated `/v1/settings` is an OpenAI-family auxiliary route for
  the Grok harness.

Forward every accepted path and query byte-for-byte to `OPENAI_UPSTREAM`.
Existing `/v1/*` behavior, default upstreams, Cloudflare stripping, transforms,
and model profiles remain unchanged.

Expected routing:

| Client | Configured upstream | Incoming | Forwarded |
|---|---|---|---|
| Codex | `https://chatgpt.com/backend-api/codex` | `/responses` | `/responses` |
| Codex | same | `/models?...` | `/models?...` |
| Grok | `https://cli-chat-proxy.grok.com` | `/v1/responses` | `/v1/responses` |
| Grok | same | `/v1/models` | `/v1/models` |
| Grok | same | `/v1/settings` | `/v1/settings` |

Authorization and `ChatGPT-Account-ID` remain ordinary forwarded headers.
pxpipe must not inspect, persist, replace, or print subscription tokens.
Spawn every proxy and harness child from an explicit allowlisted environment,
never inherited `process.env` or the ambient shell. Retain only the minimum
runtime fields (`HOME`, `PATH`, user/locale fields, and a smoke-local
`TMPDIR`), then add the exact routing variables for that child. Set
`PXPIPE_CONFIG=/dev/null` on proxy children and set `PXPIPE_MODELS` explicitly.
Do not copy `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, or
`GROK_CODE_XAI_API_KEY` into any child. This prevents an unrelated ambient key
from replacing the subscription bearer that the harness forwards.

## Separate provider processes

The three harnesses run sequentially through three loopback-only proxy
processes. Each process sends the unused protocol family to
`http://127.0.0.1:9` so a routing mistake fails closed. The installed service
on port `47821` remains untouched.

- Fable proxy: port `47831`, Anthropic upstream
  `https://api.anthropic.com`.
- Sol proxy: port `47832`, OpenAI upstream
  `https://chatgpt.com/backend-api/codex`.
- Grok proxy: port `47833`, OpenAI upstream
  `https://cli-chat-proxy.grok.com`.

The Codex smoke uses a one-run custom provider with local base
`http://127.0.0.1:47832`, `requires_openai_auth=true`,
`supports_websockets=false`, Responses wire format, no retries, and no
persistent config edit.

The Grok smoke sets
`GROK_CLI_CHAT_PROXY_BASE_URL=http://127.0.0.1:47833/v1` only for that
process. Its browser login remains responsible for refresh.

Scratch lives under `~/Library/Caches/pxpipe-subscription-smoke/`, never under
`/private`, and is removed on success or failure. No raw prompt, response,
login data, or test repository is committed.

## Implementation slice

One focused code slice:

- `src/core/proxy.ts`: recognize plain Responses/models and authenticated exact
  Grok settings routes.
- `tests/proxy-usage.test.ts` and/or `tests/gateway.test.ts`: pin exact
  upstream URL, transformation, model, and forwarded fake headers.
- `README.md`: document no-key Codex and Grok local commands without making
  either model a default.

Do not change rendering, model profiles, default model scope, installer
LaunchAgent settings, Worker configuration, package identity, or Cloudflare
behavior.

## Automated verification

Tests must prove:

1. a plain authenticated Codex `/responses` request reaches exactly
   `.../backend-api/codex/responses`;
2. that body is transformed for opted-in `gpt-5.6-sol` and records a positive
   image count;
3. fake `Authorization` and `ChatGPT-Account-ID` headers survive unchanged;
4. plain `/models?client_version=...` reaches the Codex upstream with its query;
5. Grok `/v1/responses`, `/v1/models`, and authenticated exact
   `/v1/settings` reach the configured OpenAI upstream;
6. unauthenticated and non-exact settings lookalikes are not reclassified;
7. current OpenAI API and Cloudflare routes remain unchanged; and
8. no test records or prints a token value.

Temporarily remove the plain-route recognition and prove the Codex focused test
fails; restore it and prove it passes. Separately remove settings
classification and prove the Grok auxiliary-route test fails; restore it and
prove it passes. Then run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

Dispatch Claude for independent review and guard proofs in a disposable
worktree under `~/Dev`, not `/private`. Record the verdict under
`.agents/review/` before acting on it.

After acceptance, regenerate the bundle directly into
`~/Dev/pxpipe-deploy`, reinstall it, and confirm receipt, checksum, loopback
listener, login service, and dashboard. Generated delivery artifacts never
enter `/private`.

## Owner-gated live smoke

Plan or implementation approval does not authorize live calls. Obtain one
explicit owner go after the reviewed bundle is installed. The smoke uses
subscription quota but no API key.

Create a deterministic, non-secret temporary git repository with
`CLAUDE.md` importing a 20–30 KB benign `AGENTS.md`. The guidance contains a
fixed fact marker and no operational commands. Each harness gets one fresh,
non-resumed, read-only turn asking for that fact and an exact completion
marker, with tools forbidden.

Run one call per harness:

1. Claude Code / Fable 5 with plan permissions and no session persistence.
2. Codex / `gpt-5.6-sol` with an ephemeral read-only session and the temporary
   custom provider above.
3. Grok Build / `grok-4.5` with plan permissions, one turn, no memory,
   subagents, or web search. Delete the returned Grok session by its exact
   `sessionId`.

For every arm require:

- client exit zero and the exact completion marker;
- one relevant event row with expected path, model, successful status, and
  stop reason;
- requested and served models match;
- the model is supported and a positive image count proves compression ran;
- no refusal, content filter, fallback, injection accusation, error, error
  body, or tool action; and
- exact proxy PID termination, closed port, and scratch cleanup.

Stop on the first failed condition. Do not retry automatically or weaken the
check. Record only redacted aggregate results and hashes; never store login
headers, proprietary base prompts, or full transcripts.

This three-call smoke establishes local compatibility and exercises the
reported context-hijack shape once. It does not replace or authorize the
provenance plan's larger Fable/Sonnet A/B matrix.

## Boundaries

- No API keys.
- No Cloudflare.
- No WebSocket proxy.
- No simultaneous multi-provider routing on one port.
- No persistent harness config or login-service allowlist change.
- No public release, upstream contribution, pull request, merge, or main change.
- No full live A/B matrix.
- Pushing the fork requires a fresh explicit owner go.

## Review and approval

Claude reviews this plan read-only against the pinned base and current source.
An accepted review means the plan is ready for owner judgment; it does not
authorize code, live calls, installation, or push.

### Review log

- r1 (2026-07-10, Claude Code 2.1.206 / Sonnet 5, reviewed
  `e8be447b3aefe2da565847131d58b2b58f6b4b11`): **accepted**, zero blocking
  findings, one should-fix finding, and two open questions. The finding was
  adopted: every smoke child now receives a constructed allowlisted
  environment rather than inheriting ambient API-key variables. A local-only
  Claude subscription probe resolved the first question: it sent only HEAD `/`
  and bearer-authenticated POST `/v1/messages?beta=true`, never `/v1/models`;
  nothing was forwarded to a model. The owner had already been told about the
  earlier out-of-band Codex diagnostic, resolving the second question. Fresh r2
  review is pending.
