# How imaged history stays cache-safe as a conversation grows

This doc captures the **mental model** behind pxpipe's history-image compression:
why turning past conversation turns into images doesn't break Anthropic's prompt
cache, even though the conversation keeps growing and "new" content is constantly
becoming "old."

It's the conceptual companion to [`CACHING_AND_SAVINGS.md`](./CACHING_AND_SAVINGS.md),
which carries the pricing math. Where the two disagree, the **code wins**:

- `src/core/history.ts` — `collapseHistory`, the quantized boundary, `blocksToText`
- `src/core/transform.ts` — the splice, caller-marker preservation, the gates
- `src/core/baseline.ts` — `CACHE_CREATE_RATE = 1.25`, `CACHE_READ_RATE = 0.1`

---

## 0. The question this answers

> If we convert old turns to images, doesn't the prefix change — and break the
> cache? And since *new* content always eventually becomes *old*, doesn't the
> boundary move every turn, re-imaging and re-keying the cache continuously?

Short version: **we do image history, it is cache-safe, and "old" is defined by a
*quantized* boundary so the re-key is a rare one-time event, not a per-turn churn.**
The cache breakpoint ("mark") is the seam that makes the cost one-time.

---

## 1. Yes — we image history, always-on

`collapseHistory` (history.ts) is **always-on, unconditional** (transform.ts:
"Variant C history-image compression. ALWAYS-ON, unconditional"). It walks
`messages[]`, finds the largest **tool-closed prefix run** of past turns,
serializes them to text with `blocksToText` — which includes assistant
responses, `tool_use` args, and `tool_result` content — and renders that text
into PNG blocks inside **one prepended synthetic user message**.

What stays as **text** is the live tail: the last `keepTail` turns plus anything
inside an open tool sequence (and the most-recent assistant thinking signature,
which must round-trip bit-perfect).

So past assistant responses absolutely become images. The rest of this doc is
about why that's safe.

---

## 2. The aging problem is real

Every turn, the live tail grows and the oldest tail turn becomes eligible to be
"old." So the text↔image boundary *wants* to move forward over time. The danger:

> If "old" meant *"everything except the last `keepTail` turns"* — a per-turn
> moving window — the boundary would advance by one message every turn. The
> collapsed set would change every turn → the rendered PNG bytes would change
> every turn → **new cache key every turn → `cache_create` (1.25×) on the whole
> history every single turn.**

That is not hypothetical. It's the **2026-05-19 regression (bug #28)**, which the
pricing doc cites as going to **−250% "savings."** A moving boundary is a cache
shredder.

---

## 3. The fix: "old" is *quantized*, not a moving window

The boundary is snapped onto a fixed grid of `collapseChunk` messages
(default **50**). From `history.ts`:

```ts
const rawCutoff = messages.length - o.keepTail;
const cutoff = o.collapseChunk > 0
  ? Math.min(rawCutoff,
      Math.max(minCollapsePrefix + protectedPrefix,
               Math.floor(rawCutoff / o.collapseChunk) * o.collapseChunk))
  : rawCutoff;
const boundary = findClosedPrefixBoundary(messages, cutoff);
```

`Math.floor(rawCutoff / collapseChunk) * collapseChunk` is the whole trick:
eligibility for imaging advances in **discrete jumps**, not continuously. Then
`findClosedPrefixBoundary` snaps it back to the nearest tool-closed point so the
image never splits an open `tool_use`/`tool_result` pair.

It's a **staircase, not a ramp.** With `keepTail = 4`, `collapseChunk = 50`:

| `messages.length` | `rawCutoff` | quantized `cutoff` | what's imaged          |
| ----------------: | ----------: | -----------------: | ---------------------- |
|                54 |          50 |             **50** | msgs[0..50)            |
|                80 |          76 |             **50** | msgs[0..50) ← *same*   |
|               103 |          99 |             **50** | msgs[0..50) ← *same*   |
|               104 |         100 |            **100** | msgs[0..100) ← *jumps* |

For ~50 turns the collapsed set is a **fixed set of messages** → byte-identical
PNG → the prefix reads warm (`cache_read`, 0.1×) the whole time. New content
piles up in the *text* tail; it only crosses into "imaged" when the conversation
passes the next multiple of 50.

`historyImageSha8` (transform.ts) logs the image hash per request precisely so
this is verifiable from `events.jsonl`: **while the boundary holds, consecutive
collapsed turns MUST report an identical `history_image_sha8`.** A hash that
moves turn-over-turn is the signature of the bug returning.

---

## 4. The one-time burn, and the gates that control it

A chunk crossing changes the imaged region's bytes once → that turn pays a fresh
`cache_create`. This is the **one-time burn**. It is:

- **One-time per stable window**, not per turn — ~one create per `collapseChunk`
  turns, amortized over the warm reads in between.
- **Gated both ways** so it only happens when it pays back:

  **Symmetric burn term** (`isCompressionProfitable`):
  ```
  burnImageSide = priorWarmTokens × (CACHE_CREATE_RATE − CACHE_READ_RATE)   // ≈ 1.15× the warm prefix given up
  compress iff  imageTokens + burnImageSide  <  textTokens + burnTextSide
  ```

  **History amortization gate** (`isCompressionProfitableAmortized`):
  ```
  accept iff  I × (CC + CR×(N−1))  <  T × CR × N        CC = 1.25, CR = 0.10
  ```
  where `N = historyAmortizationHorizon` ("assume this prefix gets reused `N`
  more times"). **Default `N = 1`**, which is deliberately conservative — at
  `N = 1` collapse almost never wins, so a host raises `N` once it has observed
  that its cache lives long enough to amortize the create. At `N ≈ 10` collapse
  wins once the image is below ~0.7× the text.

- **Cold-start free.** On turn 1 / a fresh conversation, `priorWarmTokens` and
  `priorWarmImageTokens` default to `0`, zeroing the burn term entirely — there's
  no warm cache to lose, so imaging from the start breaks nothing.

---

## 5. The unifying principle: the cache mark is the seam

Everything above collapses into one rule:

> **Byte-stable content goes *before* the cache mark; per-turn-volatile content
> goes *after* it. "One-time" is defined relative to that mark.**

pxpipe never *adds* a breakpoint. Caller markers are **preserved in place or
re-planted onto the same logical content**: the project pages ride *before*
the caller's own live-prompt marker in the opening message, and history
collapse re-plants the one unambiguous marker a collapsed message carried onto
that chunk's last image (`messageCacheControls`; two markers in one message
fail the bucket closed). So the breakpoint still lands exactly at the
stable↔volatile seam:

```
[ PROJECT GUIDANCE image(s) + boundary ]     ← stable, no markers of their own
[ opening reminder + live prompt ] ← caller's cache_control, unmoved
─────────────── cache breakpoint ───────────────
[ synthetic history message ]                ← re-planted caller marker, if the
[ live tail, runtime-context tail ]            collapsed range carried one
```

Two conditions make the burn one-time, and the layout arranges both:

1. **Everything up to the mark is byte-identical across turns** — guaranteed by
   the quantized boundary (§3).
2. **Everything volatile sits after the mark** — the billing line, dynamic
   `<env>`, and current user message are spliced *after* the breakpoint, so they
   never pollute the prefix cache key.

When both hold, the prefix up to the mark reads warm every turn, and the prefix
re-keys **only** when the bytes at/before the mark genuinely change — i.e. the
initial text→image flip and each chunk crossing. That's the one-time create;
everything in between is a warm read.

### Why the leading project carrier is protected

The opening user message that carries the project pages, their shared
boundary, and the reconstructed host reminder is shielded from collapse by
`roleBoundProtectedPrefix` (history.ts): when the shared project-guidance
boundary ref and the exact opening-carrier text are present, that message —
plus any literal `role: "system"` attachments contiguously following it —
never enters the collapse range. If collapse swept it in, `blocksToText`
would reduce the project pages to `[image]` placeholders and detach the
vouched-for leading range from its native manifest. A boundary-shaped marker
with a different ref (or one copied into a later message) cannot expand the
head; system-role messages inside a *later* collapse candidate fail that
collapse closed rather than being serialized as `<user>` history.

---

## 6. This is just Claude Code's own model

Claude Code natively ships a big **stable prefix** (system prompt, tool docs,
`<system-reminder>`s, older history) terminated by a `cache_control` breakpoint,
followed by a thin per-turn tail. pxpipe preserves that exact shape. It only:

1. Swaps the stable prefix's **representation** — verbose text → byte-stable image.
2. **Keeps every caller mark on its own logical content** (preserve or
   re-plant, never add) so the seam stays in the same logical place and
   pxpipe spends none of the 4-breakpoint budget.
3. Quantizes the history boundary so the imaged region's bytes change only at
   chunk crossings, keeping the native byte-stability Claude Code relied on.

The one-time-ness isn't luck — it's enforced by keeping the marks pinned to
their content and pushing all per-turn churn (including the relocated
runtime-context tail) past them.

---

## 7. Defaults (source of truth: `HISTORY_DEFAULTS` in history.ts)

| Option              | Default | Meaning                                                       |
| ------------------- | ------: | ------------------------------------------------------------- |
| `keepTail`          |       4 | Most-recent turns always kept as text (live tail).            |
| `minCollapsePrefix` |      10 | Don't bother collapsing fewer than this many turns.           |
| `collapseChunk`     |      50 | Grid the boundary snaps to → byte-stable image between steps. |
| `protectedPrefix`   |       0 | Leading messages never collapsed (the transform passes 0; the role-bound project carrier + contiguous system attachments extend it automatically). |
| `cols`              |     100 | Soft-wrap column hint (history renders dense single-col).     |

Related (in `TransformOptions`):

| Option                       |  Default | Meaning                                                  |
| ---------------------------- | -------: | -------------------------------------------------------- |
| `HISTORY_CHARS_PER_TOKEN`    |      2.0 | History cpt fit (Opus 4.7 / Fable 5 tokenizer).          |
| `historyAmortizationHorizon` |        1 | `N` in the amortization gate; raise once cache is proven long-lived. |

### Knob intuition

- **Larger `collapseChunk`** → fewer flips/burns (cheaper caching), but more
  un-imaged text sitting in the tail (less compression).
- **Smaller `collapseChunk`** → more aggressive compression, but more frequent
  burns.
- **Larger `historyAmortizationHorizon`** → more willing to eat a create now for
  warm reads later; only safe when the cache actually lives that long.

---

## 8. One-paragraph summary

We image historical turns always-on, but "old" is a **quantized** boundary
(`floor((len − keepTail) / collapseChunk) × collapseChunk`, snapped to a
tool-closed point), so the imaged region's bytes stay identical for a whole
`collapseChunk` window and the prefix reads warm every turn. New content ages
into the image only at chunk crossings; each crossing costs a single one-time
`cache_create`, gated by a symmetric burn term and an amortization horizon so it
only fires when the warm reads pay it back. The whole thing works because every
caller `cache_control` mark stays pinned to its own logical content (preserved
in place, or re-planted onto the image rendered from it — never added), putting
every byte-stable thing before the seam and every per-turn-volatile thing after
it — which is exactly the prefix-cache shape Claude Code already relies on.
