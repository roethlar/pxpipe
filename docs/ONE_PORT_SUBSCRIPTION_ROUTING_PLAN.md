# One-port subscription routing

Status: **AMENDED 2026-07-11 — SIMPLE-USE OUTCOME REMAINS OWNER-APPROVED;
UPDATED SAFETY CONTRACT AWAITS CLAUDE REVIEW BEFORE IMPLEMENTATION**.

Plan base: `cc79310` on `fix/provenance-safe-compression`. The corrected local
package source `59e2b9a` is installed and passed its no-network capture.
Canonical upstream `main` was `8b525a1` at the final recheck; it contains no
one-port router, Node-host, installer, or routing-test solution. Its OpenAI/Grok
imaging conflicts with the later exact-pass-through correction and is not an
overlapping solution to import.

This plan replaces the multi-terminal workflow in
`docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md`. That file remains a historical
implementation and review receipt, not current setup guidance.

The original one-port outcome was already approved: one installed service, one
install action, then plain `codex` and plain `grok`. This amendment introduces
no new owner choice. It applies the later approved no-hijack requirements,
closes installer and raw-path gaps found by the read-only rebase audit, and
removes the old Sol/Grok compression expectation. Implementation starts only
after Claude independently accepts this amendment.

## Required outcome

The installed login service owns one loopback listener. A normal installation
uses:

```text
127.0.0.1:47821
```

`PXPIPE_PORT` remains an optional **install-time** override for collision-free
local testing or an intentional alternate local port. If used, the installer
must write that same port into the service and both client files atomically.
It is never a per-run requirement. The normal owner workflow remains:

```text
./install.sh
codex
grok
```

No API keys, wrappers, aliases, temporary proxies, extra terminals, extra
processes, extra ports, or per-run environment variables are allowed. Codex and
Grok continue using their stored subscription logins. The reserved request
namespace alone chooses the subscription vendor; model names, request bodies,
authorization-token contents, and dashboard selections never choose a route.

## Installer-managed client configuration

`install.sh` is the sole owner of the one-time client edits. The owner does not
manually edit TOML. With the default port, the resulting Codex settings are:

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

Codex keeps its stored ChatGPT login. `supports_websockets = false` is required
so a direct WebSocket cannot bypass pxpipe.

The resulting Grok settings are:

```toml
[models]
default = "grok-4.5"

[endpoints]
cli_chat_proxy_base_url = "http://127.0.0.1:47821/_pxpipe/grok/v1"
```

Grok keeps its stored browser/subscription login. The installer must not set
`models_base_url`, which selects Grok's API-key flow.

The config editor is a tested helper shipped inside the package, not a chain of
unbounded shell substitutions. It changes only these named keys/table, preserves
unrelated bytes and owner settings, writes a same-directory temporary file, and
renames atomically. Existing file modes are preserved; newly created files are
0600. Parent directories remain owner-only.

Before the first change, the installer stores byte-exact 0600 backups and hashes
under the pxpipe install root. Reinstalling an already-correct version is
idempotent and does not stack backups. A service, health-check, parser, or config
failure restores the prior service and both client files. Uninstall restores a
backed-up file only when its current managed keys still match pxpipe's receipt;
owner edits made after installation are never overwritten and instead produce a
clear warning.

## Exact reserved route contract

Every reserved request requires a nonblank opaque `Authorization` header. The
proxy checks only presence; it never parses, decodes, hashes, prints, persists,
or guesses from the token.

| Incoming method and local route | Forwarded subscription route |
|---|---|
| `POST /_pxpipe/codex/responses` | ChatGPT Codex `/responses` |
| `GET /_pxpipe/codex/models` | ChatGPT Codex `/models` |
| `GET /_pxpipe/codex/models/<path>` | ChatGPT Codex `/models/<path>` |
| `POST /_pxpipe/grok/v1/responses` | Grok `/v1/responses` |
| `GET /_pxpipe/grok/v1/models` | Grok `/v1/models` |
| `GET /_pxpipe/grok/v1/models/<path>` | Grok `/v1/models/<path>` |
| `GET /_pxpipe/grok/v1/settings` | Grok `/v1/settings` |

Query bytes and ordering are preserved. Accepted client-supplied authorization,
account, `X-XAI-*`, `x-grok-*`, and other end-to-end headers are forwarded
unchanged; normal hop-by-hop headers are still removed by the HTTP host.

Reserved failures are local and perform zero fetches:

- missing/blank authorization: 401;
- missing or invalid configured subscription upstream: 503;
- recognized route with the wrong method: 405 with the accepted method in
  `Allow`;
- unknown reserved descendants, prefix lookalikes, malformed encodings, dot
  segments, encoded separators, literal backslashes, or duplicate reserved
  prefixes: 404.

The Node host validates the raw `IncomingMessage.url` before constructing a
WHATWG `Request`. This prevents URL normalization from turning a path such as
`/_pxpipe/codex/../grok/v1/responses` into a different credential destination.
The pure core classifier then rechecks the normalized path. Any target beginning
with the reserved-looking `/_pxpipe` prefix that is not an exact accepted shape
fails closed rather than falling into generic routing.

Existing bare Anthropic, OpenAI, and provider-prefixed routes retain their
current behavior. Existing generic Cloudflare code remains untouched, but the
local package installs no Cloudflare provider, key, gateway, or header setting.

## Exact pass-through and telemetry

Reserved Codex and Grok Responses requests use the corrected OpenAI contract:

- the forwarded body is byte-for-byte identical to the caller body;
- no JSON reserialization, history collapse, image, factsheet, label, summary,
  pointer, or generated prose is allowed;
- `compressed=false`, image count is zero, and no savings credit or compression
  baseline is emitted;
- dashboard model selection cannot enable rewriting;
- routing and redacted count/hash/status/usage telemetry still work.

The route may read the model identifier for existing non-sensitive telemetry,
but it cannot use that value to select a destination. Sequential Codex/Grok
tests must prove body, model, hash, headers, query, and destination isolation.

## Runtime configuration and credential isolation

Add optional core settings:

- `ProxyConfig.codexUpstream`
- `ProxyConfig.grokUpstream`

The Node host reads:

- `PXPIPE_CODEX_UPSTREAM`
- `PXPIPE_GROK_UPSTREAM`

The local installer persists fixed HTTPS bases:

```text
PXPIPE_CODEX_UPSTREAM=https://chatgpt.com/backend-api/codex
PXPIPE_GROK_UPSTREAM=https://cli-chat-proxy.grok.com
PXPIPE_MODELS=claude-fable-5,gpt-5.6-sol,grok-4.5
```

These values contain no credentials. Upstream values must be absolute HTTPS
URLs with no username, password, query, or fragment. Trailing slash handling is
deterministic and cannot erase the fixed Codex `/backend-api/codex` prefix.

Reserved traffic bypasses every generic override and injection path, including:

- `PXPIPE_UPSTREAM`, `ANTHROPIC_UPSTREAM`, and `OPENAI_UPSTREAM`;
- `OPENAI_API_KEY` and Anthropic key replacement;
- `PXPIPE_PROVIDER`, gateway base, and gateway headers;
- dashboard selection and any request model name.

An empty or whitespace-only `OPENAI_API_KEY` normalizes to unset and can never
produce `Authorization: Bearer `. The generated LaunchAgent contains only the
explicit local fields; hostile inherited key, upstream, provider, and gateway
variables never enter it.

## Implementation slices

Each slice is one committed unit and receives independent Claude review in a
disposable worktree under `~/Dev`, never `/private`. A finished slice is
committed and reviewed before the next begins.

### Slice 1 — core reserved router

- Add the two optional upstream settings and a pure exact route classifier.
- Preserve accepted paths, query bytes, headers, and raw bodies while stripping
  only the reserved local prefix.
- Fail every reserved auth/config/method/path error locally with the pinned
  status and zero fetches.
- Bypass generic upstream, API-key, and gateway injection.
- Prove exact OpenAI pass-through and sequential Codex/Grok isolation.

### Slice 2 — Node raw-target and environment boundary

- Validate raw request targets before WHATWG normalization.
- Read and validate the two fixed subscription upstream settings.
- Normalize empty API-key configuration to unset.
- Prove dot-segment, encoded-separator, duplicate-prefix, wrong-method, missing
  auth/config, and hostile ambient cases through the real Node HTTP boundary.

### Slice 3 — transactional installer and client configuration

- Add the minimal tested TOML editor and installer receipt/backups.
- Persist the subscription upstreams, selected install port, and existing model
  list in the LaunchAgent without inheriting ambient secrets or gateways.
- Update both client files as one rollback-safe transaction with the service.
- Prove fresh install, update, idempotence, failure rollback, permissions,
  deliberate alternate install port, and safe uninstall with later owner edits.

### Slice 4 — owner-facing release and local validation

- Replace every remaining multi-terminal instruction with `./install.sh`,
  `codex`, and `grok`; keep the old harness plan explicitly historical.
- Package the exact reviewed head directly into
  `/Users/michael/Dev/pxpipe-deploy`, verify its digest, and install it.
- Run network-denied parser checks: `codex features list` and
  `grok inspect --json`. Verify the saved URLs and provider/model values from the
  installed files and receipt without printing auth material.
- Confirm one healthy loopback listener and the exact installed source commit.

## Automated acceptance checks

1. Every tabled method/path reaches exactly its fixed vendor URL with query and
   end-to-end headers unchanged.
2. Codex and Grok request bytes and SHA-256 hashes match before/after; both report
   `compressed=false`, zero images, and no savings fields or token probes.
3. Route selection is unchanged when model names, dashboard selection, generic
   upstreams, keys, and gateway settings are adversarially varied.
4. Missing/blank authorization returns 401; bad/missing upstream returns 503;
   wrong method returns 405 plus `Allow`; malformed, lookalike, dot-segment,
   encoded-separator, backslash, duplicate-prefix, and unknown reserved paths
   return 404. Every case performs zero fetches.
5. Raw Node targets are rejected before URL normalization can change vendors.
6. Subscription requests preserve opaque authorization/account/vendor headers
   upstream but no event, log, error, dashboard, or installer receipt contains
   their values.
7. Empty `OPENAI_API_KEY` is unset; nonempty generic API keys and Cloudflare
   headers never reach a reserved request.
8. Alternating Codex/Grok fixtures retain only their own body, model, hash,
   headers, query, and destination.
9. Existing Anthropic, bare OpenAI, provider-prefixed, dashboard, privacy,
   accounting, and model-selection behavior remains green.
10. Installer output contains one service, one port, the two fixed upstreams,
    and no inherited key/provider/gateway fields. A deliberate install-time port
    override updates the service and both client URLs together.
11. Both client files preserve unrelated settings, use safe modes, update
    atomically, reinstall idempotently, roll back together on every injected
    failure, and uninstall without overwriting later owner edits.
12. Network-denied `codex features list` and `grok inspect --json` accept the
    installed TOML. No parser check launches an agent or lists remote models.

Every new behavior test receives a guard proof: temporarily remove the matching
classifier, raw-target check, or installer/config behavior; observe the focused
test fail; restore it; observe it pass. Then run:

```text
pnpm run typecheck && pnpm test && pnpm run build
```

## Independent review

Claude reviews this amended plan before implementation and reviews every slice
afterward. Reviews use disposable worktrees under `~/Dev`, never Codex and
never the implementation agent reviewing its own code. Verdicts and independent
guard proofs are recorded under `.agents/review/`.

## Local deployment and validation

After all slices are accepted:

1. Build a clean macOS package directly into
   `/Users/michael/Dev/pxpipe-deploy`.
2. Verify manifest, digest, source commit, and a synthetic no-network reserved
   routing capture.
3. Run the installer once; it updates the service and both client files.
4. Confirm launchd owns the only selected-port listener on `127.0.0.1`, the
   dashboard is healthy, and the LaunchAgent contains no secret/gateway fields.
5. Run the two network-denied parser checks and inspect only non-secret saved
   configuration values.
6. Run plain `codex --help` and `grok --help` only if another local CLI sanity
   check is needed; do not supply a prompt.

No live model request is part of installation or parser validation. A later
Codex/Grok subscription smoke remains a separate owner gate.

## Boundaries

This plan does not authorize:

- API keys or API-key authentication;
- a WebSocket proxy;
- token inspection, bearer decoding, header-based vendor guessing, or auth
  persistence;
- changes to generic Cloudflare behavior or any Cloudflare setting in the local
  service;
- an extra service, process, wrapper, alias, or per-run environment;
- OpenAI/Codex/Grok compression or savings claims;
- a public upstream contribution, pull request, merge, or push;
- a live model call or the provenance plan's live A/B matrix;
- deletion or rewriting of existing owner logs, sidecars, or client settings
  outside the exact managed keys and rollback contract.

## Acceptance

The work is complete only when one normal `./install.sh` makes plain `codex` and
plain `grok` use the one installed pxpipe service with their existing
subscriptions, while every OpenAI-family body remains byte-exact and no
credential can cross vendors. Any normal workflow that requires an extra
terminal, process, port, command, wrapper, alias, manual TOML edit, API key, or
per-run setup is a failure.
