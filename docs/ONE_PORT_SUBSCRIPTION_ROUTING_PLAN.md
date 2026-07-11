# One-port subscription routing

Status: **APPROVED FOR IMPLEMENTATION 2026-07-11 — CLAUDE R4 ACCEPTED AT
`e882aff`; SIMPLE-USE OUTCOME REMAINS OWNER-APPROVED**.

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
must write that same port into the service and both client files within the same
journaled, recoverable transaction.
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

The committed receipt is a source-edit ledger, not merely a value ledger. For
every pre-existing target it records the exact original and applied scalar
right-hand-side span bytes plus its unique parsed table/key identity; inline
comments and every byte outside that scalar span remain owner data. For every
insertion it records the exact inserted byte span, including separator bytes,
and its unique parsed table/key identity. A newly inserted table header is a
separate span. Neighboring hashes may help diagnose a race, but surrounding
owner bytes are not part of the ownership proof and may change freely.

The receipt also records whether each config file and parent directory existed
before pxpipe. Uninstall reverses only the scalar span of a pre-existing target,
and only when its current bytes exactly equal the recorded applied bytes. It
removes an insertion only when its parsed identity is unique and its exact bytes
match the receipt. Equal decoded values in an unrecorded or duplicate location
do not prove ownership. A created table header is removed only after its managed
children are removed and the table contains no owner key, comment, or trivia. A
file created by pxpipe is deleted only when its complete bytes, owner, and mode
still match the applied receipt; otherwise only proven managed spans are removed
and the file is retained. A directory created by pxpipe is removed only when it
is empty after file handling. Any changed, duplicated, or ambiguous managed span
is a conflict and stays byte-for-byte untouched.

Receipt absence is allowed only for the first managed one-port install. That path
requires no pending/conflicted transaction and none of these exact parsed client
footprints: Codex root `model_provider = "pxpipe_local"`, the Codex table
`[model_providers.pxpipe_local]`, any Codex provider `base_url` equal to a
loopback `/_pxpipe/codex` URL, or Grok
`[endpoints].cli_chat_proxy_base_url` equal to a loopback
`/_pxpipe/grok/v1` URL. The already common model values alone are not ownership
evidence. An existing pre-ledger pxpipe service is
adopted only after its release manifest, source digest, current link, plist,
loopback binding, and ownership pass the existing installer checks; the service
alone is not treated as prior client-config ownership. A corrupt receipt or a
missing receipt beside any managed client footprint fails before mutation rather
than guessing ownership.

A reinstall loads and validates the receipt before opening a transaction. Every
managed pre-existing scalar must still match its exact last-applied bytes and
every managed insertion must still satisfy its recorded identity/span proof.
Managed drift or ambiguity aborts with zero service, config, snapshot, journal,
or receipt mutation. Unrelated edits outside managed spans are allowed and new
candidates are built from the latest bytes. An already-correct reinstall is a
no-op that does not add snapshots or change mtimes.

A fixed 0600 lock file under the stable 0700 install-state root serializes
install, uninstall, and recovery before any journal inspection. The contender
first writes and fsyncs a complete private candidate containing uid, pid,
process-start signature, and operation, then claims the fixed name with an atomic
no-clobber hard link. There is no interval where the visible lock lacks a complete
record. A live matching process makes a second invocation fail with zero
mutations. A missing/corrupt or non-live record is claimed stale by atomic rename
to a unique quarantine name before a new no-clobber link attempt; pid reuse alone
cannot prove liveness. Creating the empty state/lock parent and candidate is the
only allowed pre-lock filesystem preparation. Process death is injected before
and after every lock step. The empty state root is retained across uninstall so
the fixed lock continues to exclude contenders through the final mutation.

Every mutation uses a 0700 transaction directory. The installer first commits
and fsyncs a minimal 0600 journal in phase `preparing`, then writes byte-exact
0600 snapshots one at a time and atomically updates/fsyncs the journal with each
snapshot identity. A crash while preparing owns no active service/config change;
the next lock holder verifies that phase and removes the recorded partial
transaction before proceeding. Only a fully snapshotted `ready` journal permits
an active mutation. Subscription token stores are never read or copied, and
snapshot contents never enter output.

The journal records a transaction ID, operation, phase, and prior/intended
receipt identity, where each receipt identity is either a SHA-256 hash or the
explicit sentinel `absent`. It also records prior/applied existence, owner, mode,
hash, and snapshot path for the release pointer, service definition/state, both
client files, and any directories the transaction created. Journal creation and
every phase transition use atomic rename plus file and parent-directory fsync.
This contract covers process death, handled signals, and ordinary OS restart.
Plain Node/shell fsync does not provide macOS `F_FULLFSYNC`, so the plan makes no
claim that an abrupt loss of power preserves drive-cache ordering.

Every invocation recovers a pending journal while holding the exclusive lock. If
the intended receipt identity is already durably present — including `absent`
after a completed uninstall — it treats the transaction as committed and only
finalizes cleanup. Otherwise it runs the same rollback engine used by
ERR/INT/TERM, restores and fsyncs prior state, removes and fsyncs the journal,
then may start the requested operation. The intended identity is journaled before
the receipt rename/removal, so a crash at that boundary cannot turn a completed
transaction into a rollback.

All uninstall ownership checks complete before the journal, service, or either
config is changed. Any conflict aborts the entire uninstall with zero mutations
and leaves the working service available. Install order is: preflight and
validate isolated candidates; prepare journal/snapshots; switch, start, and
health-check the service; apply Codex; apply Grok; hash-check installed bytes;
commit the receipt; mark committed; clean the journal. Uninstall order is:
preflight every reversal; prepare journal/snapshots; restore Codex; restore Grok;
hash-check both; stop/remove the service definition and current link; commit the
`absent` receipt identity; mark committed; then remove releases, snapshots,
journal, and per-transaction directories; release the lock only after the final
mutation. The stable empty install-state/lock parent remains 0700. This ordering
never points a client at a service already removed and never exposes final cleanup
to a second installer.

No receipt is rewritten during a partial operation. Until every install step
succeeds, the prior receipt remains authoritative; until every uninstall step
succeeds, the installed receipt remains authoritative. A handled failure rolls
all resources back to that receipt. A detected concurrent conflict keeps the
prior receipt plus the `conflicted` journal, which is the sole record that the
resources may temporarily be mixed; it never drops only one managed target.

Rollback and crash recovery compare before writing. A resource matching its
prior identity is a no-op; one matching its applied identity may be restored;
any detected third identity enters conflict and is not overwritten. Each safe
restore is journaled and fsynced. Conflict atomically marks the journal
`conflicted`, reports only path and hashes, retains snapshots, exits nonzero, and
blocks later install/uninstall mutations until every conflicted resource matches
a recorded safe identity. Recovery then resumes deterministically.

The lock coordinates pxpipe processes, not arbitrary editors. Portable shell and
Node file APIs cannot perform a cross-process compare-and-swap rename, so the
installer does not claim to preserve an uncooperative owner write made in the
final interval between its last identity check and atomic rename. It warns not to
edit either config during installation, rejects every race visible at its
pre-write and post-write checks, retains the last checked snapshot, and never
silently calls that narrow residual race safe. Each file replacement is atomic;
the journal supplies multi-resource recovery rather than impossible simultaneous
cross-file atomicity. One ERR/INT/TERM trap invokes the journaled rollback engine.

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
- Add the exclusive installer lock, first-managed-install/legacy-service
  preflight, preparing journal, explicit absent receipt identity, and
  crash/conflict recovery state.
- Persist the subscription upstreams, selected install port, and existing model
  list in the LaunchAgent without inheriting ambient secrets or gateways.
- Update both client files as one rollback-safe transaction with the service.
- Prove fresh/missing/existing configs, line-ending/BOM/comment preservation,
  update, idempotence/mtime, ownership/modes, every injected failure rollback,
  deliberate alternate install port, abrupt-death recovery, durable conflict
  handling, simultaneous-invocation refusal, created-file ownership, and
  exact-span uninstall/reinstall with later owner edits.

### Slice 4 — owner-facing release and local validation

- Replace every remaining multi-terminal instruction with `./install.sh`,
  `codex`, and `grok`; keep the old harness plan explicitly historical.
- Package the exact reviewed head directly into
  `/Users/michael/Dev/pxpipe-deploy`, verify its digest, and install it.
- Run `codex features list` and
  `grok inspect --json --leader-socket <fresh-short-private-socket>` under
  macOS `sandbox-exec` against byte-identical config copies in a 0700 isolated
  home and empty working directory. Resolve the installed Codex native executable
  behind its Node launcher and the real Grok Mach-O, verify each reports the
  expected installed version, copy and hash those exact binaries into the check
  directory, and allow initial execution only of those staged paths. Deny network,
  reads from the real home, writes outside the private check directory, process
  fork, and every other executable path.
  The Grok socket uses a short random name directly under a temporary 0700
  `${OWNER_HOME}/.pxpipe-s/` child while the subprocess `HOME` remains isolated,
  is at most 90 UTF-8 bytes including its filename, and fails before mutation if
  that budget cannot be met. The directory and socket
  are removed afterward; the check never uses, connects to, creates, or changes
  the default `~/.grok/leader.sock`, and fork denial prevents an orphan leader.
  Capture/discard command output. After each real install write, compare its hash
  and mode with the already parsed candidate instead of invoking either CLI
  against the owner's home or credential stores.
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
14. Each file replacement is atomic; the journaled pair rolls back with the
    service on every injected handled failure. Reinstall has no churn, and every
    owner edit visible at the pinned identity checks is preserved or fails
    closed. The final non-cooperating editor race is explicitly not claimed safe.
15. Sandboxed network-denied `codex features list` and
    `grok inspect --json --leader-socket <fresh-short-private-socket>`
    use hash-verified staged copies of the resolved native Codex and Grok
    executables with byte-identical TOML under an isolated HOME and empty cwd.
    Real-home reads, outside writes, fork, and every other executable are denied.
    The Grok socket path is private and no longer than 90 UTF-8 bytes. The default
    leader socket and credential stores are not contacted, read, created, or
    changed; no background leader, agent, model listing, or output survives.
    Installed files are verified by hash/mode comparison only.
16. Fresh-file install/uninstall restores the original bytes exactly. Inserted
    keys and table headers are removed only through their recorded parsed identity
    and exact span proofs; owner keys, comments, and trivia survive relocation and
    unrelated surrounding edits. Equal-valued unrecorded or duplicate lines are
    never deleted.
17. Original file/directory absence is recorded. A pxpipe-created file is deleted
    only while wholly unchanged; owner additions cause proven managed spans to be
    removed while the file remains. Created directories remain unless empty.
18. Receipt-free first install accepts the verified pre-ledger service on this
    Mac only when the four enumerated parsed Codex/Grok footprints are absent.
    Matching model values alone remain unowned. Any enumerated footprint with a
    missing/corrupt receipt fails before mutation.
19. Reinstall with unrelated edits succeeds and preserves them. Reinstall with
    managed drift fails before journal, service, config, snapshot, or receipt
    mutation; all hashes and mtimes remain unchanged.
20. Concurrent install/uninstall attempts prove the live pid/start lock holder
    wins and every other invocation performs zero mutations. Stale-lock recovery
    cannot mistake pid reuse for the original process. Death at every candidate,
    hard-link, stale-quarantine, and release step leaves a recoverable complete
    lock record; final cleanup stays excluded until the lock is released.
21. Process death is injected after the preparing journal, each snapshot, ready
    transition, service switch, each client write, validation, receipt
    rename/removal, and journal commit. The next lock holder removes preparation
    debris, restores the prior state, or recognizes the intended committed
    receipt identity; it never accepts a mixed state. Power-loss durability is
    explicitly outside this plain-fsync contract.
22. Every uninstall reversal is preflighted before mutation. A changed or
    ambiguous managed span leaves the service, configs, receipt, hashes, and
    mtimes unchanged. Successful uninstall commits explicit receipt absence and
    removes transaction data only after journal cleanup while retaining the
    stable 0700 lock parent. Failure after either client reversal restores both
    and leaves the installed receipt unchanged; a detected race retains that
    receipt plus the conflicted journal.
23. A detected concurrent owner edit enters durable `conflicted`, retains
    snapshots, reports no contents, and blocks later mutations until a recorded
    safe identity returns. Tests separately document the unavoidable final
    non-cooperating editor race; no assertion promises impossible compare-and-swap
    behavior.
24. Candidate parser checks use isolated copies and the fresh Grok leader socket
    plus staged verified native binaries under the complete sandbox above. Tests
    prove the real home, installed binaries, default socket, credential stores,
    network, fork, and other executables are untouched; socket length is bounded,
    output is discarded, no orphan process remains, and installed files match the
    parsed candidate hashes.

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
