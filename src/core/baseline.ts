/**
 * Cache-aware baseline math for the unproxied counterfactual.
 * Workers-safe: no node:, no Buffer, no process.*. Pure number math.
 * See docs/CACHING_AND_SAVINGS.md for the full derivation and audit history.
 */

/** Documented Anthropic price ratios. */
export const CACHE_CREATE_5M_RATE = 1.25;
export const CACHE_CREATE_1H_RATE = 2.0;
/** Historical alias retained for callers that explicitly mean five-minute creation. */
export const CACHE_CREATE_RATE = CACHE_CREATE_5M_RATE;
export const CACHE_READ_RATE = 0.1;

/** Anthropic prompt-cache TTL (seconds). Kept for callers that display provider
 *  docs, but savings math does not use TTL to infer a hypothetical text-cache
 *  hit: text is considered warm only when the actual request reports cr > 0. */
export const CACHE_TTL_SEC = 300;

/** This session's previous usage-bearing turn, used only for warm split sizing. */
export interface BaselineWarmthPrev {
  /** Completion time of that turn, in wall-clock seconds. */
  ts: number;
  /** Cacheable-prefix tokens measured that turn (0 if the probe missed). */
  cacheable: number;
  /** Hash of the image-bound/static text prefix. If it changes, do not reuse the
   *  prior prefix size for this row's text reused/grown split. */
  prefixSha?: string;
}

/**
 * Decide whether the TEXT counterfactual's prefix was warm this turn.
 *
 * Strict accounting rule: the imagined text path gets the same observed cache
 * state as the real image path. `cr > 0` is server proof that the request read a
 * warm prefix, so the text baseline is warm too. `cr === 0` means the actual
 * request did not read cache, so the text baseline is priced cold too. We do not
 * use wall-clock TTL to claim that text would have been warm while images were
 * cold; that would be an unobservable counterfactual and can create negative
 * rows from cache assumptions rather than token savings.
 *
 * When cr proves warmth, a completed same-prefix prior is used only to estimate
 * how much of the text prefix was reused vs grown. If none is available, assume
 * full reuse of this turn's cacheable prefix; this is conservative for savings.
 *
 * @param prev       this session's previous usage-bearing turn, or undefined.
 * @param nowSec     request-start wall-clock seconds, used only to reject prior
 *                   rows that had not completed before this request was sent.
 * @param cacheable  this turn's cacheable-prefix tokens (the full-reuse credit
 *                   when warm only via cr, since cr proves a read but not the split).
 * @param cr         observed cache-read tokens this turn; the only warm/cold signal.
 * @param ttlSec     legacy parameter; no longer decides warm/cold. It only
 *                   bounds whether a prior prefix size is used for reused/grown
 *                   splitting after cr > 0 has already proved warmth.
 * @param prefixSha  stable-prefix fingerprint for the text counterfactual. A
 *                   prior prefix size is reused only when this matches.
 */
export function deriveBaselineWarmth(
  prev: BaselineWarmthPrev | undefined,
  nowSec: number,
  cacheable: number,
  cr: number,
  ttlSec: number = CACHE_TTL_SEC,
  prefixSha?: string,
): { warm: boolean; prevCacheable: number } {
  const age = prev !== undefined ? nowSec - prev.ts : Number.POSITIVE_INFINITY;
  // A missing identity is unknown, never evidence of equality. This prevents
  // an identity-less legacy/alternate row from bridging two exact digests and
  // lending the later row an unrelated prior prefix size.
  const samePrefix =
    prev?.prefixSha !== undefined &&
    prefixSha !== undefined &&
    prev.prefixSha === prefixSha;
  // cr is the only warm/cold signal. A prior only refines the warm split.
  if (!(cr > 0)) return { warm: false, prevCacheable: 0 };
  // Fresh prior: use its real prefix size for the reused/grown split. Without
  // one, cr proves warmth but not the split, so assume full reuse.
  const freshPrior =
    prev !== undefined &&
    prev.cacheable > 0 &&
    age >= 0 &&
    age < ttlSec &&
    samePrefix;
  return { warm: true, prevCacheable: freshPrior ? prev!.cacheable : cacheable };
}

/**
 * Weighted input cost for the unproxied TEXT counterfactual (see docs/CACHING_AND_SAVINGS.md).
 *
 * Warmth matters: a TEXT prefix is only a cheap cache-read when a warm cache
 * actually existed this turn. The previous warmth-FREE version always priced
 * the cacheable prefix at CACHE_READ_RATE, which fabricated a "free read" on
 * cold/TTL-expiry turns where text would in fact have paid a 1.25× create —
 * that produced a phantom loss vs the imaged path (which DOES pay the create).
 *
 *   cold turn (first turn / >5min since this session's last turn):
 *     text has no warm cache either ⇒ cacheable×CACHE_CREATE_RATE + coldTail×1.0
 *   warm turn (a prior turn cached the prefix within TTL):
 *     text append-caches ⇒ reused×CACHE_READ_RATE + grown×CACHE_CREATE_RATE + coldTail×1.0
 *     where reused = min(prevCacheable, cacheable), grown = cacheable − reused.
 *     This is what TEXT pays regardless of whether pxpipe's image busted its
 *     own cache on a growth turn — so the real growth loss is preserved.
 *
 * Saving = baseline_eff − actual_eff; can be negative (honestly reported, not floored).
 *
 * @param baselineCacheable  tokens up to the last cache_control marker. Zero is
 *                           an exact marker-free prefix; a negative value means
 *                           the prefix measurement is unavailable.
 * @param warm               was a warm cache available for this session this turn?
 * @param prevCacheable      cacheable prefix size on this session's previous turn (warm only).
 */
export function computeBaselineInputEff(
  baseline: number,
  baselineCacheable: number,
  inputTokens: number,
  cc: number,
  cr: number,
  warm = false,
  prevCacheable = 0,
  cacheCreateRate = CACHE_CREATE_1H_RATE,
  actualCacheCreate5mTokens?: number,
  actualCacheCreate1hTokens?: number,
): number {
  if (baseline <= 0) return 0;
  // Probe miss: can't split prefix from tail, so credit nothing (same as actual).
  // A marker-free request has a known zero prefix and is priced cold below.
  if (baselineCacheable < 0) {
    return computeActualInputEff(
      inputTokens,
      cc,
      cr,
      actualCacheCreate5mTokens,
      actualCacheCreate1hTokens,
    );
  }
  const cacheable = Math.min(baselineCacheable, baseline);
  const coldTail = baseline - cacheable;
  if (warm) {
    // Text reads the prefix it already had cached (0.10×) and creates only the
    // growth since last turn (1.25×). Independent of the image path's cache.
    const reused = Math.min(Math.max(prevCacheable, 0), cacheable);
    const grown = cacheable - reused;
    return reused * CACHE_READ_RATE + grown * cacheCreateRate + coldTail * 1.0;
  }
  // Cold (first turn / TTL expiry): no warm cache for text either, so it
  // re-creates the whole cacheable prefix at the create rate — same event the
  // imaged path pays. Removes the phantom "free read" that fabricated a loss.
  return cacheable * cacheCreateRate + coldTail * 1.0;
}

/**
 * Weighted input cost pxpipe actually paid this turn.
 *
 * Anthropic reports the aggregate cache-create count plus, on current API
 * versions, a split by five-minute and one-hour tier. Price the known split at
 * its real rates. Any absent or inconsistent remainder is conservatively priced
 * as one-hour creation; silently assuming five-minute creation understated the
 * installed loss.
 */
export function computeActualInputEff(
  inputTokens: number,
  cc: number,
  cr: number,
  cc5m?: number,
  cc1h?: number,
): number {
  const create = Math.max(0, cc);
  const oneHour = Math.min(create, Math.max(0, cc1h ?? 0));
  const fiveMinute = Math.min(
    create - oneHour,
    Math.max(0, cc5m ?? 0),
  );
  const unknown = create - oneHour - fiveMinute;
  return inputTokens
    + oneHour * CACHE_CREATE_1H_RATE
    + fiveMinute * CACHE_CREATE_5M_RATE
    + unknown * CACHE_CREATE_1H_RATE
    + Math.max(0, cr) * CACHE_READ_RATE;
}

export type BaselineProbeStatus = 'ok' | 'partial' | 'failed';

export interface AnthropicAccountingInput {
  readonly compressed: boolean;
  readonly probeStatus?: BaselineProbeStatus;
  readonly usagePresent: boolean;
  readonly baselineTokens?: number;
  readonly baselineCacheableTokens?: number;
  readonly inputTokens: number;
  readonly cacheCreateTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreate5mTokens?: number;
  readonly cacheCreate1hTokens?: number;
  readonly warm?: boolean;
  readonly prevCacheable?: number;
  /** Rate for the unchanged caller-owned cache marker. Unknown is one-hour. */
  readonly baselineCacheCreateRate?: typeof CACHE_CREATE_5M_RATE | typeof CACHE_CREATE_1H_RATE;
}

export interface AnthropicAccountingResult {
  readonly haveUsage: boolean;
  readonly haveBaseline: boolean;
  readonly creditSaving: boolean;
  readonly actualInputEff: number;
  readonly baselineInputEff: number;
  readonly savedInputEff: number;
}

/**
 * Single signed Anthropic input-accounting function used by live, replay,
 * sessions, and stats consumers. Only a genuinely transformed row with a
 * complete four-probe status may receive a counterfactual. Passthrough and
 * incomplete rows equal their actual cost.
 */
export function accountAnthropicInput(
  input: AnthropicAccountingInput,
): AnthropicAccountingResult {
  const haveUsage = input.usagePresent;
  const baseline = input.baselineTokens;
  const haveBaseline =
    input.probeStatus === 'ok'
    && typeof baseline === 'number'
    && Number.isFinite(baseline)
    && baseline > 0
    && typeof input.baselineCacheableTokens === 'number'
    && Number.isFinite(input.baselineCacheableTokens)
    && input.baselineCacheableTokens >= 0;
  const actualInputEff = haveUsage
    ? computeActualInputEff(
        input.inputTokens,
        input.cacheCreateTokens,
        input.cacheReadTokens,
        input.cacheCreate5mTokens,
        input.cacheCreate1hTokens,
      )
    : 0;
  const creditSaving = haveUsage && haveBaseline && input.compressed;
  const baselineInputEff = creditSaving
    ? computeBaselineInputEff(
        baseline,
        Math.max(0, input.baselineCacheableTokens ?? 0),
        input.inputTokens,
        input.cacheCreateTokens,
        input.cacheReadTokens,
        input.warm ?? false,
        input.prevCacheable ?? 0,
        input.baselineCacheCreateRate ?? CACHE_CREATE_1H_RATE,
        input.cacheCreate5mTokens,
        input.cacheCreate1hTokens,
      )
    : actualInputEff;
  return {
    haveUsage,
    haveBaseline,
    creditSaving,
    actualInputEff,
    baselineInputEff,
    savedInputEff: baselineInputEff - actualInputEff,
  };
}
