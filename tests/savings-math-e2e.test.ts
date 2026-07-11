/**
 * END-TO-END savings contract through the REAL proxy.
 *
 * OpenAI Chat remains byte-exact and therefore reports no compression or
 * counterfactual savings. Safe Anthropic candidates must pass all four provider
 * measurements; any probe failure stays native and reports no hypothetical savings.
 *
 *   fake api  = the upstream output plus a count_tokens tripwire
 *   our input = pxpipe's decision, read off the forwarded bytes and event
 *
 * These run with the production default options. Large OpenAI inputs deliberately
 * exceed every old image threshold so the byte-exact guard catches reactivation.
 *
 * Run just this file:  pnpm vitest run tests/savings-math-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

// The GPT tests below drive 'gpt-5.6-sol', which is intentionally absent from
// the built-in default scope (Fable 5 only). Pin PXPIPE_MODELS so the suite is
// deterministic regardless of the developer's shell (same convention as
// proxy-usage.test.ts) — without this, the file passes or fails depending on
// ambient env, which is exactly what broke CI.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

function fakeUpstream() {
  const main: { url: string; body: string }[] = [];
  const probes: { url: string; body: string }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const path = new URL(req.url).pathname;
    if (path.endsWith('/count_tokens')) {
      probes.push({ url: req.url, body: await req.clone().text() });
      throw new Error('count_tokens ran before contract validation');
    }
    main.push({ url: req.url, body: await req.clone().text() });
    if (path.includes('chat/completions')) {
      return new Response(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'm1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { main, probes, restore: () => { globalThis.fetch = real; } };
}

/** Drive the real proxy with the DEFAULT (realistic) gate and return the onRequest
 *  event (carries info.gateEval / imageTokens / baselineImagedTokens / compressed). */
async function driveAndCapture(
  path: string,
  body: string,
): Promise<{ event: ProxyEvent; out: string; probeCalls: number }> {
  const cap = fakeUpstream();
  let event: ProxyEvent | undefined;
  const proxy = createProxy({
    upstream: 'http://anthropic.test',
    apiKey: 'sk-ant',
    openAIUpstream: 'https://openai.test',
    openAIApiKey: 'sk-oai',
    transform: {}, // realistic gate — DEFAULTS (charsPerToken 4, minCompressChars 2000)
    onRequest: (e) => { event = e; },
  });
  const res = await proxy(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }),
  );
  await res.text();
  await new Promise((r) => setTimeout(r, 30)); // let onRequest fire
  cap.restore();
  return { event: event!, out: cap.main[0]?.body ?? '', probeCalls: cap.probes.length };
}

const slab = (n: number) =>
  '# CLAUDE.md\nYou are a helpful coding assistant.\n' + 'Follow the rules carefully. '.repeat(Math.ceil(n / 28));

const gptBody = (sysChars: number) =>
  JSON.stringify({
    model: 'gpt-5.6-sol',
    messages: [
      { role: 'system', content: slab(sysChars) },
      { role: 'user', content: 'hello' },
    ],
  });

const antBody = (opts: { model?: string; slabChars?: number }) => {
  if (opts.slabChars) {
    const project =
      DIRECT_PROJECT_GUIDANCE + '\n' +
      'Role-bound project guidance row. '.repeat(Math.ceil(opts.slabChars / 33));
    const req = makeCapturedRequest({ projectGuidance: project });
    req.model = opts.model ?? 'claude-fable-5';
    req.max_tokens = 16;
    return JSON.stringify(req);
  }
  return JSON.stringify({
    model: opts.model ?? 'claude-fable-5',
    max_tokens: 16,
    system: 'short',
    messages: [{ role: 'user', content: 'hello' }],
  });
};

// ===========================================================================
describe('savings math — OpenAI unchanged requests', () => {
  it('forwards a formerly profitable long request byte-exact and reports no savings evidence', async () => {
    const body = gptBody(60_000);
    const { event, out } = await driveAndCapture('/v1/chat/completions', body);
    expect(event.info?.compressed).toBe(false);
    expect(out).toBe(body);
    expect(event.info?.imageCount).toBe(0);
    expect(event.info?.imageTokens).toBeUndefined();
    expect(event.info?.baselineImagedTokens).toBeUndefined();
    expect(event.info?.gateEval).toBeUndefined();
    expect(event.info?.baselineProbeStatus).toBeUndefined();
    expect(event.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(event.info?.admissionRelativeSavings).toBeUndefined();
  });

  it('does not revive OpenAI rewriting at any former size threshold', async () => {
    for (const sysChars of [300, 2_000, 20_000]) {
      const body = gptBody(sysChars);
      const { event, out } = await driveAndCapture('/v1/chat/completions', body);
      expect(out).toBe(body);
      expect(event.info?.compressed).toBe(false);
      expect(event.info?.gateEval).toBeUndefined();
      expect(event.info?.imageTokens).toBeUndefined();
      expect(event.info?.baselineImagedTokens).toBeUndefined();
    }
  });
});

// ===========================================================================
describe('Anthropic safety shell — native fallback accounting', () => {
  it('keeps a safe candidate byte-exact when all four probes fail and reports no savings', async () => {
    const body = antBody({ slabChars: 80_000 });
    const { event, out, probeCalls } = await driveAndCapture('/v1/messages', body);

    expect(out).toBe(body);
    expect(probeCalls).toBe(4);
    expect(event.info?.compressed).toBe(false);
    expect(event.info?.reason).toBe('original_full_probe_failed');
    expect(event.info?.admissionReason).toBe('original_full_probe_failed');
    expect(event.info?.baselineProbeStatus).toBe('failed');
    expect(event.info?.baselineTokens).toBeUndefined();
    expect(event.info?.baselineCacheableTokens).toBeUndefined();
    expect(event.info?.candidateTokens).toBeUndefined();
    expect(event.info?.candidateCacheableTokens).toBeUndefined();
    expect(event.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(event.info?.admissionRelativeSavings).toBeUndefined();
    expect(event.info?.gateEval).toBeUndefined();
  });

  it('keeps an unchanged small request native without probes or savings', async () => {
    const body = antBody({});
    const { event, out, probeCalls } = await driveAndCapture('/v1/messages', body);

    expect(out).toBe(body);
    expect(probeCalls).toBe(0);
    expect(event.info?.compressed).toBe(false);
    expect(event.info?.baselineProbeStatus).toBeUndefined();
    expect(event.info?.baselineTokens).toBeUndefined();
    expect(event.info?.candidateTokens).toBeUndefined();
    expect(event.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(event.info?.admissionRelativeSavings).toBeUndefined();
  });
});
