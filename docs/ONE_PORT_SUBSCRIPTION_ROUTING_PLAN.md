# One-port subscription routing

Status: **DRAFT 2026-07-10 — the owner approved the simple-use outcome;
detailed implementation awaits independent plan review and owner approval**.

Plan base: `e8709d5` on `fix/provenance-safe-compression`. Canonical upstream
`main` was `8d7ba3e` when this plan was drafted. Recheck upstream immediately
before implementation and prefer any upstream solution that overlaps or
conflicts.

This plan replaces the multi-terminal operator workflow in
`docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md`. That earlier plan remains the
historical implementation and review receipt for the current router.

## Required outcome

The installed login service owns one loopback listener:

```text
127.0.0.1:47821
```

After a one-time client configuration, the owner runs:

```text
codex
grok
```

No API keys, wrappers, aliases, temporary proxies, extra terminals, extra
ports, or per-run environment variables are allowed. The clients continue to
use their stored subscription logins. Dashboard model selection controls
compression eligibility; the request namespace chooses the subscription
vendor.

## One-time client configuration

Codex keeps its stored ChatGPT login and uses a named local provider in
`~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_provider = "pxpipe_local"

[model_providers.pxpipe_local]
name = "pxpipe local"
base_url = "http://127.0.0.1:47821/_pxpipe/codex"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
```

`supports_websockets = false` is required: otherwise Codex can retain a direct
WebSocket transport and bypass pxpipe.

Grok keeps its stored browser/subscription login and uses
`~/.grok/config.toml`:

```toml
[models]
default = "grok-4.5"

[endpoints]
cli_chat_proxy_base_url = "http://127.0.0.1:47821/_pxpipe/grok/v1"
```

Do not use Grok's `models_base_url` setting; that selects its API-key flow.
The installer backs up both existing files and changes only the named keys,
preserving unrelated owner settings.

## Explicit route contract

Reserved local namespaces select the subscription upstream. They are
deliberately explicit; routing must not guess from bearer tokens, unstable
headers, or overlapping generic paths.

| Incoming local route | Forwarded subscription route |
|---|---|
| `/_pxpipe/codex/responses` | ChatGPT Codex `/responses` |
| `/_pxpipe/codex/models` and descendants | ChatGPT Codex `/models` and descendants |
| `/_pxpipe/grok/v1/responses` and descendants | Grok `/v1/responses` and descendants |
| `/_pxpipe/grok/v1/models` and descendants | Grok `/v1/models` and descendants |
| exact `/_pxpipe/grok/v1/settings` | Grok `/v1/settings` |

Query strings are preserved. Unknown, malformed, lookalike, or
method-incompatible reserved paths fail locally without any upstream request.
Existing bare OpenAI, Anthropic, provider-prefixed, and Cloudflare routes keep
their current behavior.

## Runtime configuration

Add optional core settings:

- `ProxyConfig.codexUpstream`
- `ProxyConfig.grokUpstream`

The Node host reads:

- `PXPIPE_CODEX_UPSTREAM`
- `PXPIPE_GROK_UPSTREAM`

The local macOS installer persists:

```text
PXPIPE_CODEX_UPSTREAM=https://chatgpt.com/backend-api/codex
PXPIPE_GROK_UPSTREAM=https://cli-chat-proxy.grok.com
PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol,grok-4.5
```

These values contain no credentials. The service never stores subscription
tokens.

## Request handling and credential safety

The proxy classifies a reserved subscription route before generic
OpenAI-compatible routing. Classification produces a provider kind and a
stripped logical path that remain attached through request transformation and
forwarding.

Responses requests keep the existing compression and telemetry path.
Client-supplied authorization, account, and provider headers are forwarded
unchanged to the selected subscription upstream.

Reserved subscription routes must never receive:

- `OPENAI_API_KEY` replacement authorization;
- Anthropic key replacement authorization;
- Cloudflare gateway authentication headers;
- a generic upstream fallback.

Reserved subscription traffic goes directly to its configured subscription
upstream even if Cloudflare is configured for other traffic. Existing
non-reserved Cloudflare behavior is unchanged.

If the selected subscription upstream or required client authorization is
missing, the proxy fails locally without fetching.

## Implementation slices

Each slice is one committed unit and receives independent Claude review in a
disposable worktree outside `/private`. A finished slice is committed before
the next begins.

### Slice 1 — core router

- Add the two optional upstream settings.
- Add exact reserved-path classification and prefix stripping.
- Preserve query strings and the selected route through forwarding.
- Keep Responses transformation and telemetry intact.
- Exclude subscription routes from key and gateway-header injection.
- Add focused proxy and gateway tests.

### Slice 2 — Node host and installer

- Read the two new Node environment settings.
- Persist the fixed local subscription upstreams in the LaunchAgent.
- Keep the exact installed three-model scope.
- Add host and installer tests, including hostile ambient environment values.

### Slice 3 — owner-facing setup

- Replace the multi-terminal README workflow with the two one-time client
  configuration snippets and plain launch commands.
- Package the reviewed service directly into
  `/Users/michael/Dev/pxpipe-deploy`, verify its digest, and reinstall it.
- Back up and minimally update the two machine-local client config files.
- Validate both client parsers without making a model call.

## Automated acceptance checks

1. Codex reserved Responses and models requests reach the exact ChatGPT Codex
   URLs.
2. Grok reserved Responses, models, and settings requests reach the exact Grok
   URLs.
3. Query strings plus authorization, account, `X-XAI-*`, and `x-grok-*`
   headers are preserved.
4. Sol and Grok Responses bodies still enter compression, proved with positive
   image counts.
5. Missing authorization, missing configured upstreams, unsupported methods,
   prefix lookalikes, and unknown reserved paths fail locally with zero
   upstream fetches.
6. API-key replacements and Cloudflare gateway headers are absent from
   subscription requests.
7. Existing Anthropic, OpenAI, provider-prefixed, Cloudflare, dashboard, and
   model-selection tests remain unchanged and green.
8. The installer persists the exact fixed upstream and model values even when
   conflicting ambient variables exist.

For every new behavior test, prove the guard by temporarily removing the
matching classifier or installer behavior, observing the focused test fail,
restoring it, and observing it pass. Then run:

```text
pnpm run typecheck && pnpm test && pnpm run build
```

## Independent review

Claude reviews this plan before owner approval and reviews every implementation
slice afterward. Reviews use disposable worktrees under `~/Dev`, never Codex
and never the implementation agent reviewing its own work. Findings and
verdicts are recorded under `.agents/review/`.

## Local deployment and validation

After all slices are accepted:

1. Build a clean macOS package directly into
   `/Users/michael/Dev/pxpipe-deploy`.
2. Verify the package manifest and digest, then run its installer.
3. Confirm the login service is healthy on `127.0.0.1:47821` and its persisted
   environment contains both subscription upstreams and the exact model list.
4. Back up and update `~/.codex/config.toml` and `~/.grok/config.toml`.
5. Run parser-only local checks showing that plain `codex` and `grok` resolve
   the saved configuration.

No live model request is part of installation or parser validation. The
three-call subscription smoke remains a separate owner gate.

## Boundaries

This plan does not authorize:

- API keys or API-key authentication;
- changes to existing Cloudflare behavior;
- a WebSocket proxy;
- token inspection, bearer decoding, or header-based vendor guessing;
- an extra service, process, port, wrapper, alias, or per-run environment;
- a public upstream contribution, pull request, or merge;
- a live model call or the provenance plan's live A/B matrix;
- a push to the fork.

## Acceptance

The work is complete only when the persistent client settings make plain
`codex` and plain `grok` use the one installed pxpipe service with their
existing subscriptions. Any workflow that requires extra terminals,
short-lived proxy commands, wrappers, aliases, or per-run setup is a failure.
