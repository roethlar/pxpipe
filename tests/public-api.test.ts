import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCountTokensBodies,
  getAllowedModelBases,
  isPxpipeSupportedGptModel,
  isPxpipeSupportedModel,
  setAllowedModelBases,
  shouldTransformAnthropicMessages,
  transformAnthropicMessages,
  transformOpenAIChatCompletions,
  transformOpenAIResponses,
} from '../src/core/index.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

// Tests below assert DEFAULT model-scope behavior, which assumes PXPIPE_MODELS is unset.
// Snapshot and clear any ambient value (e.g. a dev shell that still exports PXPIPE_MODELS)
// before each test so the suite is deterministic regardless of the environment it runs in,
// then restore the original afterward. The per-test override cases still work: they see an
// unset var, set their own value, and clean up.
let ambientPxpipeModels: string | undefined;
beforeEach(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  delete process.env.PXPIPE_MODELS;
});
afterEach(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

describe('public library API', () => {
  it('recognizes Fable 5 (with suffix aliases) as the default scope; Opus is OFF by default', () => {
    expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
    expect(isPxpipeSupportedModel('claude-fable-5-high')).toBe(true);
    // Opus 4.8 is OPT-IN, not in the default scope — same pipeline/render as
    // Fable, but it reads imaged content at a tax (FINDINGS.md 2026-06-16), so
    // the default doesn't silently compress the operator's main driver. Enable
    // it via PXPIPE_MODELS or the dashboard "compress models" chips.
    expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false);
    // older Opus + other families are not in the default scope
    expect(isPxpipeSupportedModel('claude-opus-4-7')).toBe(false);
    expect(isPxpipeSupportedModel('claude-opus-4-6')).toBe(false);
    expect(isPxpipeSupportedModel('claude-mythos-5')).toBe(false);
    expect(isPxpipeSupportedModel('claude-fable-50')).toBe(false);
    expect(isPxpipeSupportedModel('claude-sonnet-4-7')).toBe(false);
    expect(isPxpipeSupportedModel(null)).toBe(false);
  });

  it('strips bracketed variant tags like [1m] before matching', () => {
    expect(isPxpipeSupportedModel('claude-fable-5[1m]')).toBe(true);
    expect(isPxpipeSupportedModel('claude-fable-5-high[1m]')).toBe(true);
    expect(isPxpipeSupportedModel('claude-opus-4-8[1m]')).toBe(false); // Opus opt-in, off by default
    // a non-scoped base is still rejected even with a variant tag
    expect(isPxpipeSupportedModel('claude-opus-4-7[1m]')).toBe(false);
  });

  it('honors PXPIPE_MODELS to override the default scope', () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      // narrow to Fable only
      process.env.PXPIPE_MODELS = 'claude-fable-5';
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false);
      // re-point to a different set
      process.env.PXPIPE_MODELS = 'claude-fable-5,claude-opus-4-7';
      expect(isPxpipeSupportedModel('claude-opus-4-7')).toBe(true);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false); // not in this set
    } finally {
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('honors the dashboard runtime override (setAllowedModelBases) over env/default', () => {
    try {
      // override takes precedence over the env/default scope
      setAllowedModelBases(['claude-fable-5', 'claude-opus-4-8']);
      expect(getAllowedModelBases()).toEqual(['claude-fable-5', 'claude-opus-4-8']);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(true); // opted in at runtime
      // empty list = compress nothing
      setAllowedModelBases([]);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(false);
      // null clears the override → back to the Fable-only default
      setAllowedModelBases(null);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);
      expect(isPxpipeSupportedModel('claude-opus-4-8')).toBe(false);
    } finally {
      setAllowedModelBases(null); // never leak the override into other tests
    }
  });

  it('keeps GPT 5.6 Sol off by default but preserves exact opt-in aliases', () => {
    expect(isPxpipeSupportedGptModel('gpt-5')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.5-codex')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol-codex')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-terra')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5-mini')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-4o')).toBe(false);

    process.env.PXPIPE_MODELS = 'gpt-5.6-sol';
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol-codex')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol[1m]')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6-sol-codex[1m]')).toBe(true);
    expect(isPxpipeSupportedGptModel('gpt-5.6')).toBe(false);
    expect(isPxpipeSupportedGptModel('gpt-5.6-terra')).toBe(false);
  });

  it('keeps Grok and Sol opt-in only (off by default, like Opus)', () => {
    // Pure-image exact OCR fails at production 5×8; do not image Grok unless
    // the operator opts in via PXPIPE_MODELS or the dashboard chip.
    const prev = process.env.PXPIPE_MODELS;
    try {
      delete process.env.PXPIPE_MODELS;
      expect(isPxpipeSupportedGptModel('grok-4.5')).toBe(false);
      expect(isPxpipeSupportedGptModel('grok-4')).toBe(false);
      expect(isPxpipeSupportedGptModel('grok-4.20')).toBe(false);
      expect(getAllowedModelBases()).not.toContain('grok-4.5');
      expect(getAllowedModelBases()).toEqual(['claude-fable-5']);

      process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,grok-4.5';
      expect(isPxpipeSupportedGptModel('grok-4.5')).toBe(true);
      expect(isPxpipeSupportedGptModel('grok-4.5-fast')).toBe(true); // -suffix alias
    } finally {
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('honors the single PXPIPE_MODELS scope for GPT families', () => {
    const prev = process.env.PXPIPE_MODELS;
    try {
      // Explicit Claude-only scope disables GPT imaging.
      process.env.PXPIPE_MODELS = 'claude-fable-5';
      expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false);
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);

      // Mixed CSV selects exactly those bases across families.
      process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
      expect(isPxpipeSupportedGptModel('gpt-5.5')).toBe(false);
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(true);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(true);

      // `off` disables everything.
      process.env.PXPIPE_MODELS = 'off';
      expect(isPxpipeSupportedGptModel('gpt-5.6-sol')).toBe(false);
      expect(isPxpipeSupportedModel('claude-fable-5')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PXPIPE_MODELS;
      else process.env.PXPIPE_MODELS = prev;
    }
  });

  it('reports applicability with route/method/body gates', () => {
    expect(shouldTransformAnthropicMessages({
      model: 'claude-fable-5',
      method: 'POST',
      path: '/v1/messages',
      bodyBytes: 10,
    })).toEqual({ eligible: true, reason: 'eligible' });
    expect(shouldTransformAnthropicMessages({
      model: 'claude-fable-5',
      method: 'GET',
      path: '/v1/messages',
      bodyBytes: 10,
    }).reason).toBe('unsupported_method');
    // Provider-prefixed routes createProxy() also transforms must be eligible
    // here too — the old endsWith('/v1/messages') check rejected /anthropic/messages.
    for (const path of ['/anthropic/v1/messages', '/anthropic/messages']) {
      expect(shouldTransformAnthropicMessages({
        model: 'claude-fable-5',
        method: 'POST',
        path,
        bodyBytes: 10,
      })).toEqual({ eligible: true, reason: 'eligible' });
    }
    expect(shouldTransformAnthropicMessages({
      model: 'claude-fable-5',
      method: 'POST',
      path: '/v1/messages/count_tokens',
      bodyBytes: 10,
    }).reason).toBe('unsupported_path');
  });

  it('builds count_tokens probe bodies from a messages body', () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-opus-4-7',
      max_tokens: 1024,
      stream: true,
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't', description: 'd', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h' } },
            { type: 'text', text: 'tail' },
          ],
        },
      ],
    }));

    const probes = buildCountTokensBodies(body);
    expect(probes.fullBody).toBeInstanceOf(Uint8Array);
    const full = JSON.parse(dec.decode(probes.fullBody!)) as Record<string, unknown>;
    expect(full.model).toBe('claude-opus-4-7');
    expect(full.max_tokens).toBeUndefined();
    expect(full.stream).toBeUndefined();
    expect(Array.isArray(full.messages)).toBe(true);

    expect(probes.cacheablePrefixBody).toBeInstanceOf(Uint8Array);
    const prefix = JSON.parse(dec.decode(probes.cacheablePrefixBody!)) as { messages: Array<{ content: unknown }> };
    const last = prefix.messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    expect((last.content as unknown[])).toHaveLength(1);
  });

  it('cacheable-prefix probe body pairs orphan tool_use blocks with synthetic tool_result', () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'thinking' },
            { type: 'tool_use', id: 'toolu_orphan_a', name: 'read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_orphan_a', content: 'result' },
            { type: 'text', text: 'next turn please', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'toolu_orphan_b', name: 'read', input: {} },
          ],
        },
        // tool_result for toolu_orphan_b would be in the dropped tail
      ],
    }));

    const probes = buildCountTokensBodies(body);
    expect(probes.cacheablePrefixBody).toBeInstanceOf(Uint8Array);
    const prefix = JSON.parse(dec.decode(probes.cacheablePrefixBody!)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // Truncation kept up to and including the cache_control-bearing block,
    // which sits in messages[2]. The cached-prefix should NOT include msg[3]
    // (the orphan tool_use), but if it did, the synthetic tool_result must
    // pair it. Either way: no orphan tool_use ids may remain unpaired.
    const allBlocks = prefix.messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as Array<{ type?: string }>) : [],
    );
    const orphanUses = allBlocks
      .filter((b) => b.type === 'tool_use')
      .map((b) => (b as { id?: string }).id);
    const results = new Set(
      allBlocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => (b as { tool_use_id?: string }).tool_use_id),
    );
    for (const id of orphanUses) {
      expect(results.has(id)).toBe(true);
    }
  });

  it('keeps standalone Anthropic transforms native when admission probes are unavailable', async () => {
    const unsupported = enc.encode(JSON.stringify({
      model: 'claude-sonnet-4-6',
      system: 'x'.repeat(20_000),
      messages: [{ role: 'user', content: 'hello' }],
    }));
    const skipped = await transformAnthropicMessages({ body: unsupported, model: 'claude-sonnet-4-6' });
    expect(skipped.applied).toBe(false);
    expect(skipped.reason).toBe('unsupported_model');
    expect(skipped.body).toBe(unsupported);

    const supportedRequest = {
      model: 'claude-fable-5',
      system: 'Important system instruction. '.repeat(1200),
      tools: [{
        name: 'read_file',
        description: 'Read a file from disk. '.repeat(200),
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      }],
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_public_api',
          content: 'public wrapper tool output '.repeat(6000),
        }],
      }],
    };
    const supported = enc.encode(JSON.stringify(supportedRequest));
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('standalone transforms must not probe the network');
    }) as typeof fetch;
    let transformed: Awaited<ReturnType<typeof transformAnthropicMessages>>;
    try {
      transformed = await transformAnthropicMessages({ body: supported, model: 'claude-fable-5' });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(fetchCalls).toBe(0);
    expect(transformed.applied).toBe(false);
    expect(transformed.reason).toBe('passthrough');
    expect(transformed.detail).toBe('admission_probe_unavailable');
    expect(transformed.body).toBe(supported);
    expect(dec.decode(transformed.body)).toBe(dec.decode(supported));
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.compressedChars).toBe(0);
    expect(transformed.info.imageCount).toBe(0);
    expect(transformed.info.baselineProbeStatus).toBeUndefined();
    expect(transformed.info.baselineTokens).toBeUndefined();
    expect(transformed.info.candidateTokens).toBeUndefined();
    expect(transformed.info.admissionSignedSavingsTokens).toBeUndefined();
    expect(transformed.info.admissionRelativeSavings).toBeUndefined();
    const supportedOut = JSON.parse(dec.decode(transformed.body)) as any;
    expect(supportedOut.system).toBe(supportedRequest.system);
    expect(supportedOut.tools).toEqual(supportedRequest.tools);
    // The caller sent zero markers, so exact native fallback still has zero.
    expect(transformed.cache.ownsCacheControl).toBe(false);
    expect(transformed.cache.markerCount).toBe(0);
  });

  it('keeps both exported OpenAI transforms byte-exact despite every legacy rewrite option', async () => {
    process.env.PXPIPE_MODELS = 'gpt-5.6-sol,grok-4.5';
    const chatBody = enc.encode(JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'System instruction. '.repeat(700) },
        { role: 'developer', content: 'Developer instruction. '.repeat(400) },
        { role: 'user', content: 'hello' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk. '.repeat(100),
          parameters: {
            type: 'object',
            description: 'Long root description.',
            properties: {
              path: { type: 'string', description: 'Path to read.' },
            },
            required: ['path'],
          },
        },
      }],
    }));
    const responsesBody = enc.encode(JSON.stringify({
      model: 'grok-4.5',
      instructions: 'Responses instruction. '.repeat(1000),
      input: [
        { role: 'developer', content: 'Developer item. '.repeat(500) },
        { role: 'user', content: 'hello from Grok' },
        { role: 'assistant', content: 'prior answer '.repeat(1000) },
      ],
      tools: [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file from disk. '.repeat(100),
        parameters: {
          type: 'object',
          description: 'Long root description.',
          properties: { path: { type: 'string', description: 'Path to read.' } },
          required: ['path'],
        },
      }],
    }));
    const legacyOptions = {
      compress: true,
      compressTools: true,
      collapseHistory: true,
      charsPerToken: 1,
      minCompressChars: 1,
      reflow: true,
    } as const;

    const chat = await transformOpenAIChatCompletions(chatBody, legacyOptions);
    const responses = await transformOpenAIResponses(responsesBody, legacyOptions);

    for (const [result, original] of [[chat, chatBody], [responses, responsesBody]] as const) {
      expect(result.body).toEqual(original);
      expect(dec.decode(result.body)).toBe(dec.decode(original));
      expect(result.info.compressed).toBe(false);
      expect(result.info.imageCount).toBe(0);
      expect(result.info.imageTokens).toBeUndefined();
      expect(result.info.baselineImagedTokens).toBeUndefined();
      expect(result.info.gateEval).toBeUndefined();
      expect(result.info.admissionSignedSavingsTokens).toBeUndefined();
    }
  });
});
