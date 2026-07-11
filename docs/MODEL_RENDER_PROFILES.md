# Model render profiles

## Current proxy boundary

The installed proxy currently renders only exact in-place Anthropic spans.
OpenAI Chat and Responses requests — including Codex/Sol and Grok — pass through
byte-for-byte unchanged, regardless of `PXPIPE_MODELS` or
`PXPIPE_GPT_PROFILES`. The OpenAI profiles below remain for standalone export,
offline tests, and historical receipts. They cannot enable proxy compression.

An endpoint is only a wire protocol, not a rendering profile. Where rendering is
actually allowed, pxpipe selects geometry, glyph atlas, style, and vision billing
from the exact `model` id.

## Built-in profiles

| model rule | current proxy status | font / cell | columns | max height | style | evidence |
|---|:---:|---|---:|---:|---|---|
| `claude-*` / `*anthropic*` | Fable only | Spleen + Unifont, 5×8 | 312 | 728 px | grayscale AA | Anthropic 1568-edge / ~1.15 MP no-resize measurements |
| `gpt-5.6-sol` | inactive; pass-through | JetBrains Mono 10 + Unifont fallback, 6×11 | 126 | 1932 px | grayscale AA | historical/offline geometry; raw recall pilot failed 0/4 exact |
| `grok-*` | inactive; pass-through | Spleen + Unifont, effective 9×12 | 84 | 1932 px | grayscale AA + legacy factsheet experiment | historical `grok-4.5` density fixture |
| other GPT/o-series | inactive; pass-through | Spleen + Unifont, 5×8 | 152 | 1932 px | grayscale AA | offline fallback geometry |

`gpt-5.6-sol` retains an exact-model offline profile. The historical events log
also contains `gpt-5.6-terra`; Terra does not inherit Sol's profile.

The GPT 5.6 Sol font choice is a separate local raster profile. It preserves
the provider-safe strip width and has a larger cell than the shared 5×8
fallback, but the first paid raw-image pilot did **not** validate it.

## Sol evidence boundary (2026-07-09)

Before the no-hijack correction, two production rows for the exact
`gpt-5.6-sol` id reported 39,985 effective
input/cache-read tokens, 14,152 image tokens, a 52,072-token baseline, 18
images, and approximately 73% estimated savings. A comparison run with the old
shared profile reported 8,568 image tokens against the same baseline. These
numbers establish that real Sol traffic reaches the Responses path and that the
new geometry costs more while retaining positive estimated savings. They do
**not** establish recall, task quality, or causality.

The separate paid raw-image pilot supplies the model-reading evidence:

| profile | exact | confabulations | gist | guard | result |
|---|---:|---:|:---:|:---:|---|
| JetBrains 6×11 / 126 cols | 0/4 | 4 | pass | pass | fail |
| Spleen 5×8 / 152 cols | 0/4 | 4 | fail | pass | fail |

The test is one scored synthetic fixture per profile. It proves that both calls
failed the stated acceptance bar, not a broad Sol-vs-Fable ranking. That retired
proxy path also sent a verbatim fact-sheet beside images, so covered exact
identifiers had a text fallback even though raw image recall failed. A locally
rendered 9×12 / 84-column Sol-only retune remains untested.

Receipt: [`eval/sol-profile/RESULTS.md`](../eval/sol-profile/RESULTS.md).

### Historical Sol scope decision

Sol was **off by default** under the earlier safety rule used for GPT 5.5 and Grok:
a model that silently invents exact values from imaged context is not a safe
transparent default. The profile code remains for offline work, but no model
selection or environment variable can enable Sol compression in the current
proxy. Any future reintroduction requires a new approved same-container design
and independent safety and savings evidence.

## Historical Grok evidence

Grok 4.5 at shared 5×8 density returned 0/4 exact identifiers and silently
invented all four answers. Effective 9×12 returned 4/4 with zero confabulation,
and a separate 5×8 + factsheet arm also returned 4/4 for the extractor shapes in
that fixture. Both are n=1 synthetic results. They were not enough to justify
rewriting Grok requests. The current proxy does not invoke either profile or
emit a factsheet for Grok.

Receipts:

- [`eval/grok-density/RESULTS.md`](../eval/grok-density/RESULTS.md)
- [`eval/grok-density/CLIMB_RESULTS.md`](../eval/grok-density/CLIMB_RESULTS.md)
- [`eval/grok-density/FACTSHEET_RESULTS.md`](../eval/grok-density/FACTSHEET_RESULTS.md)

## Offline and export overrides

`PXPIPE_GPT_PROFILES` is a JSON map from model-id prefix to a partial profile.
The longest prefix wins. Supported render fields are `font`, `cellWBonus`,
`cellHBonus`, `aa`, `grid`, `gridCols`, `colorCycle`, `markerScale`, and
`markerRed`; geometry fields are `stripCols` and `maxHeightPx`.

This override affects standalone export and offline helpers only. It does not
enable OpenAI proxy compression.

```bash
PXPIPE_GPT_PROFILES='{
  "gpt-5.6-sol": {
    "stripCols": 120,
    "style": { "grid": true, "gridCols": 4 }
  }
}'
```

Offline profitability helpers derive pixel width, row capacity, pagination, and
image cost from the same resolved profile as the renderer. The active proxy's
Anthropic admission is separate; OpenAI requests never reach these helpers.
