/**
 * END-TO-END savings-MATH contract through the REAL proxy.
 *
 * The GPT cases retain the image-vs-text gate checks. Anthropic candidates now
 * have a stricter shell: requests that fail the no-hijack contract stay native,
 * are not probed, and must not report hypothetical savings.
 *
 *   fake api  = the upstream output plus a count_tokens tripwire
 *   our input = pxpipe's decision, read off the forwarded bytes and event
 *
 * CRITICAL: these run with REALISTIC gate settings (transform: {} → defaults).
 * The cache tests used charsPerToken:1 to FORCE imaging — that would rig this
 * gate (text looks infinitely expensive → always images), so it is NOT used here.
 *
 * The GPT side is cross-checked against a REAL o200k tokenizer (the gpt-tokenizer
 * dep), so "the text would have cost N tokens" is ground truth, not self-report.
 *
 * Run just this file:  pnpm vitest run tests/savings-math-e2e.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { countTokens as o200k } from 'gpt-tokenizer/encoding/o200k_base';
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
describe('savings math — GPT, cross-checked against the real o200k tokenizer', () => {
  it('NO NET LOSS: when it images, the images cost fewer tokens than the text they replaced', async () => {
    const { event } = await driveAndCapture('/v1/chat/completions', gptBody(60_000));
    expect(event.info?.compressed).toBe(true);
    const imageTokens = event.info!.imageTokens!;
    const baseline = event.info!.baselineImagedTokens!;
    expect(imageTokens).toBeGreaterThan(0);
    expect(baseline).toBeGreaterThan(0);
    // THE money guarantee: vision tokens added < text tokens removed.
    expect(imageTokens).toBeLessThan(baseline);
  });

  it('GROUND TRUTH: baselineImagedTokens is a real o200k token count, not a char count', async () => {
    // A chars-vs-tokens regression would inflate this ~4-5x; assert it tracks the
    // real tokenizer within a tight tolerance (matched exactly in practice).
    const sys = slab(60_000);
    const realTok = o200k(sys);
    const { event } = await driveAndCapture('/v1/chat/completions', gptBody(60_000));
    const baseline = event.info!.baselineImagedTokens!;
    expect(Math.abs(baseline - realTok)).toBeLessThanOrEqual(Math.max(5, realTok * 0.02));
  });

  it('GATE SIGN: profitable iff the gate believes images < text', async () => {
    for (const sysChars of [2_000, 20_000, 60_000]) {
      const { event } = await driveAndCapture('/v1/chat/completions', gptBody(sysChars));
      const g = event.info?.gateEval;
      if (!g) continue; // below the char floor → gate never ran
      expect(g.profitable).toBe(g.imageTokens < g.textTokens);
    }
  });

  it('DECLINES A LOSER: refuses to image content where imaging would cost more than the real text', async () => {
    // 2000-char slab: ~374 real tokens, but it would render to a ~1400-token image.
    const sys = slab(2_000);
    const realTok = o200k(sys);
    const { event, out } = await driveAndCapture('/v1/chat/completions', gptBody(2_000));
    expect(event.info?.compressed).toBe(false);
    expect(event.info?.gateEval?.profitable).toBe(false);
    // The would-be image cost genuinely exceeds the real text cost → declining is correct.
    expect(event.info!.gateEval!.imageTokens).toBeGreaterThan(realTok);
    // And nothing was imaged: the forwarded body has no image parts.
    expect(out).not.toContain('image_url');
  });

  it('BELOW THRESHOLD: a tiny system is forwarded byte-for-byte (no gate, no image)', async () => {
    const body = gptBody(300);
    const { event, out } = await driveAndCapture('/v1/chat/completions', body);
    expect(event.info?.compressed).toBe(false);
    expect(JSON.parse(out)).toEqual(JSON.parse(body));
  });
});

// ===========================================================================
describe('Anthropic safety shell — native fallback accounting', () => {
  it('rejects an unsafe candidate byte-exact before probes and reports no savings', async () => {
    const body = antBody({ slabChars: 80_000 });
    const { event, out, probeCalls } = await driveAndCapture('/v1/messages', body);

    expect(out).toBe(body);
    expect(probeCalls).toBe(0);
    expect(event.info?.compressed).toBe(false);
    expect(event.info?.reason).toBe('candidate_contract_invalid');
    expect(event.info?.admissionReason).toBe('candidate_contract_invalid');
    expect(event.info?.baselineProbeStatus).toBeUndefined();
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
