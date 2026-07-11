/**
 * Strict Anthropic candidate admission.
 *
 * This module is deliberately Workers-safe: it uses no Node APIs and performs
 * no network access itself. Hosts provide the no-model count_tokens transport.
 * Every uncertain outcome returns the caller's original byte buffer unchanged.
 */

import {
  buildBaselineCountTokensBody,
  buildCacheablePrefixCountTokensBody,
  countCacheControlMarkers,
} from './measurement.js';
import {
  CACHE_CREATE_1H_RATE,
  CACHE_CREATE_5M_RATE,
  CACHE_READ_RATE,
} from './baseline.js';
import {
  compareNoHijack,
  type ExactSpanImageReplacement,
  type NoHijackComparison,
} from './no-hijack.js';

export { CACHE_CREATE_1H_RATE, CACHE_CREATE_5M_RATE, CACHE_READ_RATE };
export const MIN_RELATIVE_SAVINGS = 0.10;
export const MIN_ABSOLUTE_SAVINGS = 256;

export type AdmissionProbeKind =
  | 'original_full'
  | 'original_prefix'
  | 'candidate_full'
  | 'candidate_prefix';

export type CountTokensProbe = (
  body: Uint8Array,
  kind: AdmissionProbeKind,
) => Promise<number | null>;

export type AdmissionNativeReason =
  | 'candidate_unchanged'
  | 'original_parse_error'
  | 'candidate_parse_error'
  | 'candidate_contract_invalid'
  | 'candidate_structure_invalid'
  | 'render_loss'
  | 'original_full_probe_body_unavailable'
  | 'candidate_full_probe_body_unavailable'
  | 'original_prefix_probe_body_unavailable'
  | 'candidate_prefix_probe_body_unavailable'
  | 'cache_marker_mismatch'
  | 'cache_position_unknown'
  | 'probe_unavailable'
  | 'original_full_probe_failed'
  | 'original_prefix_probe_failed'
  | 'candidate_full_probe_failed'
  | 'candidate_prefix_probe_failed'
  | 'invalid_probe_measurement'
  | 'insufficient_absolute_savings'
  | 'insufficient_relative_savings';

export interface AnthropicStructureResult {
  readonly valid: boolean;
  readonly reason?: 'messages_missing' | 'message_invalid' | 'system_role_order';
  readonly messageIndex?: number;
}

/**
 * The observed Anthropic mid-conversation system-role rule. A normal system
 * attachment must be immediately followed by an assistant message or terminate
 * the array. The provider's directive-only exception is an empty content array
 * with an output_config field; that form may occur at any position.
 */
export function validateAnthropicMessageStructure(value: unknown): AnthropicStructureResult {
  if (!value || typeof value !== 'object') {
    return { valid: false, reason: 'messages_missing' };
  }
  const messages = (value as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return { valid: false, reason: 'messages_missing' };
  }

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return { valid: false, reason: 'message_invalid', messageIndex: index };
    }
    const record = message as Record<string, unknown>;
    if (typeof record.role !== 'string') {
      return { valid: false, reason: 'message_invalid', messageIndex: index };
    }
    if (record.role !== 'system') continue;

    const directiveOnly =
      Array.isArray(record.content) &&
      record.content.length === 0 &&
      Object.prototype.hasOwnProperty.call(record, 'output_config');
    if (directiveOnly) continue;

    if (index === messages.length - 1) continue;
    const next = messages[index + 1];
    if (
      next &&
      typeof next === 'object' &&
      !Array.isArray(next) &&
      (next as { role?: unknown }).role === 'assistant'
    ) {
      continue;
    }
    return { valid: false, reason: 'system_role_order', messageIndex: index };
  }

  return { valid: true };
}

export interface AdmissionProbeBodies {
  readonly originalFull: Uint8Array;
  readonly originalPrefix: Uint8Array | null;
  readonly candidateFull: Uint8Array;
  readonly candidatePrefix: Uint8Array | null;
  /** A null prefix is an exact known zero only when the corresponding body has no marker. */
  readonly originalPrefixKnownZero: boolean;
  readonly candidatePrefixKnownZero: boolean;
  /** Compares the normalized count_tokens prefix bodies, not object identity. */
  readonly prefixesByteEqual: boolean;
}

export type AdmissionProbeBodyResult =
  | { readonly ok: true; readonly bodies: AdmissionProbeBodies }
  | { readonly ok: false; readonly reason: AdmissionNativeReason };

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index++) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Build the four logical count_tokens inputs without performing I/O. */
export function buildAdmissionProbeBodies(
  originalBody: Uint8Array,
  candidateBody: Uint8Array,
): AdmissionProbeBodyResult {
  const originalFull = buildBaselineCountTokensBody(originalBody);
  if (!originalFull) return { ok: false, reason: 'original_full_probe_body_unavailable' };
  const candidateFull = buildBaselineCountTokensBody(candidateBody);
  if (!candidateFull) return { ok: false, reason: 'candidate_full_probe_body_unavailable' };

  const originalMarkers = countCacheControlMarkers(originalBody);
  const candidateMarkers = countCacheControlMarkers(candidateBody);
  if (originalMarkers !== candidateMarkers) {
    return { ok: false, reason: 'cache_marker_mismatch' };
  }

  const originalPrefix = buildCacheablePrefixCountTokensBody(originalBody);
  const candidatePrefix = buildCacheablePrefixCountTokensBody(candidateBody);
  const originalPrefixKnownZero = originalMarkers === 0;
  const candidatePrefixKnownZero = candidateMarkers === 0;

  if (!originalPrefix && !originalPrefixKnownZero) {
    return { ok: false, reason: 'original_prefix_probe_body_unavailable' };
  }
  if (!candidatePrefix && !candidatePrefixKnownZero) {
    return { ok: false, reason: 'candidate_prefix_probe_body_unavailable' };
  }

  const prefixesByteEqual =
    originalPrefixKnownZero && candidatePrefixKnownZero
      ? true
      : originalPrefix !== null &&
        candidatePrefix !== null &&
        bytesEqual(originalPrefix, candidatePrefix);

  return {
    ok: true,
    bodies: {
      originalFull,
      originalPrefix,
      candidateFull,
      candidatePrefix,
      originalPrefixKnownZero,
      candidatePrefixKnownZero,
      prefixesByteEqual,
    },
  };
}

export interface AdmissionProbeMeasurements {
  readonly originalFull: number | null;
  readonly originalPrefix: number | null;
  readonly candidateFull: number | null;
  readonly candidatePrefix: number | null;
}

/**
 * Run all non-empty probes concurrently. A marker-free prefix is an exact zero,
 * so it needs no synthetic request; all other logical slots are independently
 * measured even when their bodies are byte-equal.
 */
export async function measureAdmissionProbeBodies(
  bodies: AdmissionProbeBodies,
  probe: CountTokensProbe,
): Promise<AdmissionProbeMeasurements> {
  const safeProbe = async (
    body: Uint8Array | null,
    kind: AdmissionProbeKind,
    knownZero: boolean,
  ): Promise<number | null> => {
    if (knownZero) return 0;
    if (!body) return null;
    try {
      return await probe(body, kind);
    } catch {
      return null;
    }
  };

  const [originalFull, originalPrefix, candidateFull, candidatePrefix] = await Promise.all([
    safeProbe(bodies.originalFull, 'original_full', false),
    safeProbe(bodies.originalPrefix, 'original_prefix', bodies.originalPrefixKnownZero),
    safeProbe(bodies.candidateFull, 'candidate_full', false),
    safeProbe(bodies.candidatePrefix, 'candidate_prefix', bodies.candidatePrefixKnownZero),
  ]);
  return { originalFull, originalPrefix, candidateFull, candidatePrefix };
}

/** Cache ownership of one changed source span, computed against the caller body. */
export type ChangedSpanCacheCoverage =
  | { readonly kind: 'cold' }
  | {
      readonly kind: 'covered';
      /** Stable structural identity of the caller-owned covering marker. */
      readonly marker: string;
      /** Runtime values are intentionally wider than the TypeScript provider type. */
      readonly ttl?: unknown;
    }
  | { readonly kind: 'unknown' };

export type CacheCreateTier = 'none' | '5m' | '1h' | 'conservative_1h';

export type CacheTierResult =
  | { readonly ok: true; readonly tier: CacheCreateTier; readonly rate: number }
  | { readonly ok: false; readonly reason: 'cache_position_unknown' };

/**
 * Select cache-create pricing for the changed prefix. Different markers,
 * omitted/unknown TTLs, or conflicting TTLs use the conservative one-hour rate.
 * Unknown source position is not guessed: it fails native.
 */
export function resolveCacheCreateTier(
  coverages: readonly ChangedSpanCacheCoverage[],
  prefixesByteEqual: boolean,
): CacheTierResult {
  if (prefixesByteEqual) return { ok: true, tier: 'none', rate: CACHE_READ_RATE };
  if (coverages.length === 0 || coverages.some((coverage) => coverage.kind === 'unknown')) {
    return { ok: false, reason: 'cache_position_unknown' };
  }

  const covered = coverages.filter(
    (coverage): coverage is Extract<ChangedSpanCacheCoverage, { kind: 'covered' }> =>
      coverage.kind === 'covered',
  );
  if (covered.length === 0) {
    // The normalized prefix changed, but every declared span was after it. The
    // metadata is internally inconsistent, so do not infer a cache position.
    return { ok: false, reason: 'cache_position_unknown' };
  }

  const markers = new Set(covered.map((coverage) => coverage.marker));
  const ttls = new Set(covered.map((coverage) => coverage.ttl));
  if (markers.size !== 1 || ttls.size !== 1) {
    return { ok: true, tier: 'conservative_1h', rate: CACHE_CREATE_1H_RATE };
  }
  const ttl = covered[0]!.ttl;
  if (ttl === '5m') return { ok: true, tier: '5m', rate: CACHE_CREATE_5M_RATE };
  if (ttl === '1h') return { ok: true, tier: '1h', rate: CACHE_CREATE_1H_RATE };
  return { ok: true, tier: 'conservative_1h', rate: CACHE_CREATE_1H_RATE };
}

export interface AdmissionPricing {
  readonly originalEffectiveTokens: number;
  readonly candidateEffectiveTokens: number;
  readonly signedSavingsTokens: number;
  readonly relativeSavings: number;
  readonly cacheTier: CacheCreateTier;
  readonly cacheCreateRate: number;
}

export type AdmissionPricingResult =
  | { readonly admitted: true; readonly pricing: AdmissionPricing }
  | {
      readonly admitted: false;
      readonly reason: AdmissionNativeReason;
      readonly pricing?: AdmissionPricing;
    };

function missingProbeReason(
  measurements: AdmissionProbeMeasurements,
): AdmissionNativeReason | undefined {
  if (measurements.originalFull === null) return 'original_full_probe_failed';
  if (measurements.originalPrefix === null) return 'original_prefix_probe_failed';
  if (measurements.candidateFull === null) return 'candidate_full_probe_failed';
  if (measurements.candidatePrefix === null) return 'candidate_prefix_probe_failed';
  return undefined;
}

/** Price the complete original and candidate requests, then apply both reserves. */
export function evaluateAdmissionPricing(
  measurements: AdmissionProbeMeasurements,
  tier: CacheCreateTier,
  prefixesByteEqual: boolean,
): AdmissionPricingResult {
  const missing = missingProbeReason(measurements);
  if (missing) return { admitted: false, reason: missing };

  const originalFull = measurements.originalFull as number;
  const originalPrefix = measurements.originalPrefix as number;
  const candidateFull = measurements.candidateFull as number;
  const candidatePrefix = measurements.candidatePrefix as number;
  const values = [originalFull, originalPrefix, candidateFull, candidatePrefix];
  if (
    values.some((value) => !Number.isFinite(value) || value < 0) ||
    originalPrefix > originalFull ||
    candidatePrefix > candidateFull
  ) {
    return { admitted: false, reason: 'invalid_probe_measurement' };
  }

  const cacheCreateRate =
    tier === '5m' ? CACHE_CREATE_5M_RATE
      : tier === '1h' || tier === 'conservative_1h' ? CACHE_CREATE_1H_RATE
        : CACHE_READ_RATE;
  if (!prefixesByteEqual && tier === 'none') {
    return { admitted: false, reason: 'cache_position_unknown' };
  }

  const originalEffectiveTokens =
    originalPrefix * CACHE_READ_RATE + (originalFull - originalPrefix);
  const candidatePrefixRate = prefixesByteEqual ? CACHE_READ_RATE : cacheCreateRate;
  const candidateEffectiveTokens =
    candidatePrefix * candidatePrefixRate + (candidateFull - candidatePrefix);
  const signedSavingsTokens = originalEffectiveTokens - candidateEffectiveTokens;
  const relativeSavings = originalEffectiveTokens > 0
    ? signedSavingsTokens / originalEffectiveTokens
    : Number.NEGATIVE_INFINITY;
  const pricing: AdmissionPricing = {
    originalEffectiveTokens,
    candidateEffectiveTokens,
    signedSavingsTokens,
    relativeSavings,
    cacheTier: tier,
    cacheCreateRate,
  };

  if (signedSavingsTokens < MIN_ABSOLUTE_SAVINGS) {
    return { admitted: false, reason: 'insufficient_absolute_savings', pricing };
  }
  if (relativeSavings < MIN_RELATIVE_SAVINGS) {
    return { admitted: false, reason: 'insufficient_relative_savings', pricing };
  }
  return { admitted: true, pricing };
}

export interface AdmitAnthropicCandidateInput {
  readonly originalBody: Uint8Array;
  readonly candidateBody: Uint8Array;
  readonly replacements?: readonly ExactSpanImageReplacement[];
  readonly changedSpanCache: readonly ChangedSpanCacheCoverage[];
  readonly probe?: CountTokensProbe;
}

export interface AnthropicAdmissionDecision {
  readonly admitted: boolean;
  /** Exact caller buffer on every native result; candidate buffer only when admitted. */
  readonly body: Uint8Array;
  readonly reason?: AdmissionNativeReason;
  readonly structure?: AnthropicStructureResult;
  readonly noHijack?: NoHijackComparison;
  readonly measurements?: AdmissionProbeMeasurements;
  readonly pricing?: AdmissionPricing;
  readonly cacheTier?: CacheCreateTier;
  readonly prefixesByteEqual?: boolean;
}

/** End-to-end fail-native admission for one all-bucket Anthropic candidate. */
export async function admitAnthropicCandidate(
  input: AdmitAnthropicCandidateInput,
): Promise<AnthropicAdmissionDecision> {
  if (bytesEqual(input.originalBody, input.candidateBody)) {
    return { admitted: false, body: input.originalBody, reason: 'candidate_unchanged' };
  }

  let original: unknown;
  try {
    original = JSON.parse(new TextDecoder().decode(input.originalBody)) as unknown;
  } catch {
    return { admitted: false, body: input.originalBody, reason: 'original_parse_error' };
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(input.candidateBody)) as unknown;
  } catch {
    return { admitted: false, body: input.originalBody, reason: 'candidate_parse_error' };
  }
  const structure = validateAnthropicMessageStructure(candidate);
  if (!structure.valid) {
    return {
      admitted: false,
      body: input.originalBody,
      reason: 'candidate_structure_invalid',
      structure,
    };
  }
  const noHijack = compareNoHijack(
    'anthropic',
    original,
    candidate,
    input.replacements,
  );
  if (!noHijack.ok) {
    return {
      admitted: false,
      body: input.originalBody,
      reason: 'candidate_contract_invalid',
      structure,
      noHijack,
    };
  }

  const built = buildAdmissionProbeBodies(input.originalBody, input.candidateBody);
  if (!built.ok) {
    return {
      admitted: false,
      body: input.originalBody,
      reason: built.reason,
      structure,
      noHijack,
    };
  }
  const tier = resolveCacheCreateTier(input.changedSpanCache, built.bodies.prefixesByteEqual);
  if (!tier.ok) {
    return {
      admitted: false,
      body: input.originalBody,
      reason: tier.reason,
      structure,
      noHijack,
      prefixesByteEqual: built.bodies.prefixesByteEqual,
    };
  }
  if (!input.probe) {
    return {
      admitted: false,
      body: input.originalBody,
      reason: 'probe_unavailable',
      structure,
      noHijack,
      cacheTier: tier.tier,
      prefixesByteEqual: built.bodies.prefixesByteEqual,
    };
  }

  const measurements = await measureAdmissionProbeBodies(built.bodies, input.probe);
  const priced = evaluateAdmissionPricing(
    measurements,
    tier.tier,
    built.bodies.prefixesByteEqual,
  );
  if (!priced.admitted) {
    return {
      admitted: false,
      body: input.originalBody,
      reason: priced.reason,
      structure,
      noHijack,
      measurements,
      pricing: priced.pricing,
      cacheTier: tier.tier,
      prefixesByteEqual: built.bodies.prefixesByteEqual,
    };
  }
  return {
    admitted: true,
    body: input.candidateBody,
    structure,
    noHijack,
    measurements,
    pricing: priced.pricing,
    cacheTier: tier.tier,
    prefixesByteEqual: built.bodies.prefixesByteEqual,
  };
}
