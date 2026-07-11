/**
 * Dashboard HONESTY invariants — the savings math can never OVERCLAIM.
 *
 * dashboard-api.test.ts checks specific hand-picked scenarios with hardcoded
 * expected numbers. This file is the categorical complement: it sweeps a grid of
 * inputs through the pure cost/baseline functions and asserts universal honesty
 * properties that must hold for EVERY input — so a regression that overclaims in
 * a case nobody thought to hardcode still goes red.
 *
 * The displayed "Saved" = baseline_eff − actual_eff. The two ways to overclaim:
 *   (a) inflate the baseline (the "as text" counterfactual), or
 *   (b) price the counterfactual WARM when this turn was actually COLD (claiming
 *       savings on a prefix that would have been cached as text anyway).
 * The invariants below pin both down on the Anthropic and GPT paths.
 *
 * These are the pure formula functions (no dashboard plumbing) on purpose — they
 * ARE the honesty math; testing them directly makes the guarantees categorical.
 *
 * Run just this file:  pnpm vitest run tests/savings-honesty.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  accountAnthropicInput,
  CACHE_CREATE_1H_RATE,
  CACHE_CREATE_5M_RATE,
  CACHE_READ_RATE,
  type AnthropicAccountingInput,
} from '../src/core/baseline.js';
import {
  computeOpenAIBaselineInputEff,
  computeOpenAIActualInputEff,
  computeOpenAIBaselineRawTokens,
  openAICacheReadRate,
} from '../src/core/openai-savings.js';

const GPT = 'gpt-5.6-sol';

// ===========================================================================
describe('GPT savings honesty (vs the real o200k cached-rate model)', () => {
  const inputs = [0, 1_000, 10_000];
  const cacheds = [0, 500, 2_000, 50_000]; // last exceeds input → must clamp
  const imageToks = [0, 800, 8_000];
  const baselineImaged = [0, 5_000, 50_000];

  const sweep = (f: (i: number, c: number, im: number, b: number) => void) => {
    for (const i of inputs) for (const c of cacheds) for (const im of imageToks) for (const b of baselineImaged) f(i, c, im, b);
  };

  it('credits ZERO when nothing was imaged (no phantom savings on passthrough)', () => {
    sweep((i, c, im, b) => {
      if (im > 0 && b > 0 && i > 0) return; // imaging-active case handled elsewhere
      const actual = computeOpenAIActualInputEff(i, c, GPT);
      const baseline = computeOpenAIBaselineInputEff(i, c, im, b, GPT);
      expect(baseline - actual).toBe(0);
    });
  });

  it('saved == (textTokens − imageTokens) × cache-weight, EXACTLY (no inflation)', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      const actual = computeOpenAIActualInputEff(i, c, GPT);
      const baseline = computeOpenAIBaselineInputEff(i, c, im, b, GPT);
      const saved = baseline - actual;
      const weight = c > 0 ? openAICacheReadRate(GPT) : 1.0;
      expect(saved).toBeCloseTo((b - im) * weight, 6);
    });
  });

  it('OVERCLAIM GUARD: a warm turn never claims more savings than the same turn cold', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      if (b - im < 0) return; // post-gate reality: imaging is only chosen when it saves
      const savedWarm =
        computeOpenAIBaselineInputEff(i, Math.max(1, c), im, b, GPT) -
        computeOpenAIActualInputEff(i, Math.max(1, c), GPT);
      const savedCold =
        computeOpenAIBaselineInputEff(i, 0, im, b, GPT) - computeOpenAIActualInputEff(i, 0, GPT);
      expect(savedWarm).toBeLessThanOrEqual(savedCold + 1e-9);
    });
  });

  it('saved sign is honest: a real win is positive, a (hypothetical) loss is negative — never fabricated', () => {
    sweep((i, c, im, b) => {
      if (!(im > 0 && b > 0 && i > 0)) return;
      const saved = computeOpenAIBaselineInputEff(i, c, im, b, GPT) - computeOpenAIActualInputEff(i, c, GPT);
      expect(Math.sign(saved)).toBe(Math.sign(b - im));
      // Ceiling: the cache weight is ≤ 1, so |saved| can never exceed the raw delta.
      expect(Math.abs(saved)).toBeLessThanOrEqual(Math.abs(b - im) + 1e-9);
    });
  });

  it('raw-token counterfactual has MORE tokens than what we sent (when imaging saved)', () => {
    sweep((i, c, im, b) => {
      if (!(i > 0)) return;
      const raw = computeOpenAIBaselineRawTokens(i, im, b);
      expect(raw).toBeGreaterThanOrEqual(0);
      if (b - im >= 0) expect(raw).toBeGreaterThanOrEqual(i);
    });
  });
});

// ===========================================================================
describe('Anthropic savings honesty (cache-create / cache-read aware)', () => {
  const account = (
    overrides: Partial<AnthropicAccountingInput> = {},
  ) => accountAnthropicInput({
    compressed: true,
    probeStatus: 'ok',
    usagePresent: true,
    baselineTokens: 30_000,
    baselineCacheableTokens: 20_000,
    inputTokens: 100,
    cacheCreateTokens: 2_000,
    cacheReadTokens: 0,
    cacheCreate5mTokens: 2_000,
    baselineCacheCreateRate: CACHE_CREATE_5M_RATE,
    ...overrides,
  });

  it('credits only a transformed row with an explicit complete four-probe result', () => {
    const rejected: Partial<AnthropicAccountingInput>[] = [
      { compressed: false },
      { probeStatus: undefined },
      { probeStatus: 'partial' },
      { probeStatus: 'failed' },
      { usagePresent: false },
      { baselineTokens: undefined },
      { baselineCacheableTokens: undefined },
    ];
    for (const override of rejected) {
      const result = account(override);
      expect(result.creditSaving).toBe(false);
      expect(result.savedInputEff).toBe(0);
      expect(result.baselineInputEff).toBe(result.actualInputEff);
    }
  });

  it('prices an exact marker-free zero prefix as an ordinary cold request', () => {
    const result = account({ baselineCacheableTokens: 0 });
    expect(result.creditSaving).toBe(true);
    expect(result.actualInputEff).toBe(2_600);
    expect(result.baselineInputEff).toBe(30_000);
    expect(result.savedInputEff).toBe(27_400);
  });

  it('prices five-minute creation at 1.25x and one-hour or unknown creation at 2x', () => {
    const fiveMinute = account();
    const oneHour = account({
      cacheCreate5mTokens: undefined,
      cacheCreate1hTokens: 2_000,
      baselineCacheCreateRate: CACHE_CREATE_1H_RATE,
    });
    const unknown = account({
      cacheCreate5mTokens: undefined,
      cacheCreate1hTokens: undefined,
      baselineCacheCreateRate: undefined,
    });

    expect(fiveMinute.actualInputEff).toBe(2_600);
    expect(fiveMinute.baselineInputEff).toBe(35_000);
    expect(oneHour.actualInputEff).toBe(4_100);
    expect(oneHour.baselineInputEff).toBe(50_000);
    expect(unknown.actualInputEff).toBe(oneHour.actualInputEff);
    expect(unknown.baselineInputEff).toBe(oneHour.baselineInputEff);
  });

  it('prices any unclassified cache-create remainder at 2x', () => {
    const result = account({
      cacheCreateTokens: 3_000,
      cacheCreate5mTokens: 1_000,
      cacheCreate1hTokens: 1_000,
    });
    // 100 input + 1k*1.25 + 1k*2 + 1k unknown*2.
    expect(result.actualInputEff).toBe(5_350);
  });

  it('OVERCLAIM GUARD: pricing the text counterfactual WARM never claims more than COLD', () => {
    const cold = account({ warm: false, prevCacheable: 0 });
    const warm = account({ warm: true, prevCacheable: 10_000 });
    expect(warm.baselineInputEff).toBeLessThanOrEqual(cold.baselineInputEff);
    expect(warm.savedInputEff).toBeLessThanOrEqual(cold.savedInputEff);
  });

  it('preserves an admitted negative result instead of clamping it', () => {
    const loss = account({
      baselineTokens: 2_000,
      baselineCacheableTokens: 1_900,
      inputTokens: 3_000,
      cacheCreateTokens: 5_000,
      cacheCreate5mTokens: undefined,
      baselineCacheCreateRate: undefined,
    });
    expect(loss.savedInputEff).toBe(-9_100);
    expect(loss.savedInputEff).toBeLessThan(0);
  });

  it('baseline-eff is non-negative and bounded by conservative 2x recreation', () => {
    const result = account({
      cacheCreate5mTokens: undefined,
      baselineCacheCreateRate: undefined,
    });
    expect(result.baselineInputEff).toBeGreaterThanOrEqual(0);
    expect(result.baselineInputEff).toBeLessThanOrEqual(30_000 * CACHE_CREATE_1H_RATE);
  });
});

// ===========================================================================
// Different models price/tokenize differently — the savings math must use the
// RIGHT per-model figures, or the dashboard silently misprices a family.
describe('per-model pricing is applied correctly (Fable vs Opus vs GPT)', () => {
  it('Anthropic cache multipliers are SHARED policy across Claude models (Fable AND Opus)', () => {
    // 1.25× five-minute create / 2× one-hour create / 0.1× read is Anthropic
    // ephemeral-cache POLICY, identical for every Claude model — so the math is model-
    // independent. (Per-model TEXT token counts come from the real count_tokens
    // probe, NOT a static tokenizer — so Fable-vs-Opus tokenizer differences are
    // resolved upstream, not here.)
    expect(CACHE_CREATE_5M_RATE).toBe(1.25);
    expect(CACHE_CREATE_1H_RATE).toBe(2);
    expect(CACHE_READ_RATE).toBe(0.1);
  });

  it('cached-read discount is model-GATED: gpt-5.x and claude → 0.1×, other GPT must NOT get it', () => {
    // pxpipe images gpt-5.x and (via the Codex->Anthropic bridge) claude-*.
    // Both bill cache reads at 0.1x. Pricing an unrelated GPT row at the
    // aggressive 0.1x would overstate its cache savings, so the fallback stays
    // 0.5x. The gate keeps families from bleeding each other's rates.
    expect(openAICacheReadRate('gpt-5.6-sol')).toBe(0.1);
    expect(openAICacheReadRate('gpt-5.5')).toBe(0.1);
    // claude models arrive here through the bridge and must use Anthropic's rate.
    expect(openAICacheReadRate('claude-opus-4-8')).toBe(0.1);
    expect(openAICacheReadRate('grok-4.5')).toBe(0.25);
    expect(openAICacheReadRate('claude-sonnet-5')).toBe(0.1);
    expect(openAICacheReadRate('gpt-4o')).not.toBe(0.1);
    expect(openAICacheReadRate(undefined)).not.toBe(0.1);
  });

  it('GPT and Anthropic read rates happen to coincide (0.1×) but are sourced independently', () => {
    // Guard against a refactor that unifies them: they are the same number today
    // for different reasons (GPT cached-input vs Anthropic cache_read). If one
    // provider changes, only its own constant should move.
    expect(openAICacheReadRate('gpt-5.6-sol')).toBe(CACHE_READ_RATE);
  });
});
