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
unbounded shell substitutions. It accepts only the fixed Codex/Grok targets and
an integer port. It preserves BOM, LF/CRLF choice, final-newline state, comments,
spacing, unrelated keys, and every unrelated byte; exact scalar right-hand sides
are replaced and missing keys/tables are inserted deterministically. It rejects
ambiguous duplicate/quoted/dotted/array target shapes, multiline target values,
invalid UTF-8/TOML, symlinks, non-regular files, ownership changes, pre-write hash
races, and a pre-existing Grok `models_base_url` rather than deleting owner data
or silently selecting the API-key flow.

Writes use same-directory temporary files, fsync, and atomic rename. Existing
file modes are preserved exactly; newly created files are 0600. Existing parent
directories must be owned by the current user and not group/world-writable but
keep their existing mode (0755 is valid). Missing parent directories are created
0700. The installer never silently chmods an owner file or directory.

Before the first change, the installer stores byte-exact 0600 backups and hashes
under a 0700 directory inside the pxpipe install root. Those backups contain only
the client config bytes the owner already had; subscription token stores are
never read or copied, and backup contents are never logged. Reinstalling an
already-correct version is idempotent and does not stack backups or change
mtimes.

The receipt records each managed key's original presence/value and last applied
value. Later unrelated owner edits survive reinstall. Uninstall reverses a
managed key only when it still equals pxpipe's last applied value; an owner-changed
managed key is left untouched with a warning. Inserted tables are removed only
when no unrelated keys remain. A service, health-check, parser, config, signal,
or injected write failure restores the prior service and both per-run config
snapshots, guarded by whole-file hashes so rollback cannot overwrite a concurrent
owner edit.

Transaction order is fixed: preflight both source files and build both candidates;
validate the candidates with network denied in isolated homes; stage per-run
snapshots; switch/start/health-check the service; atomically apply both client
files; validate the installed files with network denied; then commit the receipt.
One ERR/INT/TERM trap owns rollback. Applying client URLs only after service
health prevents a half-install from pointing either client at a dead listener.

## Exact reserved route contract

Every reserved request requires a nonblank opaque `Authorization` header. The
proxy checks only presence; it never parses, decodes, hashes, prints, persists,
or guesses from the token.

| Incoming method and local route | Forwarded subscription route |
|---|---|
| `POST /_pxpipe/codex/responses` | ChatGPT Codex `/responses` |
| `POST /_pxpipe/codex/responses/compact` | ChatGPT Codex `/responses/compact` |
| `GET /_pxpipe/codex/models` | ChatGPT Codex `/models` |
| `GET /_pxpipe/codex/models/<path>` | ChatGPT Codex `/models/<path>` |
| `POST /_pxpipe/grok/v1/responses` | Grok `/v1/responses` |
| `GET /_pxpipe/grok/v1/models` | Grok `/v1/models` |
| `GET /_pxpipe/grok/v1/models/<path>` | Grok `/v1/models/<path>` |
| `GET /_pxpipe/grok/v1/models-v2` | Grok `/v1/models-v2` |
| `GET /_pxpipe/grok/v1/settings` | Grok `/v1/settings` |
| `GET /_pxpipe/grok/v1/login-config` | Grok `/v1/login-config` |
| `GET /_pxpipe/grok/v1/subagents/bundle` | Grok `/v1/subagents/bundle` |

The installed Codex binary contains a dedicated compact endpoint and literal
`/responses/compact`. The installed Grok binary names model refresh,
login-policy, settings, and subagent-bundle fetches against its cli-chat-proxy
base. These exact auxiliaries are allowlisted so plain client startup/refresh
does not silently lose a feature; arbitrary descendants remain closed.

The exact serialized query suffix is preserved, including a trailing empty `?`,
duplicate keys, empty values, `+`, ordering, and percent-escape casing. Neither
`URL.searchParams` nor query reconstruction is allowed. Accepted client-supplied
authorization, account, `X-XAI-*`, `x-grok-*`, and other end-to-end headers are
forwarded unchanged.

The forwarding filter removes `host`, computed length/encoding fields, the
standard hop-by-hop set (including `te`, `trailer`, proxy auth, connection,
keep-alive, transfer-encoding, and upgrade), and every header named by
`Connection`. If `Connection` nominates authorization or another required
end-to-end field, the request fails locally instead of forwarding a partial
credential set. Existing generic-route header behavior receives regression
coverage; reserved safety does not depend on blindly copying `Headers`.

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
It splits only at the first `?`, validates the path without decoding the query,
and rejects invalid percent escapes, encoded slash/backslash/percent, literal
backslash or fragment, literal/encoded dot segments, empty/duplicate reserved
segments, repeated prefixes, and absolute-form reserved targets. The pure core
classifier then rechecks the normalized path. Any target beginning with the
reserved-looking `/_pxpipe` prefix that is not an exact accepted shape fails
closed rather than falling into generic routing.

Existing bare Anthropic, OpenAI, and provider-prefixed routes retain their
current behavior. Existing generic Cloudflare code remains untouched, but the
local package installs no Cloudflare provider, key, gateway, or header setting.

## Exact pass-through and telemetry

Reserved Codex Responses, Codex remote-compaction, and Grok Responses requests
use the corrected OpenAI contract:

- the forwarded body is byte-for-byte identical to the caller body;
- no JSON reserialization, history collapse, image, factsheet, label, summary,
  pointer, or generated prose is allowed;
- `compressed=false`, image count is zero, and no savings credit or compression
  baseline is emitted;
- dashboard model selection cannot enable rewriting;
- routing and redacted count/hash/status/usage telemetry still work.

The route may read the model identifier for existing non-sensitive telemetry,
but it cannot use that value to select a destination. Auxiliary GET routes do
not invent a body or compression event. Sequential Codex/Grok tests must prove
body, model, hash, headers, query, and destination isolation.

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

Reserved classification and vendor-base validation occur independently before
generic upstream resolution. An invalid generic provider/gateway configuration
is retained as an error for generic traffic but cannot make proxy construction
or a valid reserved request fail before the reserved route is seen. Conversely,
an invalid reserved base cannot affect generic traffic until that vendor's
namespace is requested.

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
- Cover Codex Responses/compact/models and the exact Grok Responses/model/
  settings/login-config/subagent auxiliaries proven by installed-client evidence.
- Preserve accepted paths, the serialized query suffix, end-to-end headers, and
  raw bodies while stripping only the reserved local prefix and complete
  hop-by-hop set.
- Fail every reserved auth/config/method/path error locally with the pinned
  status and zero fetches.
- Bypass generic upstream, API-key, and gateway injection.
- Keep reserved base validation independent from eager generic-route errors.
- Prove exact OpenAI pass-through and sequential Codex/Grok isolation.

### Slice 2 — Node raw-target and environment boundary

- Validate raw request targets before WHATWG normalization.
- Read and validate the two fixed subscription upstream settings.
- Normalize empty API-key configuration to unset.
- Prove absolute-form, dot-segment, malformed/encoded separator/percent,
  backslash/fragment, duplicate-prefix, wrong-method, missing auth/config, and
  hostile ambient cases through the real Node HTTP boundary.

### Slice 3 — transactional installer and client configuration

- Add the source-preserving fixed-target TOML editor and surgical receipt/
  backup/rollback behavior, including ambiguous-shape and API-key-flow refusal.
- Persist the subscription upstreams, selected install port, and existing model
  list in the LaunchAgent without inheriting ambient secrets or gateways.
- Update both client files as one rollback-safe transaction with the service.
- Prove fresh/missing/existing configs, line-ending/BOM/comment preservation,
  update, idempotence/mtime, ownership/modes, every injected failure rollback,
  deliberate alternate install port, and surgical uninstall/reinstall with
  later owner edits.

### Slice 4 — owner-facing release and local validation

- Replace every remaining multi-terminal instruction with `./install.sh`,
  `codex`, and `grok`; keep the old harness plan explicitly historical.
- Package the exact reviewed head directly into
  `/Users/michael/Dev/pxpipe-deploy`, verify its digest, and install it.
- Run `codex features list` and `grok inspect --json` under macOS
  `sandbox-exec` with network denied, isolated candidate homes before writes and
  the real home after installation. Capture/discard their output and verify the
  saved URLs and provider/model values without printing auth material.
- Confirm one healthy loopback listener and the exact installed source commit.

## Automated acceptance checks

1. Every tabled method/path, including Codex `/responses/compact` and the exact
   Grok auxiliaries, reaches exactly its fixed vendor URL.
2. Trailing `?`, duplicate/empty query keys, `+`, order, and percent-escape case
   remain exact. End-to-end headers remain exact; the full hop-by-hop set and
   `Connection`-nominated headers do not forward.
3. Codex Responses/compact and Grok Responses bytes and SHA-256 hashes match
   before/after; all report `compressed=false`, zero images, and no savings
   fields or token probes.
4. Route selection is unchanged when model names, dashboard selection, generic
   upstreams, keys, and gateway settings are adversarially varied.
5. Missing/blank authorization returns 401; bad/missing upstream returns 503;
   wrong method returns 405 plus `Allow`; malformed, lookalike, dot-segment,
   invalid-percent, encoded-separator/percent, backslash/fragment,
   absolute-form, duplicate-prefix, and unknown reserved paths return 404. Every
   case performs zero fetches.
6. Raw Node targets are rejected before URL normalization can change vendors.
7. Subscription requests preserve opaque authorization/account/vendor headers
   upstream but no event, log, error, dashboard, or installer receipt contains
   their values.
8. Empty `OPENAI_API_KEY` is unset; nonempty generic API keys and Cloudflare
   headers never reach a reserved request.
9. Alternating Codex/Grok fixtures retain only their own body, model, hash,
   headers, query, and destination.
10. Existing Anthropic, bare OpenAI, provider-prefixed, dashboard, privacy,
   accounting, and model-selection behavior remains green.
11. Invalid generic gateway/provider configuration cannot preempt a valid
    reserved request; the stored generic error still governs generic traffic.
12. Installer output contains one service, one port, the two fixed upstreams,
    and no inherited key/provider/gateway fields. A deliberate install-time port
    override updates the service and both client URLs together.
13. Both client files preserve unrelated bytes, existing modes, BOM/line
    endings/comments/final-newline state, and safe ownership; new files/dirs use
    0600/0700. Ambiguous targets, races, symlinks, and `models_base_url` fail
    before writes.
14. Both files update atomically, reinstall without churn, roll back with the
    service on every injected failure, and surgically uninstall/reinstall
    without overwriting later owner edits.
15. Sandboxed network-denied `codex features list` and `grok inspect --json`
    accept candidate and installed TOML. No parser check launches an agent,
    lists remote models, or prints its output.

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
5. Run the two parser checks under `sandbox-exec` with `deny network*`, discard
   their output, and inspect only non-secret saved configuration values.
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
