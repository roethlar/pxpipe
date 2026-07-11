# How pxpipe safely transforms requests

This document describes the behavior that is currently allowed to reach an
upstream model. The main code paths are `src/core/transform.ts`,
`src/core/anthropic-exact.ts`, `src/core/no-hijack.ts`,
`src/core/admission.ts`, and `src/core/proxy.ts`.

Older helpers for manifests, relocated metadata, tool-reference pages, and
history images remain in the source tree for compatibility and historical
analysis. They are not part of the shipped request path.

## Safety contract

pxpipe may replace text with images only when every changed span satisfies all
of these rules:

1. The image stays in the original API role, message, and content container.
2. It occupies the exact source position. Any original prefix and suffix remain
   byte-exact and immediately adjacent to the images.
3. Every other caller-owned value, block, message, and role keeps its original
   value and order. Arbitrary JSON whitespace and escape spelling are not part
   of this admitted-candidate guarantee.
4. pxpipe adds no model-readable text. There are no labels, pointers,
   placeholders, manifests, boundaries, reminders, or authority claims.
5. Rendering preserves every source codepoint in order. It does not reflow,
   trim, normalize, truncate, or omit text.
6. The complete candidate passes the no-hijack comparison, the observed
   Anthropic system-attachment ordering rule, and the request-wide savings gate
   before it is forwarded.

An uncertain source bucket is excluded before candidate construction; another
independent safe bucket may still be considered. Any candidate-wide uncertainty
returns the exact caller-owned request buffer. A candidate containing an unsafe
or partially applied replacement is never sent.

## Anthropic Messages behavior

Only two source shapes are currently eligible.

### Exactly recognized project guidance

The versioned Claude Code opening-context recognizer may identify the project
guidance span inside the first user message. pxpipe can replace only that span,
in that same user text block, with one or more unlabeled images. The exact text
before and after the span remains adjacent around the images.

The surrounding host framing and metadata, including `userEmail` and
`currentDate`, stay exactly where the caller put them. Native `system` blocks,
tool definitions, generic reminders, literal system-role attachments, ordinary
conversation text, and the live request also stay native. History is never
collapsed or moved; an otherwise eligible `tool_result` span may still be
replaced in place inside an older user message.

An unknown or changed opening shape is not guessed, and the project bucket stays
native. `contextMode: safe_native` means no supported opening carrier was found;
when only part of a recognized carrier is unsupported, use `projectDisposition`
and the uncertainty fields to read the outcome.

### Successful tool results containing plain prose

A large successful `tool_result` string, or one exact text part inside a
`tool_result`, may be replaced by images inside that same `tool_result`
container. Other parts keep their exact order and value.

The complete source container stays native when it is an error, has an
unsupported outer shape, contains terminal controls, or exceeds the per-result
image limit. Within a supported multipart result, each text part is considered
separately: a below-threshold or precision-sensitive part stays text while a
safe prose sibling may be imaged in place. Structured data, logs, explicit
identifiers, mixed letter-and-number tokens, long opaque blobs, and unfamiliar
identifier assignments are treated as precision-sensitive.

`keepSharp` can conservatively keep an otherwise eligible tool-result text
block native. `emitRecoverable` is inert on the shipped exact path and never
exposes source through proxy telemetry. The standalone library wrapper remains
native because it has no authenticated measurement transport.

## Exact rendering and terminal controls

The exact renderer segments only at codepoint boundaries and records the exact
source span represented by each page. Accepted pages must join back to the
original text exactly and must report both `droppedChars === 0` and an empty
dropped-codepoint map.

Terminal output is stateful, so a C0 or C1 control character can change nearby
printable text without appearing as an ordinary glyph. Any control other than
line feed makes the complete project span or complete `tool_result` container
native. This includes tab, carriage return, escape-prefixed ANSI sequences,
and the single-byte CSI and OSC forms. pxpipe never images a printable suffix
after silently dropping an escape byte.

The complete request must also remain within Anthropic's 100-image limit. If
all eligible buckets together exceed the remaining capacity, the whole
candidate is discarded; pxpipe does not choose a profitable-looking subset.

## Caller-owned cache markers

pxpipe does not add or remove `cache_control` markers. When one source text
container expands into several parts, its marker remains at the exact logical
end of that container:

- a marker on a user text block moves to the final replacement part;
- a marker on a `tool_result` stays on that outer block;
- a marker on a replaced inner text part moves to that replacement's final
  part.

Earlier images and adjacent native text receive no copied marker. The
no-hijack check rejects marker drift before admission. See
[`CACHING_AND_SAVINGS.md`](./CACHING_AND_SAVINGS.md) for the pricing rule.

## Request-wide admission

The proxy builds one candidate in memory from all eligible Anthropic spans. It
then verifies that the candidate differs only by the declared same-container
image replacements and checks the observed system-attachment ordering rule. An
ordinary mid-conversation `system` message must precede an `assistant` message
or end the array; the directive-only empty-content form with `output_config` is
the documented exception. This is a targeted guard, not a complete Anthropic
schema validator.

The proxy measures four bodies through Anthropic's no-model token-count
endpoint:

1. unchanged full request;
2. unchanged cacheable prefix;
3. candidate full request;
4. candidate cacheable prefix.

The prefix measurements are provider-valid normalized surrogates rather than
raw JSON truncations. They may contain a synthetic user `x` or a synthetic
`tool_result: "ok"` solely to make the no-model counting request structurally
valid; neither string can reach the model-facing request.

It sends the candidate only when all required measurements succeed and the
complete candidate saves at least 256 effective input tokens and at least 10%
after cache pricing. A missing marker position, unknown measurement, failed
system-attachment ordering guard, or failed reserve returns the exact original
request. Render loss excludes the affected source before candidate construction;
if no other safe replacement remains, the request is therefore unchanged. The
four measurements and formulas are detailed in
[`CACHING_AND_SAVINGS.md`](./CACHING_AND_SAVINGS.md).

## OpenAI, Codex/Sol, and Grok

OpenAI Chat Completions and Responses bodies are byte-exact pass-through. The
transform does not parse and reserialize them. It does not replace system or
developer instructions, tool documentation, history, or the live request, and
it does not add synthetic messages, guards, pointers, or authority banners.

This applies to Codex/Sol and Grok because they use the Responses-shaped path.
Compression flags cannot reactivate the old transform. Until a provider shape
can carry an image inside the original role and container, telemetry reports
`compressed: false`, zero transformed characters and images, and
`same_container_image_unsupported` (or `compress=false`). No savings are
credited for these unchanged requests.

Vision-cost and history-planning helpers remain exported so historical event
rows and offline experiments stay readable. Their presence does not mean the
live request path images OpenAI-shaped traffic.

## TransformInfo and persisted telemetry

`TransformInfo` is deliberately backward compatible, so its type still
contains fields emitted by older transform designs. Current behavior is best
read through these groups:

| field group | current meaning |
|---|---|
| `compressed`, `reason` | Whether a changed request was admitted and, when present, a request-level native reason. Bucket-level skips can leave `reason` absent and instead use dispositions or `passthroughReasons`. |
| `origChars`, `compressedChars`, `imageCount`, `imageBytes`, `imagePixels` | Applied image work only. Native fallback resets these to zero. |
| `contextMode`, `projectSourceChars`, `projectSourceSha8`, `projectDisposition`, `projectImageCount` | Exact project recognition and result; no project source text is persisted. |
| `toolMode`, `toolDisposition`, `toolResultImgs` | Tool definitions remain native; the image count covers admitted tool-result images. |
| `passthroughReasons` | Aggregate safe-fallback causes such as `terminal_control`, `exact_identifier`, `unsupported_shape`, or `too_many_images`. |
| `droppedChars`, `droppedCodepointsTop` | Legacy/defense fields. Exact rendering rejects a lossy page before recording it, so current safe-path failures surface through a disposition or `render_error`; an admitted request still has no drops. |
| `baselineTokens`, `baselineCacheableTokens`, `candidateTokens`, `candidateCacheableTokens`, `baselineProbeStatus` | The four admission measurements. A marker-free prefix is recorded as an exact zero. |
| `admissionReason`, `admissionCacheTier`, `admissionOriginalEffectiveTokens`, `admissionCandidateEffectiveTokens`, `admissionSignedSavingsTokens`, `admissionRelativeSavings` | The request-wide verdict and its cache-aware pricing evidence. |
| `admissionFingerprint` | A hash-only Node coordination and breaker identity. It contains no request text or credentials. |
| `cachePrefixSha8`, `cachePrefixBytes`, `firstUserSha8`, `claudeMdSha8`, `req_body_sha8` | Hashes or sizes used for correlation without persisting source text. |

Fields concerning manifests, runtime relocation, generic reminder images,
tool-reference images, or collapsed history are historical compatibility fields
and should not be interpreted as current capabilities. New safe-path rows leave
them absent or at their native defaults.

The persisted event log stores hashes, counts, reasons, provider usage, and its
own event timestamp, not project guidance, tool-result source text, request
bodies, upstream error bodies, caller email values, caller `currentDate` values,
or host/workspace identity. Dashboard-only image and source previews are not
written to JSONL.

## Historical designs that are not shipped

Earlier versions could move project guidance into leading user images, append
native-system manifests, relocate runtime metadata, emit page labels and
boundaries, collapse old history into a synthetic user message, reflow or
truncate tool output, and replace tool documentation with references. Those
paths changed authority, order, or source fidelity and are disabled in the
current orchestration.

Legacy options and helper functions remain source-compatible while callers
migrate. In particular, `compressTools`, `compressReminders`,
`collapseHistory`, `gptHistory`, `reflow`, `multiCol`, `priorWarmTokens`, and
`historyAmortizationHorizon` do not authorize any of those old behaviors on the
shipped safe paths.

## Wiring

`src/core/anthropic-context.ts` recognizes the exact opening project span.
`src/core/transform.ts` builds exact Anthropic candidates and filters unsafe
tool results. `src/core/anthropic-exact.ts` performs atomic same-container
splices. `src/core/no-hijack.ts` proves that no other visible text or structure
changed. `src/core/admission.ts` enforces the observed Anthropic
system-attachment order and prices the four token-count measurements.
`src/core/proxy.ts` supplies the authenticated
measurement transport and forwards only admitted candidates.

`src/core/openai.ts` returns exact OpenAI-shaped bytes. `src/core/tracker.ts`
defines the persisted event fields, while `src/core/baseline.ts` supplies the
single signed accounting function shared by the live dashboard, replay,
session summaries, and statistics.
