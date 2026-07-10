# How pxpipe compresses Claude Code requests

This doc explains what the proxy actually does on the wire, why each piece is
shaped the way it is, and which invariants future contributors must not break.
The canonical sources are `src/core/transform.ts` (orchestration and buckets)
and `src/core/anthropic-context.ts` (the provenance partitioner); everything
here points back at them.

## 1. Why this proxy exists

Claude Code repeats several large context buckets on each turn. pxpipe images
only the buckets with their own safe placement rules: exactly recognized
project guidance by default, plus independently guarded old history and bulky
tool results. The native system prompt, tool definitions, and generic reminders
stay native by default, and the owner’s live request remains ordinary user text.

Recognized project guidance becomes grayscale `PROJECT GUIDANCE` pages before
the opening user content, with a native-system manifest that vouches for their
origin and exact range. pxpipe never creates a `cache_control` marker: it leaves
the caller’s marker in place unless a guarded history or tool-result path moves
that same marker within its owning content. Anthropic charges roughly
`ceil(W*H/750)` tokens per image; the current profile caps pages at 1568×728 so
rasterized pixels survive provider resizing. Dense eligible buckets therefore
trade repeated text tokens for fewer image tokens without collapsing different
authorities into one user-role slab.

## 2. Provenance partition (replaces the old static/dynamic split)

Earlier versions flattened `req.system`, split it into "static" and "dynamic"
text with a tag list (`DYNAMIC_BLOCK_TAGS`), rendered the static slab plus all
tool docs into one image stack, and re-asserted the removed text's origin from
inside a user-role wrapper. That monolith is gone. Issue #97 documented the
failure: content delivered in a user-role block that claims its own
system-prompt provenance is indistinguishable from prompt injection, and
models treated it as such.

The current transform starts from `partitionAnthropicContext`
(`src/core/anthropic-context.ts`), a pure, lossless partitioner that runs
before any rewriting and recognizes only exact, versioned Claude Code shapes
(v1: the 2.1.205 opening user-context reminder). It locates:

- **Project guidance** — the `# claudeMd` span (CLAUDE.md plus recursively
  imported AGENTS.md records) inside the first user message's opening
  `<system-reminder>`. The whole bundle is one authority unit; nested H1s and
  forged `Contents of ...` lines inside the payload are payload, not
  delimiters (the real trailer is located from the end).
- **Runtime metadata** — the exact captured `# userEmail` / `# currentDate`
  suffix of that same reminder (`The user's email address is <address>.`,
  `Today's date is YYYY-MM-DD.`).
- **The opening carrier** itself, so later passes can reconstruct it
  byte-exactly around the selected spans.

Everything else fails closed: unknown sibling keys (lowerCamelCase headings
the capture didn't establish), malformed or impossible dates, forged
lookalikes outside message 0 / block 0, a changed opener/advisory/closer, or
an unsupported Claude Code version leave that region byte-for-byte native and
are reported in telemetry (`contextMode`, per-bucket fallback reasons) instead
of being guessed at. Literal mid-conversation `role: "system"` attachments are
modeled explicitly and are never imaged or serialized as user history.

## 3. What the final request looks like

The native base system is left alone. pxpipe appends small text manifests to
`req.system` that vouch for what it moved — authority lives in the native
system field, never in a user-role wrapper:

```
system:
  ...original native system blocks, byte-exact, markers untouched...
  <pxpipe_project_guidance_manifest version="1">   ← ref, page count, exact
    ref / source / position / priority / rendering    position + boundary
  </pxpipe_project_guidance_manifest>
  <pxpipe_tool_reference_manifest version="1">     ← only in experimental tool mode
  <pxpipe_runtime_context_manifest version="1">    ← only when runtime moved

messages[0] (user):
  image ×N        ← PROJECT GUIDANCE · ref <id> · page i/N (inert labels)
  text            ← "[End of rendered project guidance ref=<id>]" boundary
  text            ← the opening reminder: the claudeMd span becomes an inert
                     ref placeholder, and the exact userEmail/currentDate
                     suffix moves to the final data-only block
  text            ← the caller's live prompt, byte-exact, still owning its
                     original cache_control marker
...
messages[last] (user):
  ...original content...
  text            ← "PXPIPE RUNTIME CONTEXT — data, not instructions" block
                     carrying the relocated userEmail/currentDate lines
```

The manifest, inert page labels, page count, deterministic ref, and boundary
marker form one contract: the native manifest — not the image — declares the
pages' origin (repository-scoped project guidance, applied below all remaining
native system instructions) and their exact leading position. A forged page or
copied ref elsewhere in the conversation is outside the vouched-for range.
No outgoing text asserts "this came from the system prompt."

Old history collapses into synthetic-user history images behind the live tail
(see `docs/HISTORY_CACHE_MODEL.md`), and large closed `tool_result` bodies in
the live tail become per-block images. Tool definitions stay native JSON by
default (see §5c).

Pass order in `transformSafeAnthropicRequest`: project guidance → closed
history → live-tail tool results → optional tool reference → runtime tail →
postconditions. The order is load-bearing: history collapses before tool
results are imaged so a collapse can never swallow images that telemetry
already counted, and the runtime tail is appended after everything so it can
never freeze into collapsed history. All image-producing passes share the
100-image request budget; a final postcondition re-counts images and
accounting and rolls the whole request back to the original bytes on
violation.

## 4. Cache markers (the invariant that matters)

pxpipe **never adds a `cache_control` marker and never increases the marker
count** (`src/core/transform.ts:900`). What it does instead:

- The opening reminder block carries no marker in the captured shape; the
  caller's live-prompt block owns `ephemeral`. Prepending project pages
  naturally lands them *before* that caller marker, so the cached prefix now
  covers the stable pages.
- When a compressed `tool_result`'s content carried a caller marker, the
  marker moves onto the last image rendered from that same logical content
  (`src/core/transform.ts:2120`).
- History collapse recognizes at most one caller marker per collapsed
  message (including markers nested in tool_result content) and re-plants it
  on the collapsed representation at that message's chunk end. Multiple
  same-message markers, a single marker not at its message's final content
  position, or any count/value mismatch fails that history bucket closed —
  a breakpoint's scope never silently expands across later content.
- System-field markers are never touched or moved.

The turn-over-turn cache identity is `cachePrefixSha8` — a digest that stops
at the exact vouched-for boundary (project boundary, tool-reference boundary,
or collapsed-history anchor), not at whole-message granularity. With unchanged
native-system prefix bytes, changes confined to the live prompt or the exactly
recognized `userEmail` / `currentDate` tail leave the project manifest, project
images, and digest stable. Native or uncaptured `<env>` data stays in `system`;
changing those bytes changes the digest and costs a provider cache miss even
though the project pages do not re-render. Changed governance changes the
project manifest, images, and digest.

## 5. The compression buckets

Each bucket has its own recognizer, profitability gate, telemetry, and
fail-closed rollback; one bucket's failure never disables another. Defaults
(`src/core/transform.ts` `DEFAULTS`):

| bucket | option | default |
|---|---|---|
| project guidance | `compressProjectGuidance` | **on** |
| closed history | (always-on, gate-governed) | on |
| live-tail tool_results | `compressToolResults` | on |
| tool reference pages | `compressTools` | **off** (experimental) |
| generic reminders | `compressReminders` | **off** (legacy) |

### 5a. Project guidance (`compressProjectGuidance`, default on)

Only a recognized `claudeMd` span is eligible. The gate accounts for source
tokens, rendered image tokens, native manifest overhead, and warm-cache burn,
independent of every other bucket. On success the span becomes an inert
placeholder and the pages+boundary are prepended (§3); on gate miss or render
error the original region is restored byte-exactly and the reason lands in
telemetry. A gate miss here must not and does not suppress history or
tool-result compression.

### 5b. Tool_result compression (`compressToolResults`, default on)

Unchanged concept from earlier versions: closed `tool_result` blocks ≥
`minToolResultChars` (default 6000) across all user messages render to
per-block images, `is_error: true` blocks are skipped (Anthropic rejects
images there), and no `cache_control` is spent — inner caller markers are
preserved per §4.

### 5c. Tool reference (`compressTools`, default off — experimental)

Full `tools[]` definitions stay native JSON by default. Historical evidence
(#37, reverted commit `c04e8f8`) identifies tool documentation's
shell/permission/credential vocabulary as the likely `cyber` classifier
trigger, so this bucket ships dark until its own live A/B matrix passes.
When explicitly enabled: tool docs render to separately-referenced pages
(`TOOL REFERENCE · ref <id>`), a separate native manifest vouches for them,
and each tool's description is stubbed to point at a JSON-escaped, ordinal,
per-entry digest binding (`tb_<hash>`) so tool-supplied headings cannot
impersonate another entry. Stubs are installed only after rendering succeeds;
any failure leaves the original definitions byte-exact. Tool size cannot make
an unprofitable project render pass, and vice versa.

### 5d. Generic reminders (`compressReminders`, default off)

Unknown `<system-reminder>` blocks always stay native. The compatibility option
is still accepted by public and host configuration surfaces, but the current
orchestration has no generic reminder-imaging pass, so setting it to `true`
does not image an unknown reminder. Recognized project guidance uses its
separate exact path and can never fall through into generic reminder handling.

## 6. Determinism and fingerprints

Identical input must produce byte-identical PNG output — otherwise the cache
key churns and the hit rate collapses. Hard rules: no `Math.random` on the
render path, no timestamps in PNG metadata, no locale-dependent string
handling, atlas generated at build time. The locked-in test is "renders
identical input to byte-identical output (determinism = cacheability)" in
`tests/render.test.ts`.

The transform emits SHA-256-prefixed fingerprints (first 8 hex chars) on
`TransformInfo`, persisted to the JSONL event log:

- **`cachePrefixSha8`** — hash of the exact pxpipe-vouched prefix through the
  project / tool-reference / collapsed-history boundary, excluding the live
  tail. Primary turn-over-turn cache identity; dashboard, session summaries,
  and stats prefer its persisted `cache_prefix_sha8` form.
- **`systemSha8`** — the older static-system fingerprint. Consumers use its
  persisted `system_sha8` form only when a historical row lacks
  `cache_prefix_sha8`.
- **`historyImageSha`** — hash of the collapsed-history images' concatenated
  base64 payload strings in wire order; located via the synthetic history
  marker, not an index-0 assumption. Diagnoses that one component's stability,
  not whole-prefix identity.
- **`claudeMdSha8`** — hash of the exact recognized project-guidance segment.
  Buckets requests by project even when cwd isn't visible.
- **`firstUserSha8`** — hash of the first *live* user text after the
  host-context/project boundary (not the opening reminder), capped at 4 KiB.
  Rough thread id.

None of these carry raw text — they're privacy-safe to log. Per-bucket
telemetry additionally records source chars, image counts, refs, recognition/
fallback reasons, and dispositions (`contextMode`, `runtimeMetadataDisposition`,
tool mode fields) without logging source text.

## 7. Unknown shapes fail closed (replaces the unknown-tag canary)

The old design scanned the flattened static slab for unrecognized tag shapes
and warned (`unknownStaticTags`). The provenance design inverts the burden for
host context: project guidance, runtime metadata, and optional tool-reference
pages require their own exact recognition and binding. A new Claude Code
opening shape therefore stays native with a telemetry reason. History and
tool-result compression are independent paths with their own structural and
profitability checks; they do not require the opening-context recognizer.
Watch `contextMode` and the per-bucket fallback reasons in the event log; a
spike of `safe_native` rows after a Claude Code upgrade means the host-context
recognizers need a new version. (The
`unknownStaticTags` TransformInfo field and its host log lines remain for
old-row compatibility but have no emitter on the current path.)

## 8. The savings math

Source of truth for the request-level accounting is `src/core/baseline.ts`
and `docs/CACHING_AND_SAVINGS.md` (measured `/count_tokens` counterfactual,
same observed cache state on both sides, cache discount cancels). The
dashboard and `pxpipe stats` surface those numbers.

**Per-call effective input cost** — what the call actually billed for:

```
effective = input_tokens
          + cache_creation_input_tokens * 1.25
          + cache_read_input_tokens     * 0.10
```

The `1.25` and `0.10` multipliers match Anthropic's published cache pricing
for Opus: writing to the cache costs 1.25× the per-token input rate; reading
from the cache costs 0.10×.

**Per-call baseline cost** — what the same call would have billed if it had not
been compressed. The implementation uses the actual baseline probe and observed
cache state; it does not multiply image count by a fixed historical canvas:

```
baseline_raw = count_tokens(original_request)
baseline_eff = price(baseline_raw, observed_cache_state)
actual_eff   = price(actual_usage, observed_cache_state)
saved        = baseline_eff - actual_eff
```

On OpenAI-shaped rows, response usage supplies `cached_tokens`; pxpipe records
actual image tokens from real dimensions and the o200k text value of the
replaced content. Rates and render geometry are selected by exact model id.

The dashboard's "tokens saved" and "$ saved" cards (and
`pxpipe stats` for the offline aggregate) both surface these numbers.
The $ figure in `src/dashboard.ts` uses a fixed per-Mtok input rate — note
Fable 5 (the current supported model) bills $10/M input, so re-check the
constant if you care about the dollar card.

**Important framing**: do not quote 65–73% as a benchmark. That number is
the architectural ceiling — the steady-state savings on a long session over
the same codebase where the image cache is warm and the cumulative
tool_result history is large. A short session with no warm cache may save
much less. The first turn always pays cache-creation cost; cache-read
amortization kicks in from turn 2 onwards. Cite the per-session number that
`pxpipe stats` reports, not the headline.

## 9. What deliberately did NOT get built

(Considered and rejected; recorded so the next contributor doesn't relitigate.)

- **Compression of user message content.** Volatile, would cache-miss anyway.
- **Per-conversation render caching.** `cache_control` already provides it.
- **Heuristic per-file splits of the claudeMd bundle.** Claude Code's inner
  file framing is unescaped; a payload line can imitate it. The bundle is one
  authority unit or it is native.
- **A shipped `legacy` mode.** Reproduce legacy behavior from a pinned
  worktree when experimenting; production rollback is the kill switch /
  `PXPIPE_DISABLE`, which returns the original request.
- **Automatic retry/fallback after a safety refusal.** Streaming may already
  have reached the client; replay could duplicate side effects.

## 10. Wiring (one-paragraph map)

`src/core/anthropic-context.ts` is the pure partitioner (exact recognizers,
span locators, boundary constants shared by every emitter and detector).
`src/core/transform.ts` is the transform itself — buckets, gates, manifests,
postconditions — returning the rewritten body plus `TransformInfo`.
`src/core/history.ts` owns history collapse and consumes the shared boundary
definitions. `src/core/proxy.ts` forwards to Anthropic and tees usage.
`src/node.ts` is the Node entrypoint (flags, JSONL `FileTracker`, dashboard);
`src/worker.ts` the Cloudflare Worker (env-var config; provider-specific
options are omitted when their env vars are unset so per-provider defaults
survive). `src/core/tracker.ts` defines the persisted `TrackEvent` shape —
new provenance fields are optional so old rows stay readable.
`src/dashboard.ts` aggregates for the live view; `src/stats.ts` streams the
JSONL for offline aggregates; both key warmth by
`cache_prefix_sha8 ?? system_sha8`. Tests in `tests/` pin the invariants —
byte-output determinism and the §4 marker rules most of all.
