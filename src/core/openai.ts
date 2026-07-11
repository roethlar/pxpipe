/**
 * OpenAI-compatible request handling.
 *
 * Chat Completions and Responses requests are deliberately byte-exact native
 * until the provider exposes an image shape that can replace source text inside
 * its original role and container. Any future transform must also pass the
 * shared no-hijack checks and strict full-request token measurement before it is
 * allowed to forward a changed body.
 *
 * Vision-pricing helpers remain exported for historical telemetry and offline
 * analysis; they do not enable request rewriting.
 */

import {
  resolveGptProfile,
  type GptVisionCost,
} from './gpt-model-profiles.js';
import {
  ANTHROPIC_PIXELS_PER_TOKEN,
  IMAGE_COST_SAFETY_MARGIN,
  nativeTransformInfo,
  type TransformInfo,
  type TransformOptions,
} from './transform.js';

type VisionCost = GptVisionCost;

export function resolveVisionCost(model: string): VisionCost {
  return resolveGptProfile(model).vision;
}

export function openAIVisionTokens(model: string, w: number, h: number): number {
  const cost = resolveVisionCost(model);
  if (cost.regime === 'patch') {
    const patches = Math.min(cost.patchCap, Math.ceil(w / 32) * Math.ceil(h / 32));
    return Math.ceil(patches * cost.multiplier);
  }

  let width = w;
  let height = h;
  if (Math.max(width, height) > 2048) {
    const ratio = 2048 / Math.max(width, height);
    width = Math.floor(width * ratio);
    height = Math.floor(height * ratio);
  }
  if (Math.min(width, height) > 768) {
    const ratio = 768 / Math.min(width, height);
    width = Math.floor(width * ratio);
    height = Math.floor(height * ratio);
  }
  return cost.base + cost.perTile * (Math.ceil(width / 512) * Math.ceil(height / 512));
}

/** True when an OpenAI-compatible request is served by a Claude model. */
export function isClaudeModel(model: string | null | undefined): boolean {
  const normalized = (model ?? '').toLowerCase();
  return normalized.startsWith('claude') || normalized.includes('anthropic');
}

export function isGrokModel(model: string | null | undefined): boolean {
  return (model ?? '').toLowerCase().startsWith('grok-');
}

/** Measured 2026-07-09 on grok-4.5. Retained for historical accounting. */
export const GROK_TOKENS_PER_MEGAPIXEL = 1000;

/** Historical per-image token cost for the model that served a request. */
export function visionTokensForModel(model: string, w: number, h: number): number {
  if (isClaudeModel(model)) {
    return Math.ceil((w * h / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
  }
  if (isGrokModel(model)) {
    const pixels = Math.max(0, w) * Math.max(0, h);
    return Math.max(1, Math.ceil((pixels / 1_000_000) * GROK_TOKENS_PER_MEGAPIXEL));
  }
  return openAIVisionTokens(model, w, h);
}

function exactNativeResult(
  body: Uint8Array,
  opts: TransformOptions,
): { body: Uint8Array; info: TransformInfo } {
  const reason = opts.compress === false
    ? 'compress=false'
    : 'same_container_image_unsupported';
  return { body, info: nativeTransformInfo(reason) };
}

/** Return the exact caller-owned Chat Completions bytes without parsing them. */
export async function transformOpenAIChatCompletions(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  return exactNativeResult(body, opts);
}

/** Return the exact caller-owned Responses bytes without parsing them. */
export async function transformOpenAIResponses(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  return exactNativeResult(body, opts);
}
