/** OpenAI model gates, pricing/profile utilities, and safe pass-through defaults. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPxpipeSupportedGptModel } from '../src/core/applicability.js';
import {
  isClaudeModel,
  openAIVisionTokens,
  resolveVisionCost,
  transformOpenAIChatCompletions,
  transformOpenAIResponses,
  visionTokensForModel,
} from '../src/core/openai.js';
import { resolveGptProfile } from '../src/core/gpt-model-profiles.js';
import type { TransformInfo, TransformOptions } from '../src/core/transform.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

let ambientPxpipeModels: string | undefined;
beforeEach(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  delete process.env.PXPIPE_MODELS;
});
afterEach(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

describe('isPxpipeSupportedGptModel', () => {
  it('keeps Sol and its siblings off by default', () => {
    for (const model of [
      'gpt-5',
      'gpt-5.5',
      'gpt-5.6',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5-mini',
      'gpt-5.6-nano',
      'gpt-5.6-sol[1m]',
      'gpt-5.6-sol-codex[1m]',
    ]) expect(isPxpipeSupportedGptModel(model), model).toBe(false);
  });

  it('enables only Sol ids and suffix aliases when opted in', () => {
    process.env.PXPIPE_MODELS = 'gpt-5.6-sol';
    for (const model of [
      'gpt-5.6-sol',
      'gpt-5.6-sol[1m]',
      'gpt-5.6-sol-codex',
      'gpt-5.6-sol-codex[1m]',
    ]) expect(isPxpipeSupportedGptModel(model), model).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-terra')).toBe(false);
  });

  it('rejects non-GPT-5 model values', () => {
    expect(isPxpipeSupportedGptModel('gpt-4o')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-50')).toBe(false);
    expect(isPxpipeSupportedGptModel('')).toBe(false);
    expect(isPxpipeSupportedGptModel(null)).toBe(false);
    expect(isPxpipeSupportedGptModel(undefined)).toBe(false);
  });
});

describe('OpenAI vision pricing utilities', () => {
  it('prices tile and patch models', () => {
    expect(openAIVisionTokens('gpt-5', 768, 1932)).toBe(1190);
    expect(openAIVisionTokens('gpt-4o', 768, 1932)).toBe(1445);
    expect(openAIVisionTokens('gpt-5-mini', 768, 1932)).toBe(2372);
    expect(openAIVisionTokens('gpt-5', 2048, 2048)).toBe(630);
  });

  it('resolves the expected pricing regimes', () => {
    expect(resolveVisionCost('gpt-5').regime).toBe('tile');
    expect(resolveVisionCost('gpt-5.6-sol').regime).toBe('patch');
    expect(resolveVisionCost('gpt-5-mini').regime).toBe('patch');
    expect(resolveVisionCost('gpt-5.6-nano').regime).toBe('patch');
    expect(resolveVisionCost('gpt-4o').regime).toBe('tile');
    expect(resolveVisionCost('o1').regime).toBe('tile');
  });

  it('keeps flagship and mini patch pricing separate', () => {
    expect(openAIVisionTokens('gpt-5.6-sol', 768, 1932)).toBe(1464);
    expect(openAIVisionTokens('gpt-5.5', 768, 1932)).toBe(1464);
    expect(openAIVisionTokens('gpt-5.6-sol', 4000, 4000)).toBe(10000);
    expect(resolveVisionCost('gpt-5.6-sol'))
      .toMatchObject({ regime: 'patch', multiplier: 1, patchCap: 10000 });
    expect(resolveVisionCost('gpt-5.5'))
      .toMatchObject({ regime: 'patch', multiplier: 1, patchCap: 10000 });
    expect(resolveVisionCost('gpt-5.6-mini'))
      .toMatchObject({ regime: 'patch', multiplier: 1.62, patchCap: 1536 });
    expect(resolveVisionCost('gpt-5.6-nano'))
      .toMatchObject({ regime: 'patch', multiplier: 2.46, patchCap: 1536 });
  });

  it('uses provider-specific pricing for Claude and Grok', () => {
    expect(isClaudeModel('claude-opus-4-8')).toBe(true);
    expect(isClaudeModel('claude-sonnet-5')).toBe(true);
    expect(isClaudeModel('anthropic/claude-3-5')).toBe(true);
    expect(isClaudeModel('gpt-5.6-sol')).toBe(false);
    expect(isClaudeModel(undefined)).toBe(false);
    expect(visionTokensForModel('claude-opus-4-8', 768, 1932)).toBe(2177);
    expect(visionTokensForModel('gpt-5', 768, 1932))
      .toBe(openAIVisionTokens('gpt-5', 768, 1932));
    expect(visionTokensForModel('grok-4.5', 768, 336)).toBe(Math.ceil((768 * 336) / 1000));
    expect(visionTokensForModel('grok-4.5', 764, 980)).toBeLessThan(
      openAIVisionTokens('gpt-4o', 764, 980),
    );
  });
});

const LARGE_SYSTEM = 'system instruction that must remain in its original role\n'.repeat(120);
const LARGE_DEVELOPER = 'developer instruction that must remain in its original role\n'.repeat(80);
const LARGE_TOOL_DESCRIPTION = 'tool documentation that must remain native\n'.repeat(100);
const LARGE_TOOL_OUTPUT = 'historical tool output that must remain native\n'.repeat(100);
const TOOL_PARAMETERS = {
  type: 'object',
  description: 'The root description must not be stripped.',
  properties: {
    description: {
      type: 'string',
      description: 'A property literally named description must remain exact.',
    },
    path: { type: 'string', description: 'An exact path.' },
  },
  required: ['description', 'path'],
  additionalProperties: false,
};

const MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-sol-codex[1m]',
  'grok-4.5',
  'grok-4.5-fast',
] as const;

const ALL_LEGACY_OPTIONS: TransformOptions = {
  compress: true,
  compressProjectGuidance: true,
  compressTools: true,
  compressReminders: true,
  compressToolResults: true,
  minCompressChars: 1,
  minReminderChars: 1,
  minToolResultChars: 1,
  cols: 24,
  maxImagesPerToolResult: 1,
  multiCol: 2,
  charsPerToken: 1,
  historyAmortizationHorizon: 8,
  priorWarmTokens: 100_000,
  priorWarmImageTokens: 100_000,
  collapseHistory: true,
  gptHistory: { collapseChunk: 0, sectionTokens: 100, maxImages: 1 },
  reflow: true,
  keepSharp: () => false,
  emitRecoverable: true,
};

/** No compatibility option may reactivate the retired cross-role rewrite. */
const LEGACY_OPTION_PROFILES: ReadonlyArray<readonly [string, TransformOptions]> = [
  ['defaults', {}],
  ['compression disabled', { compress: false }],
  ['master compression', { compress: true }],
  ['project guidance', { compressProjectGuidance: true }],
  ['tool docs', { compressTools: true }],
  ['reminders', { compressReminders: true }],
  ['tool results', { compressToolResults: true }],
  ['minimum context', { minCompressChars: 1 }],
  ['minimum reminder', { minReminderChars: 1 }],
  ['minimum tool result', { minToolResultChars: 1 }],
  ['columns', { cols: 24 }],
  ['tool image cap', { maxImagesPerToolResult: 1 }],
  ['multiple columns', { multiCol: 2 }],
  ['token estimate', { charsPerToken: 1 }],
  ['history horizon', { historyAmortizationHorizon: 8 }],
  ['warm text estimate', { priorWarmTokens: 100_000 }],
  ['warm image estimate', { priorWarmImageTokens: 100_000 }],
  ['history collapse', { collapseHistory: true }],
  ['history tuning', { gptHistory: { collapseChunk: 0, maxImages: 1 } }],
  ['reflow', { reflow: true }],
  ['sharpness callback', { keepSharp: () => false }],
  ['recoverable output', { emitRecoverable: true }],
  ['everything enabled', ALL_LEGACY_OPTIONS],
];

function chatBody(model: string, marker = 'CHAT_REQUEST_ONLY'): Uint8Array {
  return enc.encode(JSON.stringify({
    model,
    messages: [
      { role: 'system', content: `${marker}_SYSTEM\n${LARGE_SYSTEM}` },
      { role: 'developer', content: [{ type: 'text', text: `${marker}_DEVELOPER\n${LARGE_DEVELOPER}` }] },
      { role: 'user', content: `${marker}_OPENING_USER` },
      {
        role: 'assistant',
        content: `${marker}_ASSISTANT_HISTORY`,
        tool_calls: [{ id: `${marker}_CALL`, type: 'function', function: { name: 'read_exactly', arguments: '{"path":"/tmp/exact"}' } }],
      },
      { role: 'tool', tool_call_id: `${marker}_CALL`, content: `${marker}_RESULT\n${LARGE_TOOL_OUTPUT}` },
      { role: 'user', content: `${marker}_LIVE_REQUEST` },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'read_exactly',
        description: `${marker}_TOOL\n${LARGE_TOOL_DESCRIPTION}`,
        parameters: TOOL_PARAMETERS,
      },
    }],
    metadata: { marker },
  }));
}

function responsesBody(model: string, marker = 'RESPONSES_REQUEST_ONLY'): Uint8Array {
  return enc.encode(JSON.stringify({
    model,
    instructions: `${marker}_INSTRUCTIONS\n${LARGE_SYSTEM}`,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: `${marker}_DEVELOPER\n${LARGE_DEVELOPER}` }] },
      { role: 'system', content: `${marker}_SYSTEM_ITEM` },
      { role: 'user', content: `${marker}_OPENING_USER` },
      { role: 'assistant', content: `${marker}_ASSISTANT_HISTORY` },
      { type: 'function_call', call_id: `${marker}_CALL`, name: 'read_exactly', arguments: '{"path":"/tmp/exact"}' },
      { type: 'function_call_output', call_id: `${marker}_CALL`, output: `${marker}_RESULT\n${LARGE_TOOL_OUTPUT}` },
      { role: 'user', content: `${marker}_LIVE_REQUEST` },
    ],
    tools: [{
      type: 'function',
      name: 'read_exactly',
      description: `${marker}_TOOL\n${LARGE_TOOL_DESCRIPTION}`,
      parameters: TOOL_PARAMETERS,
    }],
    metadata: { marker },
  }));
}

function expectExactNative(
  result: { body: Uint8Array; info: TransformInfo },
  original: Uint8Array,
  snapshot: Uint8Array,
  label: string,
): void {
  expect(result.body, label).toBe(original);
  expect(result.body, label).toEqual(snapshot); // catches in-place mutation
  expect(result.info.compressed, label).toBe(false);
  expect(result.info.origChars, label).toBe(0);
  expect(result.info.compressedChars, label).toBe(0);
  expect(result.info.imageCount, label).toBe(0);
  expect(result.info.imageBytes, label).toBe(0);
  expect(result.info.staticChars, label).toBe(0);
  expect(result.info.imageTokens ?? 0, label).toBe(0);
  expect(result.info.baselineImagedTokens ?? 0, label).toBe(0);
  expect(result.info.collapsedTurns ?? 0, label).toBe(0);
  expect(result.info.collapsedChars ?? 0, label).toBe(0);
  expect(result.info.collapsedImages ?? 0, label).toBe(0);
  expect(result.info.imageSourceText, label).toBeUndefined();
  expect(result.info.recoverable, label).toBeUndefined();
}

describe('OpenAI Chat safe default', () => {
  for (const model of MODELS) {
    it(`keeps every byte native for ${model} across every legacy option`, async () => {
      const body = chatBody(model);
      const snapshot = body.slice();
      for (const [profile, options] of LEGACY_OPTION_PROFILES) {
        expectExactNative(
          await transformOpenAIChatCompletions(body, options),
          body,
          snapshot,
          `${model}: ${profile}`,
        );
      }
    });
  }

  it('does not leak model, system, tool, history, or live bytes between requests', async () => {
    const firstBody = chatBody('gpt-5.6-sol', 'FIRST_SOL_CHAT_SECRET');
    const secondBody = chatBody('grok-4.5', 'SECOND_GROK_CHAT_ONLY');
    const first = await transformOpenAIChatCompletions(firstBody, ALL_LEGACY_OPTIONS);
    const second = await transformOpenAIChatCompletions(secondBody, ALL_LEGACY_OPTIONS);
    expectExactNative(first, firstBody, firstBody.slice(), 'first Chat request');
    expectExactNative(second, secondBody, secondBody.slice(), 'second Chat request');
    expect(dec.decode(second.body)).toContain('SECOND_GROK_CHAT_ONLY');
    expect(dec.decode(second.body)).not.toContain('FIRST_SOL_CHAT_SECRET');
  });
});

describe('OpenAI Responses safe default', () => {
  for (const model of MODELS) {
    it(`keeps every byte native for ${model} across every legacy option`, async () => {
      const body = responsesBody(model);
      const snapshot = body.slice();
      for (const [profile, options] of LEGACY_OPTION_PROFILES) {
        expectExactNative(
          await transformOpenAIResponses(body, options),
          body,
          snapshot,
          `${model}: ${profile}`,
        );
      }
    });
  }

  it('does not leak model, instructions, tools, history, or live bytes between requests', async () => {
    const firstBody = responsesBody('gpt-5.6-sol', 'FIRST_SOL_RESPONSES_SECRET');
    const secondBody = responsesBody('grok-4.5', 'SECOND_GROK_RESPONSES_ONLY');
    const first = await transformOpenAIResponses(firstBody, ALL_LEGACY_OPTIONS);
    const second = await transformOpenAIResponses(secondBody, ALL_LEGACY_OPTIONS);
    expectExactNative(first, firstBody, firstBody.slice(), 'first Responses request');
    expectExactNative(second, secondBody, secondBody.slice(), 'second Responses request');
    expect(dec.decode(second.body)).toContain('SECOND_GROK_RESPONSES_ONLY');
    expect(dec.decode(second.body)).not.toContain('FIRST_SOL_RESPONSES_SECRET');
  });
});

describe('resolveGptProfile', () => {
  it('selects Claude, Sol, generic GPT, and Grok geometry by model id', () => {
    expect(resolveGptProfile('claude-opus-4-8')).toMatchObject({ maxHeightPx: 728, stripCols: 312 });
    expect(resolveGptProfile('claude-fable-5')).toMatchObject({ maxHeightPx: 728, stripCols: 312 });
    for (const model of [
      'gpt-5.6-sol',
      'gpt-5.6-sol[1m]',
      'gpt-5.6-sol-codex',
      'gpt-5.6-sol-codex[1m]',
      'gpt-5.6-sol-2026-07-09',
    ]) {
      const profile = resolveGptProfile(model);
      expect(profile.maxHeightPx, model).toBe(1932);
      expect(profile.stripCols, model).toBe(126);
      expect(profile.style.font, model).toBe('jetbrains-mono-10');
    }
    for (const model of ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-terra[1m]']) {
      expect(resolveGptProfile(model).stripCols, model).toBe(152);
    }
    expect(resolveGptProfile('grok-4.5')).toMatchObject({
      stripCols: 84,
      style: { font: 'spleen-5x8', cellWBonus: 4, cellHBonus: 4, aa: true },
    });
    expect(resolveGptProfile('grok-4').stripCols).toBe(84);
  });

  it('merges every style override into the selected profile', () => {
    const previous = process.env.PXPIPE_GPT_PROFILES;
    try {
      process.env.PXPIPE_GPT_PROFILES = JSON.stringify({
        'gpt-5.6-sol': {
          stripCols: 100,
          style: {
            font: 'spleen-5x8', cellWBonus: 2, cellHBonus: 3, aa: false,
            grid: true, gridCols: 4, colorCycle: true, markerScale: 2, markerRed: true,
          },
        },
      });
      expect(resolveGptProfile('gpt-5.6-sol-codex')).toMatchObject({
        stripCols: 100,
        style: {
          font: 'spleen-5x8', cellWBonus: 2, cellHBonus: 3, aa: false,
          grid: true, gridCols: 4, colorCycle: true, markerScale: 2, markerRed: true,
        },
      });
    } finally {
      if (previous === undefined) delete process.env.PXPIPE_GPT_PROFILES;
      else process.env.PXPIPE_GPT_PROFILES = previous;
    }
  });
});
