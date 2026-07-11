/**
 * Candidate determinism and real-proxy admission checks. Anthropic may replace
 * only exact source spans in their original containers; OpenAI requests remain
 * byte-exact until a same-container image representation exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareNoHijack } from '../src/core/no-hijack.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import {
  buildAnthropicCandidate,
  type AnthropicCandidateResult,
  type TransformInfo,
} from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

interface Captured {
  url: string;
  path: string;
  body: string;
  authorization: string | null;
  apiKey: string | null;
}

interface FakeUpstreamOptions {
  /** Return a failed response for every Anthropic count_tokens probe. */
  failAnthropicProbes?: boolean;
  /** Return measurements that make a safe exact-span candidate a strict win. */
  admitAnthropic?: boolean;
}

function imageCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const req = value as { messages?: unknown };
  if (!Array.isArray(req.messages)) return 0;
  let count = 0;
  for (const message of req.messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if ((block as { type?: unknown }).type === 'image') count++;
      const nested = (block as { content?: unknown }).content;
      if (Array.isArray(nested)) {
        count += nested.filter(
          (part) => part && typeof part === 'object'
            && (part as { type?: unknown }).type === 'image',
        ).length;
      }
    }
  }
  return count;
}

function fakeUpstream(options: FakeUpstreamOptions = {}) {
  const main: Captured[] = [];
  const sidePaths: string[] = [];
  const probeBodies: string[] = [];
  const real = globalThis.fetch;

  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const path = url.pathname;

    if (path.endsWith('/count_tokens')) {
      sidePaths.push(path);
      const body = await req.clone().text();
      probeBodies.push(body);
      if (options.failAnthropicProbes) {
        return new Response(JSON.stringify({ error: 'synthetic probe failure' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      let inputTokens = 9999;
      if (options.admitAnthropic) {
        const parsed = JSON.parse(body) as { messages?: unknown[] };
        const candidate = imageCount(parsed) > 0;
        const prefix = Array.isArray(parsed.messages) && parsed.messages.length === 1;
        inputTokens = candidate
          ? prefix ? 200 : 500
          : prefix ? 7000 : 8000;
      }
      return new Response(JSON.stringify({ input_tokens: inputTokens }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    main.push({
      url: req.url,
      path,
      body: await req.clone().text(),
      authorization: req.headers.get('authorization'),
      apiKey: req.headers.get('x-api-key'),
    });

    if (path.includes('chat/completions')) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (path.includes('responses')) {
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-fable-5',
        stop_reason: 'end_turn',
        usage: { input_tokens: 500, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  return {
    main,
    sidePaths,
    probeBodies,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const FORCE = { charsPerToken: 1, minCompressChars: 1 } as const;
const slab = (n: number) => '# CLAUDE.md\nYou are helpful.\n' + 'rule. '.repeat(Math.ceil(n / 6));
const filler = (n: number) => 'x'.repeat(n);

function turns(n: number, chars: number): { role: 'user' | 'assistant'; text: string }[] {
  return Array.from({ length: n }, (_, index) => ({
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    text: `turn-${index}: ${filler(chars)}`,
  }));
}

function largeProjectGuidance(marker = 'stable'): string {
  const rows = Array.from(
    { length: 2400 },
    (_, index) => `${marker} governance row ${index}: preserve role and priority.`,
  ).join('\n');
  return `${DIRECT_PROJECT_GUIDANCE}\n\n${rows}`;
}

function anthropicProjectBody(opts: {
  model?: string;
  projectGuidance?: string;
  liveText?: string;
  email?: string;
  date?: string;
} = {}): string {
  const req = makeCapturedRequest({
    projectGuidance: opts.projectGuidance ?? largeProjectGuidance(),
    email: opts.email ?? 'owner@example.invalid',
    date: opts.date ?? '2026-07-10',
  });
  req.model = opts.model ?? 'claude-fable-5';
  req.max_tokens = 16;
  if (opts.liveText !== undefined) {
    const content = req.messages[0]!.content as ContentBlock[];
    content[1] = {
      type: 'text',
      text: opts.liveText,
      cache_control: { type: 'ephemeral' },
    };
  }
  return JSON.stringify(req);
}

function anthropicImages(bodyText: string): { data: string; marked: boolean }[] {
  const body = JSON.parse(bodyText) as MessagesRequest;
  const images: { data: string; marked: boolean }[] = [];
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'image') continue;
      images.push({
        data: block.source.data,
        marked: block.cache_control !== undefined,
      });
    }
  }
  return images;
}

async function buildCandidate(body: string): Promise<AnthropicCandidateResult> {
  return buildAnthropicCandidate(enc.encode(body), FORCE);
}

async function driveAnthropic(
  body: string,
  cap = fakeUpstream(),
): Promise<{ cap: ReturnType<typeof fakeUpstream>; info: TransformInfo }> {
  let event: ProxyEvent | undefined;
  const proxy = createProxy({
    upstream: 'http://anthropic.test',
    apiKey: 'sk-ant-test',
    transform: FORCE,
    onRequest: (next) => {
      event = next;
    },
  });
  const res = await proxy(new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
    body,
  }));
  await res.text();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(event?.info).toBeDefined();
  return { cap, info: event!.info! };
}

describe('Anthropic exact-span cache and admission contract', () => {
  it('conserves every caller cache marker and passes the no-hijack contract', async () => {
    const input = anthropicProjectBody();
    const original = JSON.parse(input) as MessagesRequest;
    const candidate = await buildCandidate(input);
    const out = JSON.parse(dec.decode(candidate.body)) as MessagesRequest;

    expect(candidate.info.compressed).toBe(true);
    expect(candidate.replacements.length).toBeGreaterThan(0);
    expect(countCacheControlMarkers(candidate.body)).toBe(
      countCacheControlMarkers(enc.encode(input)),
    );
    expect(compareNoHijack('anthropic', original, out, candidate.replacements).ok).toBe(true);
    expect(out.system).toEqual(original.system);
    expect(out.messages.slice(1)).toEqual(original.messages.slice(1));
    expect(JSON.stringify(out)).not.toContain('pxpipe_project_guidance_manifest');
    expect(JSON.stringify(out)).not.toContain('PXPIPE RUNTIME CONTEXT');
  });

  it('renders identical project pages while volatile caller suffixes remain exact native text', async () => {
    const project = largeProjectGuidance('same-project');
    const aBody = anthropicProjectBody({
      projectGuidance: project,
      email: 'a@example.invalid',
      date: '2026-07-10',
      liveText: 'first live request',
    });
    const bBody = anthropicProjectBody({
      projectGuidance: project,
      email: 'b@example.invalid',
      date: '2026-07-11',
      liveText: 'second live request',
    });
    const [a, b] = await Promise.all([buildCandidate(aBody), buildCandidate(bBody)]);
    const aText = dec.decode(a.body);
    const bText = dec.decode(b.body);

    expect(anthropicImages(aText)).toEqual(anthropicImages(bText));
    expect(aText).toContain('a@example.invalid');
    expect(aText).toContain("Today's date is 2026-07-10.");
    expect(aText).toContain('first live request');
    expect(bText).toContain('b@example.invalid');
    expect(bText).toContain("Today's date is 2026-07-11.");
    expect(bText).toContain('second live request');
    expect(aText).not.toContain('PXPIPE RUNTIME CONTEXT');
    expect(bText).not.toContain('PXPIPE RUNTIME CONTEXT');
  });

  it('admits one complete safe candidate only after all four cache-aware probes win', async () => {
    const input = anthropicProjectBody();
    const expected = await buildCandidate(input);
    const cap = fakeUpstream({ admitAnthropic: true });
    const driven = await driveAnthropic(input, cap);
    cap.restore();

    expect(cap.sidePaths).toHaveLength(4);
    expect(cap.probeBodies).toHaveLength(4);
    expect(cap.main).toHaveLength(1);
    expect(JSON.parse(cap.main[0]!.body)).toEqual(JSON.parse(dec.decode(expected.body)));
    expect(anthropicImages(cap.main[0]!.body).length).toBeGreaterThan(0);
    expect(countCacheControlMarkers(enc.encode(cap.main[0]!.body))).toBe(
      countCacheControlMarkers(enc.encode(input)),
    );
    expect(cap.main[0]!.url).toBe('http://anthropic.test/v1/messages');
    expect(cap.main[0]!.apiKey).toBe('sk-ant-test');
    expect(driven.info.compressed).toBe(true);
    expect(driven.info.admissionReason).toBe('admitted');
    expect(driven.info.baselineProbeStatus).toBe('ok');
    expect(driven.info.cachePrefixSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(driven.info.cachePrefixBytes).toBeGreaterThan(0);
  });

  it('fails the whole candidate to the exact caller bytes when measurements fail', async () => {
    const input = anthropicProjectBody();
    const cap = fakeUpstream({ failAnthropicProbes: true });
    const driven = await driveAnthropic(input, cap);
    cap.restore();

    expect(cap.sidePaths).toHaveLength(4);
    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.body).toBe(input);
    expect(anthropicImages(cap.main[0]!.body)).toEqual([]);
    expect(driven.info.compressed).toBe(false);
    expect(driven.info.reason).toBe('original_full_probe_failed');
    expect(driven.info.admissionReason).toBe('original_full_probe_failed');
  });

  it('forwards an unsupported Anthropic model byte-for-byte without probes', async () => {
    const input = anthropicProjectBody({ model: 'claude-sonnet-4-6' });
    const cap = fakeUpstream({ admitAnthropic: true });
    const driven = await driveAnthropic(input, cap);
    cap.restore();

    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.body).toBe(input);
    expect(cap.sidePaths).toEqual([]);
    expect(driven.info.compressed).toBe(false);
    expect(driven.info.reason).toBe('unsupported_model');
  });

  it('emits a valid PNG on every exact project page', async () => {
    const candidate = await buildCandidate(anthropicProjectBody());
    const images = anthropicImages(dec.decode(candidate.body));
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) =>
      image.data.length > 100 && image.data.startsWith('iVBORw0KGgo'))).toBe(true);
  });
});

describe('e2e exact OpenAI pass-through through the real proxy', () => {
  function gptChatBody(opts: {
    model?: string;
    systemChars: number;
    turns: { role: 'user' | 'assistant'; text: string }[];
  }): string {
    return JSON.stringify({
      model: opts.model ?? 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: slab(opts.systemChars) },
        ...opts.turns.map((turn) => ({ role: turn.role, content: turn.text })),
      ],
    });
  }

  function gptResponsesBody(opts: {
    systemChars: number;
    turns: { role: 'user' | 'assistant'; text: string }[];
  }): string {
    return JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: slab(opts.systemChars),
      input: opts.turns.map((turn) => ({ role: turn.role, content: turn.text })),
    });
  }

  async function driveGpt(path: string, body: string, cap = fakeUpstream()) {
    const proxy = createProxy({
      openAIUpstream: 'https://openai.test',
      openAIApiKey: 'sk-openai-test',
      transform: FORCE,
      onRequest: () => {},
    });
    const res = await proxy(new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    }));
    await res.text();
    return cap;
  }

  it('chat keeps the complete caller body byte-exact with no cache markers or images', async () => {
    const body = gptChatBody({ systemChars: 60_000, turns: turns(4, 20) });
    const cap = await driveGpt(
      '/v1/chat/completions',
      body,
    );
    cap.restore();
    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.body).toBe(body);
    expect(countCacheControlMarkers(enc.encode(cap.main[0]!.body))).toBe(0);
    expect(cap.main[0]!.body).not.toContain('image_url');
  });

  it('chat keeps both the original and grown conversation byte-exact', async () => {
    const small = turns(30, 4000);
    const smallBody = gptChatBody({ systemChars: 60_000, turns: small });
    const grownBody = gptChatBody({
      systemChars: 60_000,
      turns: [...small, ...turns(20, 4000)],
    });
    const cap1 = await driveGpt(
      '/v1/chat/completions',
      smallBody,
    );
    cap1.restore();
    const cap2 = await driveGpt(
      '/v1/chat/completions',
      grownBody,
    );
    cap2.restore();

    expect(cap1.main[0]!.body).toBe(smallBody);
    expect(cap2.main[0]!.body).toBe(grownBody);
  });

  it('Responses keeps both the original and grown conversation byte-exact', async () => {
    const small = turns(30, 4000);
    const smallBody = gptResponsesBody({ systemChars: 60_000, turns: small });
    const grownBody = gptResponsesBody({
      systemChars: 60_000,
      turns: [...small, ...turns(20, 4000)],
    });
    const cap1 = await driveGpt(
      '/v1/responses',
      smallBody,
    );
    cap1.restore();
    const cap2 = await driveGpt(
      '/v1/responses',
      grownBody,
    );
    cap2.restore();

    expect(cap1.main[0]!.body).toBe(smallBody);
    expect(cap2.main[0]!.body).toBe(grownBody);
  });

  it('GATE: an out-of-scope GPT model is forwarded byte-for-byte untouched', async () => {
    const body = gptChatBody({ model: 'gpt-4o', systemChars: 60_000, turns: turns(4, 20) });
    const cap = await driveGpt('/v1/chat/completions', body);
    cap.restore();
    expect(cap.main[0]!.body).toBe(body);
  });

  it('ROUTING + AUTH forwards to the configured OpenAI upstream', async () => {
    const cap = await driveGpt(
      '/v1/chat/completions',
      gptChatBody({ systemChars: 60_000, turns: turns(4, 20) }),
    );
    cap.restore();
    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.url).toBe('https://openai.test/v1/chat/completions');
    expect(cap.main[0]!.authorization).toBe('Bearer sk-openai-test');
  });
});
