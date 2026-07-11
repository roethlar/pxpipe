# context-correction-slice-3: OpenAI-compatible exact pass-through

**Severity**: HIGH — the prior Chat and Responses paths moved instructions and
history into synthetic user messages, added proxy-authored directives, stripped
tool-schema prose, and could report savings for a request whose trust boundary
had changed.
**Status**: In progress — pending independent review
**Branch**: `fix/provenance-safe-compression`
**Commit**: `de5d189f451b87400ce9bb0c4a7bdde0c0e3c3be` (base: parent
`bd6c38efd6776de03cb1d566e49ecef6d196f93a`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`, approved and independently accepted
through r3. This record covers implementation Slice 3 only. ANSI follow-ons,
documentation, packaging, installation, live calls, push, and merge are out of
scope.

## Evidence

- Before this slice, `src/core/openai.ts` replaced Chat system/developer content
  and Responses instructions with same-priority pointers, inserted instruction
  images into synthetic user items, stripped tool-schema descriptions, and could
  replace old conversation history with a synthetic user plus developer guard.
- Codex/Sol and Grok both use the Responses transformer, so the same rewrite was
  active for both subscription-backed harnesses whenever their model ids were
  enabled.
- The prior OpenAI profitability check compared a locally estimated image cost
  with selected text only. It did not use the correction plan's authoritative
  four-probe, complete-request, cache-aware admission transaction.

## Predicted observable failure

Without this slice, an enabled Chat or Responses request can arrive upstream with
different instructions, roles, message count, tool documentation, history, and
live-request framing. Sequential Codex/Sol and Grok requests can therefore be
observed only after proxy-authored rewriting, and telemetry can claim compression
or savings without a safe same-container representation or complete-request
measurement.

## What

OpenAI-compatible Chat and Responses entry points now return the caller's exact
`Uint8Array` object without parsing, mutating, or serializing it. They report an
explicit native result with zero image/compression fields and no hypothetical
savings evidence. Routing, authentication, model capture, usage capture, and
request hashing remain in the proxy and operate on the original bytes.

## Approach

`src/core/openai.ts:79-102` removes the entire active image, pointer, schema-strip,
synthetic-history, and guard implementation. Both public transform functions call
one exact-native helper; `compress=false` changes only the diagnostic reason, and
every other legacy option is byte-inert. Public vision-cost helpers remain for
historical accounting and offline export. Source comments mark the retained
options as compatibility fields so a future same-container implementation must
enter the shared no-hijack and strict full-request admission path instead of
reviving the deleted rewrite.

## Files changed

- `src/core/openai.ts` — deleted active OpenAI request rewriting; retained only
  vision-cost utilities and exact-native Chat/Responses entry points.
- `src/core/transform.ts`, `src/worker.ts` — corrected compatibility-option and
  Worker comments so they no longer promise OpenAI tool/history imaging.
- `tests/openai-gpt5.test.ts`, `tests/openai-history.test.ts` — exact body/reference,
  legacy-option immunity, Sol/Grok isolation, and dormant-planner boundaries.
- `tests/proxy-usage.test.ts`, `tests/cache-stability-e2e.test.ts`,
  `tests/design-behavior-e2e.test.ts` — exact proxy forwarding while preserving
  routes, authentication, models, usage, and per-request hashes.
- `tests/savings-math-e2e.test.ts`, `tests/public-api.test.ts`,
  `tests/worker-options.test.ts` — no-savings telemetry and immunity through public
  and Worker configuration surfaces.

## Guard proof

Coder proof was run while the new tests were present and the base implementation
was still active:

1. Run
   `pnpm vitest run tests/openai-gpt5.test.ts -t 'keeps every byte native for gpt-5.6-sol across every legacy option'`.
   Both the Chat and Responses guards failed because the returned body was a new,
   rewritten byte array rather than the original caller array.
2. Apply the slice and repeat the same command. Both guards pass.
3. The restored implementation passed the focused eight-file suite, then the
   canonical typecheck, all 843 tests, and production build. The built Node and
   library artifacts contain none of the deleted OpenAI banners, pointers, or
   live-request guard strings.

Independent reviewer proof in a disposable worktree should at minimum:

1. Check out the reviewed head, then replace only `src/core/openai.ts` with the
   base version from `bd6c38efd6776de03cb1d566e49ecef6d196f93a`.
2. Run
   `pnpm exec vitest run tests/openai-gpt5.test.ts tests/proxy-usage.test.ts -t 'keeps every byte native for gpt-5.6-sol across every legacy option|isolates sequential Sol and Grok Responses bodies, models, and hashes'`.
   The exact-native and sequential proxy guards must fail.
3. Restore `src/core/openai.ts` from the reviewed head and repeat the focused
   command; it must pass.
4. Confirm the worktree is clean, then run
   `pnpm run typecheck && pnpm test && pnpm run build` using the pinned npx pnpm
   fallback when pnpm is off PATH. It must pass.

## Coder dispute (if any)

Empty.

## Known gaps

- OpenAI-compatible context compression is intentionally disabled until a
  provider shape can carry images inside the original role and container and the
  complete candidate passes strict request-wide admission.
- `src/core/openai-history.ts` remains as a dormant pure planning utility for
  source compatibility; neither shipped OpenAI entry point imports or calls it.
- Explicit ANSI/CSI follow-ons and the broader cross-request/order fixture matrix
  belong to Slice 4. This slice already proves sequential Sol/Grok body, model, and
  hash isolation through the real proxy.
- No live model call, subscription smoke, package build/install, push, merge, or
  paused one-port routing work is authorized by this review.

## Reviewer comments

Pending independent Claude review.
