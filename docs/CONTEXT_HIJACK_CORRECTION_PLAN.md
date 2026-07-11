# Stop pxpipe from rewriting trust boundaries

Status: **DRAFT 2026-07-10 — owner approved the correction direction; detailed
implementation awaits independent Claude review and owner approval**.

Plan base: `94470f7` on `fix/provenance-safe-compression`. Canonical upstream
`main` was `8d7ba3e` when rechecked. Recheck again before implementation and
prefer any upstream solution that overlaps or conflicts.

This is the canonical correction to the installed provenance-safe design. It
supersedes that design's claim of completion and pauses
`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`. The older plans remain historical
receipts; they are not authority for the corrected default behavior.

## Required outcome

pxpipe must reduce context without impersonating the client, the user, or the
system:

- never move email, date, environment, or other host metadata beside live user
  prose;
- never add model-visible claims about trust, authority, priority, authenticity,
  or what the model must obey;
- never move system, developer, project-guidance, tool-definition, or conversation
  text into a different API role or synthetic message by default;
- add no model-readable proxy prose, including labels, manifests, pointers,
  banners, factsheets, paging notices, or behavioral guards;
- leave a bucket native whenever its images cannot occupy the source span inside
  the original role, message, and relative order;
- never compress unless a request-wide cache-aware comparison proves the complete
  transformed request is cheaper than unchanged text with a safety reserve;
- keep compression off as an exact byte-for-byte pass-through.

Safety wins over savings. A provider path that cannot satisfy these rules remains
native until a safe representation exists.

## Evidence that reopens the prior plan

The owner supplied a Claude model-side incident report from a session ending
2026-07-10 20:36 America/New_York. Machine-local report:
`/Users/michael/Dev/pxpipe-proxy-test-report-2026-07-10.md`, SHA-256
`A7CC5CC6B612B089A9B560478B5CBA0DA174130D3246514DCE1E8CED56B0845C`.
The report itself is not committed.

The session used the currently installed provenance build:

- the installed receipt identifies source `3e07e08`;
- the service log records the report's compressed Sonnet and Fable requests after
  that installation;
- product source and tests are unchanged between `3e07e08` and this plan base;
- event telemetry records `runtime_metadata_disposition=moved` with 103 source
  characters for every compressed request in the reported run.

The model observed the runtime label fused to live text twice:
`compare.PXPIPE RUNTIME CONTEXT` and `it did.PXPIPE RUNTIME CONTEXT`. The
compression-off control contained none of the proxy artifacts.

Current source explains the observations:

- `src/core/transform.ts` removes the captured `userEmail`/`currentDate` suffix
  and appends a new final user text block;
- that block begins directly with `PXPIPE RUNTIME CONTEXT` and has no leading
  textual boundary;
- adjacent API text blocks do not promise a model-visible separator;
- the project and runtime manifests add source, meaning, and priority claims;
- the accepted role-integrity tests explicitly require these behaviors instead
  of rejecting them.

The earlier reviews proved that the implementation matched the earlier plan. They
did not prove that the plan met the owner's actual goal. The installed model-side
test falsified that goal, so the lower-authority plan and tests must change.

The same run also falsified the economic acceptance claim. The dashboard reported
155,000 effective tokens through pxpipe versus 147,000 for the unchanged-text
counterfactual: 6% more after normal cache discounts. Output was unchanged and
counted equally on both sides.

Current Node wiring explains the loss. The installed host deliberately returns an
empty transform-options object, leaving `priorWarmTokens` and
`priorWarmImageTokens` at zero. Project, tool-reference, and tool-result gates then
compare estimated cold image tokens with raw text tokens. They do not price a
would-have-been-warm text prefix at its real cache-read rate or include the complete
request's cache rebuild. The dashboard correctly reports the resulting negative;
the fix must change admission, not hide or clamp the metric.

The owner then supplied a live upstream 400 from the same installed service:
`messages.1: role 'system' must precede an 'assistant' message or end the array`.
The service recorded the same compressed request twice with history collapse
active, ten turns collapsed, and three images. Current history code protects the
literal system attachment at index 1, then replaces the following history with a
synthetic user message. The accepted test explicitly checks that arrangement but
never validates Anthropic's role-order rule. Compression-off subsequently worked.

Therefore every candidate also needs a final provider-structure validation before
forwarding. A transform that makes a previously valid role sequence invalid must
discard the complete candidate and send the original body.

## What the report does not prove

Do not manufacture fixes for unsupported causes:

- The stale Sonnet declaration after switching to Fable is not evidence of a
  pxpipe request cache. pxpipe has no transformed-request cache, and telemetry
  shows different native-system sizes and cache-prefix hashes across the switch.
  Preserve per-request model and system bytes and add a synthetic two-request
  guard; investigate further only from an inbound/outbound capture.
- The SessionStart ordering observation does not establish proxy reordering.
  pxpipe receives one complete JSON request, not reorderable input frames. Add an
  order-preservation guard, but do not change ordering without contradictory wire
  evidence.
- The report's claim of four wire serializations is model-side evidence. The code
  is deterministic, but its adjacent text-block boundary is semantically
  insufficient. Eliminate the unsafe relocation instead of adding a newline.

## Corrected safety rule

Default compression may replace text with images only when all of the following
are true:

1. the image remains inside the original API role and message;
2. the image occupies the exact source span in the original relative order;
3. splitting one source text block is allowed only when the exact prefix and suffix
   remain adjacent around the image, with no placeholder or replacement prose;
4. no caller text, block, message, or role is otherwise changed or reordered;
5. pxpipe adds no model-readable text at all;
6. rendering does not reflow, trim, truncate, normalize, or explain source bytes;
   deterministic segmentation into multiple unlabeled images is allowed only at
   exact codepoint boundaries, and any unrenderable codepoint leaves the bucket
   native;
7. a request-wide cache-aware gate proves a strict effective-token win with the
   required safety reserve;
8. any ambiguity, unsupported provider shape, escape sequence, missing
   measurement, render failure, or failed savings gate leaves the complete source
   bucket native.

An image added to a synthetic user message is not role-preserving even if its
pixels contain role labels. A manifest cannot repair that role change.

## Corrected provider defaults

### Anthropic

Leave these exact and native by default:

- `system` blocks;
- Claude Code's opening host-context framing and metadata, including `userEmail`
  and `currentDate` in their original location;
- literal system-role attachments;
- tool definitions;
- generic reminders;
- prior conversation history.

The exactly recognized project-guidance span may remain eligible only by replacing
that span in place with unlabeled images between its exact original prefix and
suffix. It receives no manifest, runtime tail, placeholder, boundary, page label,
factsheet, or other generated text. If the span cannot be rendered exactly and
profitably, the complete opening carrier remains native.

Large successful `tool_result` text remains eligible because Anthropic permits
images inside the original `tool_result` container. It is rendered exactly in
place without factsheets, paging notices, truncation, reflow, or labels. Exact
identifiers, oversized results, errors, ambiguous shapes, and ANSI/terminal control
sequences stay native.

### OpenAI-compatible Chat and Responses

Leave these exact and native by default:

- system and developer instructions;
- tool definitions and documentation;
- all user/assistant/developer history;
- the live request.

Remove the active banners and pointers that say rendered instructions are
authoritative, have the same priority, or must be followed. Disable synthetic
history-user messages and live-request guards by default. Until a provider shape
can carry an image inside the original role and container, the OpenAI context
transform is pass-through. Routing and telemetry still operate; the product must
not claim token savings for an unchanged request.

This applies equally to Codex/Sol and Grok because both use the OpenAI Responses
transform. The one-port routing work resumes only after this corrected default is
accepted and installed.

## Strict economic admission

Safety-qualified placement is necessary but not sufficient. Admission uses the
complete request, not a bucket-only character estimate:

- build one candidate in memory from every simultaneously safety-qualified bucket
  without forwarding it;
- use the provider's no-model token-count endpoint on the unchanged full request,
  unchanged cacheable prefix, candidate full request, and candidate cacheable
  prefix; run independent probes concurrently where possible;
- include every changed byte and image in those measurements;
- for source inside a cacheable prefix, price unchanged text at the 0.10 cache-read
  rate and a newly changed image prefix at its real cache-create rate: 1.25 for
  five-minute entries and 2.0 for one-hour entries; an absent or unrecognized tier
  uses the conservative 2.0 rate;
- for source after the final cache marker, compare both sides at the ordinary cold
  input rate;
- require the transformed effective input to be at least 10% and 256 effective
  tokens lower than unchanged text;
- if either provider measurement, source/cache position, or image cost is missing
  or uncertain, keep the request byte-identical;
- never use `priorWarm*=0` as a silent substitute for missing cache state.

The four-probe request-wide result is the only runtime profitability verdict.
Retire the existing `isCompressionProfitable`/`priorWarm*` per-bucket gates from
active completion transforms; they are not retained as a pre-filter. If the one
full candidate fails admission, v1 sends the complete original request. It does
not search bucket subsets or re-probe combinations. This deliberately gives up
some possible savings to keep one auditable decision.

Cache tier comes from the caller-owned `cache_control.ttl` on the breakpoint that
unambiguously covers every changed span. An omitted/unknown TTL, no covering
marker, or multiple changed spans covered by different markers uses 2.0 whenever
cache-create pricing applies.

Probe rate limits, errors, or unsupported image counting fail native. They do not
fall back to character ratios. OpenAI remains pass-through, so it does not need
candidate probes until a same-role image representation is separately proven.
The independent probes run concurrently, but admission now waits for them before
forwarding, adding roughly one token-count round trip to a compressed request.
That latency is an explicit cost of the strict no-loss gate.

Use one shared signed accounting function for live dashboard updates, log replay,
session summaries, and statistics. A row contributes a counterfactual only when
compression actually ran and every required full/prefix probe succeeded. The
function prices five-minute creation at 1.25, one-hour creation at 2.0, and reads
at 0.10. Missing tier splits use the documented conservative fallback; no consumer
may silently assume five-minute creation or implement a different formula.

Measured results remain honest, including negative values. The admission math and
provider-structure validation live in the Workers-safe core. For the owner's local
Node service, a process-local fingerprint breaker and one in-flight lock per
fingerprint provide defense in depth: concurrent duplicates wait or go native, and
a measured negative disables later compression in that process. Re-entry requires
a separately proven positive condition; time alone is not one.

No cross-isolate Worker state, KV, or Durable Object is added. A Worker must satisfy
the strict per-request probe gate or stay native; any optional isolate-local breaker
is not a fleet-wide guarantee. The strict per-request gate, not the breaker, is the
safety mechanism shared by Node and Worker.

## Public options and rollback

- `compress` continues to enable only safety-qualified buckets.
- Existing public flags that formerly enabled project guidance, tool-reference,
  or synthetic-history imaging may remain temporarily for source compatibility,
  but they must not re-enable a cross-role transformation on a shipped path.
- Record a clear deprecation before removing a public option.
- `PXPIPE_DISABLE` and per-request compression-off remain byte-exact rollback
  paths.
- Dashboard and event savings remain signed; do not clamp, hide, relabel, or reset a
  negative return.
- Reproduce the old behavior only from the pinned commit in an isolated evaluation
  worktree, never as an installed runtime mode.

## Implementation slices

Each slice is one focused commit. Run focused tests and the full local gate before
committing. Claude independently reviews every slice in a disposable worktree
under `~/Dev`; Codex does not review this work.

### Slice 1 — shared no-hijack contract

- Add provider-neutral helpers/tests that inventory every model-visible block added
  or moved by a transform.
- Add final provider-structure validation that rejects a candidate before
  forwarding and restores the exact original body.
- Treat `rendered.droppedChars > 0` or any non-empty dropped-codepoint map as a
  render failure, not telemetry-only information. Exclude that entire source
  bucket before building the economic candidate.
- Pin the original role, message index, container, text, and ordering for all
  instruction-bearing and host-context regions.
- Add a regression fixture for adjacent text blocks showing that block identity is
  not a valid text delimiter.
- Add a forbidden-generated-prose check covering trust, authority, priority,
  authenticity, source assertions, and obey/follow directives.
- Replace bucket-only cold estimates with one request-wide cache-aware admission
  result and an explicit reason for every native fallback.
- Retire the active per-bucket `isCompressionProfitable`/`priorWarm*` verdicts;
  do not keep a second runtime profitability formula.
- Centralize signed live/replay/session/statistics accounting, including five-minute
  and one-hour cache tiers.
- Put admission math and structure validation in the Workers-safe core; add the
  process-local breaker and per-fingerprint in-flight lock only to Node.
- Add cold, warm, growing-prefix, restart, overlap, model/source switch,
  missing-measurement, cache-tier, and negative-feedback fixtures.
- Prove the current implementation fails these guards.

### Slice 2 — Anthropic safe default

- Delete runtime metadata relocation from the active path.
- Preserve the opening host carrier byte-for-byte, including metadata and marker
  ownership.
- Replace only an exact, accepted project-guidance span with unlabeled images at
  that span's original position; preserve its exact prefix/suffix and add no text.
- Stop tool-reference, reminder, and history imaging on the default path.
- Remove all manifests, labels, placeholders, boundaries, factsheets, paging
  notices, synthetic messages, and semantic telemetry claims from emitted
  requests.
- Retain exact in-place `tool_result` compression and prove every unsupported
  bucket—including any render with one or more dropped codepoints—fails native.
- Build one all-eligible candidate; if its authoritative request-wide probes fail,
  forward the complete original request without subset search.

### Slice 3 — OpenAI safe default

- Stop Chat and Responses transforms from replacing system/developer instructions
  or tool documentation.
- Stop synthetic history messages and live-request guards.
- Remove authoritative/same-priority banners and pointers.
- Make the unchanged-request path report no compression and no savings.
- Apply the same request-wide economic admission before any future supported
  same-role image path.
- Prove Chat, Responses, Codex/Sol, and Grok model identifiers and request bodies
  remain per-request and exact.

### Slice 4 — report follow-ons without speculative fixes

- Detect complete ANSI/CSI terminal sequences in a render candidate and leave that
  container native; never drop only the escape byte while imaging the suffix.
- Add two sequential synthetic requests with different models and system text;
  prove no bytes or hashes from the first appear in the second.
- Add mixed user/system/hook attachment fixtures and prove exact input order.
- Reproduce the reported literal-system sequence and prove history cannot leave a
  non-directive system message before a synthetic user message. Final validation
  must fail the whole candidate native if any future transform breaks this rule.
- Do not add a request cache or an ordering rewrite.

### Slice 5 — documentation, package, and local installation

- Rewrite README behavior and limitations around the same-container rule.
- Remove token-saving claims for newly native provider paths.
- Update telemetry documentation and migration notes.
- Build the reviewed package directly into
  `/Users/michael/Dev/pxpipe-deploy`, verify its recorded digest, reinstall, and
  confirm the running source commit.
- Keep the one-port routing plan paused until the installed correction passes its
  local no-network checks.

## Automated acceptance checks

1. `userEmail`, `currentDate`, and every other host-context byte remain at their
   original message/block offsets; no runtime label or manifest exists.
2. No transformed request adds any model-readable text.
3. No system, developer, project, tool-definition, user, or assistant content moves
   to another role, message, or synthetic message.
4. Accepted Anthropic project images occupy the exact original guidance span
   between byte-exact prefix/suffix blocks, with no label, placeholder, boundary,
   factsheet, or reflow.
5. Accepted Anthropic tool-result images stay inside their original `tool_result`
   container and render the exact source codepoints without reflow, labels,
   truncation, or omitted glyphs.
6. Default OpenAI Chat and Responses context bodies are byte-exact pass-through
   until a same-container image shape is proven.
7. Joining adjacent text parts with no implicit delimiter cannot reproduce
   `user textPXPIPE...` because no runtime tail is emitted.
8. ANSI/CSI-bearing candidates remain completely native; plain printable suffixes
   are not imaged after a dropped escape byte.
   Every accepted image reports `droppedChars === 0` and an empty
   dropped-codepoint map.
9. Sequential Sonnet/Fable and Sol/Grok fixtures use only their own model, system,
   and request bytes.
10. A non-directive Anthropic `system` message still precedes an `assistant`
    message or ends the array after every accepted transform; the exact reported
    system-before-synthetic-user candidate fails wholly native.
11. Message and block order is identical before and after every native fallback.
12. Compression-off is byte-for-byte identical.
13. Routing, authentication forwarding, dashboard selection, and existing
    non-transform proxy behavior remain green.
14. Telemetry contains no source text or personal data and never reports savings
    for a byte-identical request.
15. Live, replay, session, and statistics consumers return identical signed
    accounting for the same fixture stream, including 1.25 five-minute creation,
    2.0 one-hour creation, 0.10 reads, and failed-probe exclusion.
16. Every admitted compressed request beats its complete unchanged counterfactual
    by at least 10% and 256 effective tokens under cold, warm, growth, and restart
    fixtures.
17. Excluding a deliberate fault-injection fixture, cold-to-warm, growth, restart,
    overlap, cache-tier, and model/source-switch sequences contain no negative
    admitted row or cumulative session. In Node, a deliberately injected live
    negative immediately reopens the correction, disables that exact process-local
    mode before another same-fingerprint request forwards, and remains visible on
    the dashboard. Worker tests prove the per-request gate without claiming
    cross-isolate breaker state.

Every new behavior test receives a guard proof: revert the matching correction,
observe the focused test fail, restore it, and observe it pass. Then run:

```text
pnpm run typecheck && pnpm test && pnpm run build
```

## Local validation and live boundary

Before installation, run a no-network capture that compares sanitized inbound and
outbound JSON for Anthropic Chat, OpenAI Chat, and OpenAI Responses. Store only
synthetic fixtures and hashes; never store subscription tokens, private prompts,
email addresses, or raw owner sessions.

Installation and parser-only client checks do not authorize a model call. A short
post-install Claude/Sonnet/Fable confirmation and any Codex/Grok smoke remain
separate owner gates.

## Boundaries

This plan does not authorize:

- a code change before plan approval;
- a live model call;
- a raw owner-request capture or credential log;
- the separately gated provenance A/B matrix;
- implementation of the paused one-port routing plan;
- a push, merge, pull request, release, or upstream contribution.

## Acceptance

The correction is complete only when the installed default cannot plant metadata
beside live user prose, cannot self-assert trust or priority, and cannot relocate
instruction-bearing content into a synthetic role. Every admitted transform must
also produce a conservative, cache-aware token win. Reduced compression frequency
is acceptable; negative compression is not. Any design that relies on better
wording, another manifest, a stronger delimiter, or a cold-only estimate is a
failure.
