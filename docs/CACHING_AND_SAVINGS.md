# Prompt caching and honest savings

This document explains the cache-aware gate that decides whether an Anthropic
candidate may be forwarded and the shared accounting used after the response.
The code sources are `src/core/admission.ts`, `src/core/measurement.ts`,
`src/core/baseline.ts`, and `src/core/proxy.ts`.

## Current scope

Only exact same-container Anthropic project-guidance and successful
tool-result replacements can reach admission. System content, tools, metadata,
ordinary conversation text, reminders, and live user text remain native.
History is never collapsed or moved, although an eligible `tool_result` span in
an older user message may still be replaced in place. OpenAI Chat and Responses,
including Codex/Sol and Grok, are byte-exact pass-through and receive no new
compression savings.

Older per-bucket estimates, warm-cache burn inputs, history amortization, and
OpenAI image formulas remain for source compatibility or historical rows. They
do not decide a current request.

## Anthropic cache rates

Anthropic prompt caching is prefix-based. Caller-owned `cache_control` markers
define cacheable prefixes in provider order: tools, then system, then messages.
pxpipe uses these relative input rates:

| input bucket | rate |
|---|---:|
| ordinary uncached input | `1.0` |
| five-minute cache creation | `1.25` |
| one-hour cache creation | `2.0` |
| cache read | `0.10` |

An omitted or unrecognized creation tier is priced conservatively at `2.0`.
pxpipe never silently substitutes the five-minute rate.

## Cache-marker ownership

pxpipe neither creates nor removes a cache marker. If exact image replacement
splits a marked text container into several parts, the original marker moves
only to the final replacement part. A marker on an outer `tool_result` remains
on that outer block. The normalized marker count must remain identical.

The changed-span scanner determines which caller marker covers every changed
span. A span after the final marker is cold. An unknown source position fails
native. If changed spans have different markers or tiers, cache creation uses
the conservative one-hour rate rather than inventing a cheaper split.

## The four measurements

The proxy builds the complete candidate without forwarding it, then asks
Anthropic's no-model token-count endpoint for four independent values:

- `O`: unchanged full-request tokens;
- `Op`: unchanged cacheable-prefix tokens;
- `C`: candidate full-request tokens;
- `Cp`: candidate cacheable-prefix tokens.

`Op` and `Cp` use provider-countable normalized prefix bodies, not arbitrary raw
JSON truncation. When a tools or system breakpoint would otherwise leave no
message, the measurement body adds a synthetic user `x`; an orphan tool call is
closed with a synthetic `tool_result: "ok"`. These strings go only to the
no-model counting endpoint and never enter the forwarded model request.

A request with no cache marker has an exact prefix value of zero and does not
need a prefix network call. Every other logical slot is measured independently,
even when two normalized bodies happen to be byte-equal. Independent calls run
concurrently, and admission waits for all of them.

Parse failure, malformed measurement, rate limit, unsupported image counting,
or any missing value returns the exact original request. There is no character
ratio fallback.

## Admission pricing and reserve

The unchanged request receives the cheapest defensible treatment for content
already inside its cacheable prefix:

```text
original_effective = Op * 0.10 + (O - Op)
```

If the normalized prefix is unchanged, the candidate prefix is also priced as a
read. If the candidate changed it, the covering caller marker selects the
five-minute or one-hour creation rate:

```text
candidate_effective = Cp * candidate_prefix_rate + (C - Cp)
signed_savings      = original_effective - candidate_effective
relative_savings    = signed_savings / original_effective
```

The complete candidate is admitted only when:

```text
signed_savings >= 256
relative_savings >= 0.10
```

Both reserves are required. This is deliberately stricter than comparing only
the text and images in one bucket: it includes every changed byte, every image,
the cold tail, and the cost of replacing a warm text prefix with a newly created
image prefix.

One candidate contains all simultaneously eligible buckets. If it fails, the
complete original request is sent. The proxy does not search subsets or re-probe
combinations.

## Admission telemetry

The JSONL event maps the four measurements and verdict to these fields:

| field | meaning |
|---|---|
| `baseline_tokens` | `O`, unchanged full request |
| `baseline_cacheable_tokens` | `Op`, including an explicit zero for a marker-free request |
| `candidate_tokens` | `C`, candidate full request |
| `candidate_cacheable_tokens` | `Cp`, including an explicit zero for a marker-free request |
| `baseline_probe_status` | `ok`, `partial`, or `failed` |
| `admission_reason` | admitted or the fail-native reason; contains no caller text |
| `admission_cache_tier` | `none`, `5m`, `1h`, or `conservative_1h` |
| `admission_original_effective_tokens` | admission-priced unchanged request |
| `admission_candidate_effective_tokens` | admission-priced candidate request |
| `admission_signed_savings_tokens` | signed admission delta |
| `admission_relative_savings` | admission delta divided by unchanged effective input |
| `baseline_cache_create_rate` | `1.25` or `2`, used by later counterfactual accounting |
| `admission_fingerprint` | hash-only Node coordination identity |

Only `baseline_probe_status: ok` represents complete four-measurement evidence.
A native row may retain rejection evidence, but its transform counts are zero
and it receives no savings credit.

## Actual response accounting

Admission predicts whether the candidate is safe to send. The dashboard and
reports separately account for what the provider actually billed. Actual
Anthropic effective input is:

```text
actual_effective = uncached_input
                 + cache_create_5m * 1.25
                 + cache_create_1h * 2.0
                 + unknown_cache_create * 2.0
                 + cache_read * 0.10
```

For the unchanged-text counterfactual, actual `cache_read_tokens > 0` is the
only proof that this turn was warm. A completed prior row with the same exact
prefix identity may refine how much of the text prefix was reused and how much
grew. Without such a prior, a proven-warm turn assumes full reuse, which makes
the text counterfactual cheaper and therefore keeps the claimed saving
conservative. A cold turn prices the complete cacheable text prefix at its
creation rate.

The shared `accountAnthropicInput` function is used by live updates, replay,
session summaries, and statistics. It credits a counterfactual only when all of
these are true:

- the request was actually compressed;
- provider usage is present;
- the full and prefix measurements are valid;
- `baseline_probe_status` is `ok`.

Otherwise baseline cost equals actual cost and saved input is zero. Valid
negative results are preserved rather than floored.

## Node coordination and negative results

The local Node service adds one in-flight lease per hash-only compression
fingerprint. An overlapping duplicate waits or goes native instead of racing an
unmeasured candidate. If later observed accounting is negative, the process-local
breaker prevents another matching candidate from being forwarded. Time alone
does not reset that result.

This coordination is defense in depth. The four-measurement admission gate is
the portable safety rule and is also the rule used by the Worker-safe core.

## OpenAI / Responses Path (Codex And Friends)

OpenAI Chat Completions and Responses requests are currently byte-exact native.
This includes Codex/Sol and Grok traffic. The proxy still routes the request,
forwards authentication, records status and usage, and can read historical
OpenAI event rows, but a new unchanged row has:

- `compressed: false`;
- zero transformed characters and images;
- no candidate probes;
- no compression counterfactual or token-saving credit.

The old `openai-savings` and vision-cost helpers exist for compatibility with
historical compressed rows and offline evaluation. They do not make the current
OpenAI request path eligible for imaging. A low or zero OpenAI saving is not a
gate-tuning problem: pass-through is the required behavior until a same-role,
same-container image shape is proven.

## Historical behavior

Previous releases used per-bucket character estimates, `priorWarmTokens`,
`priorWarmImageTokens`, and a quantized history amortization model to decide
whether to image selected content. They also reported savings for OpenAI-shaped
image requests. Those mechanisms did not prove the cost of the complete changed
request and are no longer active admission rules.

Historical JSONL rows remain readable. Their fields must not be treated as
evidence that current OpenAI traffic or collapsed history is being compressed. See
[`HISTORY_CACHE_MODEL.md`](./HISTORY_CACHE_MODEL.md) for the retired history
design and [`TRANSFORM_INFO.md`](./TRANSFORM_INFO.md) for the current wire
contract.
