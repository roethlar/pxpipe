# History compression: current status and historical cache model

Cross-message history collapse is not shipped in the current safe request path.
This document states that boundary first, then records the old cache model so
historical code, tests, options, and telemetry are not mistaken for active
behavior. Same-container tool-result compression is a separate bucket and may
apply inside an older user message.

## Current behavior

Every prior conversation message remains in its original role, message, content
container, and order. Ordinary conversation text remains unchanged. An eligible
`tool_result` text span is the sole history-adjacent exception: it may become
unlabeled images at that exact position inside the same result container.

- Anthropic history is never collapsed, combined, or moved to another message.
- OpenAI Chat history remains byte-exact native.
- OpenAI Responses history remains byte-exact native, including Codex/Sol and
  Grok traffic.
- pxpipe does not prepend a synthetic history user message.
- pxpipe does not serialize whole assistant, user, tool-use, or tool-result
  turns into cross-message history pages.
- pxpipe does not add a history introduction, guard, factsheet, page label,
  manifest, pointer, or boundary.
- pxpipe does not move a marker as part of history collapse. When an eligible
  inner `tool_result` text part is replaced in place, its marker transfers only
  to that part's final replacement image.

This avoids changing a message's authority or producing invalid role ordering.
Ordinary conversation text is not silently reflowed, truncated, or exposed to
optical misreading. The separately eligible tool-result exception retains the
normal image-reading risk documented in the README.

## Active code versus dormant helpers

The active Anthropic orchestration in `src/core/transform.ts` considers only an
exactly recognized project-guidance span and exact successful tool-result prose.
It does not call `collapseHistory`.

`src/core/history.ts`, `src/core/openai-history.ts`, history render helpers, and
their focused tests remain in the repository for compatibility and historical
analysis. Public options such as `collapseHistory`, `gptHistory`,
`historyAmortizationHorizon`, and related warm-token inputs cannot reactivate
history imaging on the shipped transforms.

`TransformInfo` and persisted event types also retain fields such as
`collapsedTurns`, `collapsedChars`, `collapsedImages`, `historyReason`,
`historyTextChars`, `historyImageSha`, and `cacheBoundaryKind: history` so old
event logs remain readable. New safe-path requests do not use those fields as a
claim that history was compressed.

## Why the old design was retired

The old implementation rendered a closed prefix of prior turns, then placed the
images inside a newly created user message. That changed the role and container
of assistant text, tool traffic, and other history. Text inside the image could
describe its old provenance, but that description could not restore the API
authority that had been removed.

The same design could interact badly with literal mid-conversation `system`
messages. Anthropic requires an ordinary system-role message to precede an
`assistant` message or end the array; only the directive-only form with empty
content and `output_config` may occur elsewhere. Rewriting nearby messages must
not create an invalid sequence.

Cache profitability did not cure either structural problem. The current rule is
fail-native unless an image can replace an exact span inside the original role,
message, and content container.

## Historical quantized-boundary model

The following describes the retired design, not current runtime behavior.

The old planner kept a live text tail and selected a tool-closed prefix for
history imaging. To avoid changing the rendered prefix every turn, it snapped
the cutoff to a fixed `collapseChunk` grid:

```text
raw cutoff = message count - keepTail
grid cutoff = floor(raw cutoff / collapseChunk) * collapseChunk
boundary = nearest tool-closed point at or before the grid cutoff
```

With `keepTail = 4` and `collapseChunk = 50`, the selected prefix could remain
fixed while the conversation grew from 54 to 103 messages, then jump at 104.
The intention was a staircase: stable image bytes between chunk crossings and
one cache creation at a crossing, instead of a moving window that changed the
prefix on every turn.

The old implementation also attempted to preserve one unambiguous caller marker
by replanting it on a replacement image. Multiple or mid-message markers failed
that history bucket. These rules explain historical tests and event fields; the
current transform is simpler because it does not collapse ordinary history or
move markers across messages. The separate same-container tool-result rule is
not part of that retired history planner.

## Historical amortization gates

The retired history path used image-token estimates, text-token estimates,
warm-cache burn terms, and an assumed reuse horizon. Its rough lifetime check
was:

```text
image lifetime = image tokens * (create rate + read rate * (N - 1))
text lifetime  = text tokens  * read rate * N
```

It could also apply symmetric penalties when switching away from a previously
warm text or image prefix. These were per-bucket estimates, not measurements of
the complete candidate request. They are therefore not an active safety or
savings verdict.

Current Anthropic candidates instead require the four full/prefix token-count
measurements and the request-wide 10% plus 256-token reserve described in
[`CACHING_AND_SAVINGS.md`](./CACHING_AND_SAVINGS.md).

## Reading current cache telemetry

Because conversation messages stay in place, normal growth can legitimately
grow or invalidate a provider cache prefix. Do not attribute that change to the
retired history-collapse path merely because a historical field exists in the
event schema. A current tool-result image count still describes a real
same-container replacement, even when its result is in an older message.

For a current admitted Anthropic request, use the four probe fields,
`admission_reason`, `admission_cache_tier`, and the admission effective-token
values. Project or tool-result image counts describe only their exact source
containers. For OpenAI, Codex/Sol, and Grok, a new request is pass-through and
receives no compression savings.

Historical rows with `collapsed_images`, `history_image_sha8`, or
`history_reason: collapsed` still describe the old implementation and remain
available for audit. They should be segmented from current safe-path data.

## Requirements before any future history imaging

Cross-message history imaging must remain off unless a separately approved design can prove
all of the following:

1. Each image replaces an exact source span inside the original role, message,
   and content container.
2. Every other caller-owned value, container, and message ordering remains
   exact.
3. No model-readable labels, guards, manifests, pointers, or synthetic messages
   are added.
4. Rendering preserves every source codepoint without reflow, truncation, or
   dropped glyphs; terminal-control-bearing containers stay native.
5. Caller cache-marker ownership remains exact.
6. The complete candidate passes the targeted Anthropic system-attachment
   ordering guard and the shared no-hijack comparison.
7. Four full/prefix measurements prove at least 10% and 256 effective input
   tokens of savings for the complete request.

Until all seven conditions are implemented and reviewed, cross-message history
collapse remains retired. Ordinary history is native provider input; only the
separate exact same-container tool-result bucket can affect an older message.
