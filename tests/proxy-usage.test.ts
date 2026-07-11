import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

// These proxy-contract tests deliberately exercise the opt-in Sol transform.
// Snapshot the developer shell so the suite is deterministic now that Sol is
// intentionally absent from the built-in default scope.
let ambientPxpipeModels: string | undefined;
beforeAll(() => {
  ambientPxpipeModels = process.env.PXPIPE_MODELS;
  process.env.PXPIPE_MODELS = 'claude-fable-5,gpt-5.6-sol,grok-4.5';
});
afterAll(() => {
  if (ambientPxpipeModels === undefined) delete process.env.PXPIPE_MODELS;
  else process.env.PXPIPE_MODELS = ambientPxpipeModels;
});

/** Tiny in-process mock upstream — accepts any request and returns whatever
 *  the test fixture configured. Lets us assert that the proxy correctly
 *  extracts Anthropic's usage block from both SSE and JSON responses without
 *  touching the network. */
function mockUpstream(handler: (req: Request) => Promise<Response> | Response) {
  // Patch globalThis.fetch for the duration of the test.
  const real = globalThis.fetch;
  globalThis.fetch = ((req: Request | string | URL, init?: RequestInit) => {
    const r = req instanceof Request ? req : new Request(String(req), init);
    return Promise.resolve(handler(r));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

async function sha8(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body) as BufferSource,
  );
  return Array.from(new Uint8Array(digest).subarray(0, 4))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const SAMPLE_REQ_BODY = JSON.stringify({
  model: 'claude-3-5-haiku-latest',
  messages: [{ role: 'user', content: 'hi' }],
  system: 'short',
});

describe('proxy usage extraction', () => {
  it('extracts usage tokens from a non-stream JSON response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
            usage: {
              input_tokens: 123,
              output_tokens: 7,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 100,
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client-side body so the tee is forced to finish.
    await res.text();
    // Give the onRequest callback a tick to fire (it's behind a void promise).
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(123);
    expect(captured!.usage?.output_tokens).toBe(7);
    expect(captured!.usage?.cache_read_input_tokens).toBe(100);
    expect(captured!.firstByteMs).toBeTypeOf('number');
  });

  it('admits only the exact in-place project candidate after all four count checks', async () => {
    const capturedRequest = makeCapturedRequest({
      projectGuidance:
        DIRECT_PROJECT_GUIDANCE + '\n' +
        'Role-bound project guidance row. '.repeat(100),
      email: 'owner@example.invalid',
      date: '2026-07-10',
    });
    capturedRequest.model = 'claude-fable-5';
    capturedRequest.max_tokens = 1;
    const reqBody = JSON.stringify(capturedRequest);
    const reqBytes = new TextEncoder().encode(reqBody);
    const transform = { charsPerToken: 1, minCompressChars: 1 };

    const safeCandidate = await buildAnthropicCandidate(reqBytes, transform);
    const candidateText = new TextDecoder().decode(safeCandidate.body);
    const candidateRequest = JSON.parse(candidateText) as typeof capturedRequest;
    expect(safeCandidate.info.compressed).toBe(true);
    expect(safeCandidate.replacements).toHaveLength(1);
    expect(candidateRequest.system).toEqual(capturedRequest.system);
    expect(candidateRequest.tools).toEqual(capturedRequest.tools);
    expect(candidateRequest.messages.map((message) => message.role)).toEqual(
      capturedRequest.messages.map((message) => message.role),
    );
    expect(candidateText).toContain('owner@example.invalid');
    expect(candidateText).toContain('2026-07-10');
    expect(candidateText).not.toContain('PXPIPE');

    const upstreamRequests: Request[] = [];
    let countTokenCalls = 0;
    const probeTokens = [20_000, 1_000, 1_000, 500];
    const restore = mockUpstream(async (req) => {
      if (req.url.endsWith('/count_tokens')) {
        const input_tokens = probeTokens[countTokenCalls++] ?? 0;
        return new Response(JSON.stringify({ input_tokens }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          usage: { input_tokens: 120, output_tokens: 7, cache_read_input_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      apiKey: 'sk-anthropic-test',
      transform,
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/anthropic/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-anthropic-test' },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    const main = upstreamRequests.find((r) => r.url === 'http://ocproxy.test/anthropic/messages');
    expect(main).toBeDefined();
    expect(new Uint8Array(await main!.arrayBuffer())).toEqual(safeCandidate.body);
    expect(countTokenCalls).toBe(4);
    expect(captured?.model).toBe('claude-fable-5');
    expect(captured?.info?.compressed).toBe(true);
    expect(captured?.info?.admissionReason).toBe('admitted');
    expect(captured?.info?.baselineProbeStatus).toBe('ok');
    expect(captured?.info?.baselineTokens).toBe(20_000);
    expect(captured?.info?.candidateTokens).toBe(1_000);
    expect(captured?.info?.admissionSignedSavingsTokens).toBeGreaterThan(256);
    expect(captured?.info?.admissionRelativeSavings).toBeGreaterThan(0.1);
  });

  it('routes GPT 5.6 Sol chat completions to OpenAI byte-exact and normalizes usage', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      openAIUpstream: 'https://api.openai.test',
      openAIApiKey: 'sk-test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => {
        captured = e;
      },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'System instruction. '.repeat(900) },
        { role: 'user', content: 'hi' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'Search files. '.repeat(100),
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      }],
    });

    const res = await proxy(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('https://api.openai.test/v1/chat/completions');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer sk-test');
    expect(await upstreamRequests[0]!.text()).toBe(reqBody);
    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(55);
    expect(captured!.usage?.output_tokens).toBe(7);
    expect(captured!.info?.compressed).toBe(false);
    expect(captured!.info?.imageCount).toBe(0);
    expect(captured!.info?.imageTokens).toBeUndefined();
    expect(captured!.info?.baselineImagedTokens).toBeUndefined();
    expect(captured!.info?.baselineProbeStatus).toBeUndefined();
    expect(captured!.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(captured!.reqBodySha8).toBe(await sha8(reqBody));
  });

  it('keeps provider-prefixed OpenAI chat byte-exact through the generic upstream', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'chatcmpl_1',
          object: 'chat.completion',
          choices: [{ message: { role: 'assistant', content: 'hello' } }],
          usage: { prompt_tokens: 55, completion_tokens: 7, total_tokens: 62 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      openAIUpstream: 'https://api.openai.test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      messages: [
        { role: 'system', content: 'System instruction. '.repeat(900) },
        { role: 'user', content: 'hi' },
      ],
    });

    const res = await proxy(
      new Request('http://localhost/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
        body: reqBody,
      }),
    );
    await res.text();
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('http://ocproxy.test/openai/v1/chat/completions');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer local-token');
    expect(await upstreamRequests[0]!.text()).toBe(reqBody);
  });

  it('keeps OpenCode /openai/responses requests byte-exact and records the model', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'resp_1',
          object: 'response',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 55, output_tokens: 7, total_tokens: 62 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://ocproxy.test',
      openAIUpstream: 'https://api.openai.test',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => {
        captured = e;
      },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'System instruction. '.repeat(900),
      input: [{ role: 'user', content: 'hi' }],
    });

    const res = await proxy(
      new Request('http://localhost/openai/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer local-token' },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe('http://ocproxy.test/openai/responses');
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer local-token');
    expect(await upstreamRequests[0]!.text()).toBe(reqBody);
    expect(captured?.model).toBe('gpt-5.6-sol');
    expect(captured?.info?.compressed).toBe(false);
    expect(captured?.info?.imageCount).toBe(0);
    expect(captured?.info?.imageTokens).toBeUndefined();
    expect(captured?.info?.baselineImagedTokens).toBeUndefined();
    expect(captured?.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(captured?.reqBodySha8).toBe(await sha8(reqBody));
  });

  it('keeps subscription-authenticated Sol /responses byte-exact and routes it to OpenAI', async () => {
    const upstreamRequests: Request[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamRequests.push(req.clone());
      return new Response(
        JSON.stringify({
          id: 'resp_subscription',
          object: 'response',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 55, output_tokens: 7, total_tokens: 62 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://anthropic.test',
      openAIUpstream: 'http://chatgpt.test/backend-api/codex',
      transform: { charsPerToken: 1, minCompressChars: 1 },
      onRequest: (e) => {
        captured = e;
      },
    });

    const reqBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'System instruction. '.repeat(900),
      input: [{ role: 'user', content: 'hi' }],
    });

    const res = await proxy(
      new Request('http://localhost/responses?trace=subscription', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fake-subscription-token',
          'chatgpt-account-id': 'acct_fake',
        },
        body: reqBody,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]!.url).toBe(
      'http://chatgpt.test/backend-api/codex/responses?trace=subscription',
    );
    expect(upstreamRequests[0]!.headers.get('authorization')).toBe('Bearer fake-subscription-token');
    expect(upstreamRequests[0]!.headers.get('chatgpt-account-id')).toBe('acct_fake');
    expect(await upstreamRequests[0]!.text()).toBe(reqBody);
    expect(captured?.model).toBe('gpt-5.6-sol');
    expect(captured?.info?.compressed).toBe(false);
    expect(captured?.info?.imageCount).toBe(0);
    expect(captured?.info?.imageTokens).toBeUndefined();
    expect(captured?.info?.baselineImagedTokens).toBeUndefined();
    expect(captured?.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(captured?.reqBodySha8).toBe(await sha8(reqBody));
  });

  it('isolates sequential Sol and Grok Responses bodies, models, and hashes', async () => {
    const upstreamBodies: string[] = [];
    const restore = mockUpstream(async (req) => {
      upstreamBodies.push(await req.clone().text());
      return new Response(
        JSON.stringify({
          id: 'resp_isolation',
          object: 'response',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const events: ProxyEvent[] = [];
    const proxy = createProxy({
      openAIUpstream: 'http://subscription.test',
      transform: {
        compress: true,
        compressTools: true,
        collapseHistory: true,
        charsPerToken: 1,
        minCompressChars: 1,
      },
      onRequest: (event) => {
        events.push(event);
      },
    });
    const solBody = JSON.stringify({
      model: 'gpt-5.6-sol',
      instructions: 'SOL_ONLY_SYSTEM_' + 's'.repeat(20_000),
      input: [{ role: 'user', content: 'SOL_ONLY_REQUEST' }],
    });
    const grokBody = JSON.stringify({
      model: 'grok-4.5',
      instructions: 'GROK_ONLY_SYSTEM_' + 'g'.repeat(20_000),
      input: [{ role: 'user', content: 'GROK_ONLY_REQUEST' }],
    });

    for (const body of [solBody, grokBody]) {
      const res = await proxy(new Request('http://localhost/v1/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer fake-subscription-token',
        },
        body,
      }));
      await res.text();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    restore();

    expect(upstreamBodies).toEqual([solBody, grokBody]);
    expect(upstreamBodies[1]).not.toContain('SOL_ONLY');
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.model)).toEqual(['gpt-5.6-sol', 'grok-4.5']);
    expect(events.map((event) => event.info?.compressed)).toEqual([false, false]);
    expect(events.map((event) => event.reqBodySha8)).toEqual([
      await sha8(solBody),
      await sha8(grokBody),
    ]);
  });

  it('extracts usage tokens from an SSE stream (message_start event)', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: ' +
      JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [],
          usage: {
            input_tokens: 42,
            output_tokens: 0,
            cache_creation_input_tokens: 5000,
            cache_read_input_tokens: 0,
          },
        },
      }) +
      '\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.usage?.input_tokens).toBe(42);
    expect(captured!.usage?.cache_creation_input_tokens).toBe(5000);
  });

  it('fires the event with undefined usage when the response is an error', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'overloaded_error' } }), {
          status: 529,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(529);
    expect(captured!.usage).toBeUndefined();
    // 5xx: we synthesize our own message upstream, so no errorBody capture.
    expect(captured!.errorBody).toBeUndefined();
  });

  it('captures upstream error body for 4xx responses (up to 2 KiB)', async () => {
    const upstreamErr = {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.5.content.0.tool_use_id: unknown tool_use id',
      },
    };
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify(upstreamErr), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    // Drain the client side so the tee can complete.
    const clientBody = await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(400);
    expect(captured!.usage).toBeUndefined();
    expect(captured!.errorBody).toBe(JSON.stringify(upstreamErr));
    // Client must still receive the full body unchanged.
    expect(clientBody).toBe(JSON.stringify(upstreamErr));
  });

  it('caps the captured 4xx error body at ~2 KiB', async () => {
    const huge = 'x'.repeat(10_000);
    const restore = mockUpstream(
      () =>
        new Response(huge, {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.errorBody).toBeDefined();
    expect(captured!.errorBody!.length).toBe(2048);
  });

  /** Decompress a gzip Uint8Array back to bytes — mirror of proxy's gzipBytes. */
  async function gunzipBytes(buf: Uint8Array): Promise<Uint8Array> {
    const stream = new Response(buf as BufferSource).body!.pipeThrough(
      new DecompressionStream('gzip'),
    );
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  it('captures the FULL gzipped transformed body on 4xx + sets reqBodySha8', async () => {
    // Pair with errorBody so a future debugger can reconstruct
    // "we sent X, Anthropic said Y" from the JSONL alone. We gzip the body
    // so even a 170 KiB transformed payload fits inline once base64'd
    // (typical PNG-heavy bodies compress to <10% of source).
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({ error: { type: 'bad' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(400);

    // Hash lands on every event, not just 4xx.
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/);

    // Gzipped body is present, has the gzip magic header, and decompresses
    // back to the transformed JSON we sent upstream.
    expect(captured!.reqBodyGz).toBeDefined();
    expect(captured!.reqBodyGz![0]).toBe(0x1f);
    expect(captured!.reqBodyGz![1]).toBe(0x8b);

    const decoded = new TextDecoder().decode(
      await gunzipBytes(captured!.reqBodyGz!),
    );
    const parsed = JSON.parse(decoded);
    expect(parsed.model).toBe('claude-3-5-haiku-latest');
    expect(parsed.messages[0].role).toBe('user');
  });

  it('does NOT gzip the request body on 2xx (but still sets reqBodySha8)', async () => {
    const restore = mockUpstream(
      () =>
        new Response(JSON.stringify({
          id: 'x', type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'x', stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captured = e;
      },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(200);
    // Hash lands on every event.
    expect(captured!.reqBodySha8).toMatch(/^[0-9a-f]{8}$/);
    // But the gzipped body itself is only captured on 4xx.
    expect(captured!.reqBodyGz).toBeUndefined();
  });

  it('reqBodySha8 is identical across two requests with the same body', async () => {
    // Correlation use-case: spot "same payload sometimes works, sometimes
    // fails" patterns in events.jsonl.
    let restore = mockUpstream(
      () =>
        new Response('{"x":1}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const captures: ProxyEvent[] = [];
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => {
        captures.push(e);
      },
    });

    for (let i = 0; i < 2; i++) {
      const res = await proxy(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: SAMPLE_REQ_BODY,
        }),
      );
      await res.text();
    }
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captures.length).toBe(2);
    expect(captures[0]!.reqBodySha8).toBeDefined();
    expect(captures[0]!.reqBodySha8).toBe(captures[1]!.reqBodySha8);
  });

  it('keeps a caller-cached native request byte-exact without probes or savings evidence', async () => {
    const bodyWithMarkers = JSON.stringify({
      model: 'claude-fable-5',
      max_tokens: 16,
      system: [
        {
          type: 'text',
          text: 'native caller-owned cache boundary',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    });
    const mainBodies: string[] = [];
    let probeCalls = 0;
    const restore = mockUpstream(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === '/v1/messages/count_tokens') {
        probeCalls += 1;
        throw new Error('native requests must not call count_tokens');
      }
      mainBodies.push(await req.clone().text());
      return new Response(
        JSON.stringify({
          id: 'msg_x',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-fable-5',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      upstream: 'http://mock',
      transform: {},
      onRequest: (event) => { captured = event; },
    });
    const res = await proxy(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodyWithMarkers,
      }),
    );
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
    restore();

    expect(probeCalls).toBe(0);
    expect(mainBodies).toEqual([bodyWithMarkers]);
    expect(captured?.info?.compressed).toBe(false);
    expect(captured?.info?.baselineProbeStatus).toBeUndefined();
    expect(captured?.info?.baselineTokens).toBeUndefined();
    expect(captured?.info?.baselineCacheableTokens).toBeUndefined();
    expect(captured?.info?.candidateTokens).toBeUndefined();
    expect(captured?.info?.candidateCacheableTokens).toBeUndefined();
    expect(captured?.info?.admissionSignedSavingsTokens).toBeUndefined();
    expect(captured?.info?.admissionRelativeSavings).toBeUndefined();
  });

  // ---- Ground-truth output measurement (Task #22) ----------------------
  //
  // The proxy scans the response stream for `text_delta` / `thinking_delta`
  // chars and `redacted_thinking` block counts. These numbers are
  // INDEPENDENT of Anthropic's `usage.output_tokens` — they're a raw ruler
  // against the redacted_thinking-inflated bill we surfaced in the May-2026
  // weekly-meter audit. The dashboard layer turns them into low/mid/high
  // bands; the proxy layer just has to count honestly.

  it('measures SSE text_delta chars across multiple delta events', async () => {
    // Three text_delta events spanning a couple of code points each — the
    // ruler must use STRING length (UTF-16 code units), matching what
    // `JSON.stringify(text).length` would count if we re-serialized.
    const sseBody =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_m1', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 10, output_tokens: 1 },
        },
      })}\n\n` +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":42}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // 'hello ' (6) + 'world' (5) + '!' (1) = 12 chars.
    expect(captured!.measurement?.textChars).toBe(12);
    expect(captured!.measurement?.thinkingChars).toBe(0);
    expect(captured!.measurement?.toolUseChars).toBe(0);
    expect(captured!.measurement?.redactedBlockCount).toBe(0);
    // Final output_tokens from message_delta overrides message_start's 1.
    expect(captured!.usage?.output_tokens).toBe(42);
  });

  it('measures SSE thinking_delta chars and counts redacted_thinking blocks', async () => {
    // Extended thinking turn: a `thinking` block and a `redacted_thinking`
    // block. The redacted block has no readable chars (server-encrypted
    // bytes), so we just count the block — the dashboard surfaces it as
    // an opaque low/mid/high estimate.
    const sseBody =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_m2', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      })}\n\n` +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1: "}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason carefully"}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"redacted_thinking","data":"alsoopaque"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":500}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // 'step 1: ' (8) + 'reason carefully' (16) = 24 chars.
    expect(captured!.measurement?.thinkingChars).toBe(24);
    expect(captured!.measurement?.textChars).toBe(0);
    expect(captured!.measurement?.redactedBlockCount).toBe(2);
    expect(captured!.usage?.output_tokens).toBe(500);
  });

  it('measures SSE tool_use chars via input_json_delta', async () => {
    // tool_use blocks stream their `input` field as a JSON string assembled
    // from `input_json_delta` events. We count the raw JSON-string length —
    // that's the closest apples-to-apples we get against the billed body.
    const sseBody =
      'event: message_start\n' +
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_m3', type: 'message', role: 'assistant', content: [],
          usage: { input_tokens: 50, output_tokens: 1 },
        },
      })}\n\n` +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"bash","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{},"usage":{"output_tokens":20}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // '{"cmd":' (7) + '"ls"}' (5) = 12 chars.
    expect(captured!.measurement?.toolUseChars).toBe(12);
    expect(captured!.measurement?.textChars).toBe(0);
    expect(captured!.measurement?.thinkingChars).toBe(0);
  });

  it('measures non-stream JSON response by walking content[]', async () => {
    // Non-stream path: the whole body is one JSON object. Counter walks
    // content[] and adds up text/thinking chars, tool_use input chars, and
    // redacted_thinking blocks. Same shape as the SSE accumulator — the
    // ruler must report the SAME numbers regardless of transport.
    const responseBody = JSON.stringify({
      id: 'msg_n1',
      type: 'message',
      role: 'assistant',
      content: [
        { type: 'text', text: 'one two three' },
        { type: 'thinking', thinking: 'reasoning here' },
        { type: 'redacted_thinking', data: 'opaque1' },
        { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
        { type: 'text', text: '!!' },
      ],
      model: 'claude-opus-4-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 99 },
    });

    const restore = mockUpstream(
      () =>
        new Response(responseBody, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    // 'one two three' (13) + '!!' (2) = 15 chars text.
    expect(captured!.measurement?.textChars).toBe(15);
    // 'reasoning here' = 14.
    expect(captured!.measurement?.thinkingChars).toBe(14);
    // tool_use input JSON.stringify({cmd:'ls'}) = '{"cmd":"ls"}' = 12 chars.
    expect(captured!.measurement?.toolUseChars).toBe(12);
    expect(captured!.measurement?.redactedBlockCount).toBe(1);
  });

  it('leaves measurement undefined on 5xx (no body to scan)', async () => {
    // Upstream 5xx bails on usage AND measurement — the host synthesizes
    // an error message and the body is whatever Anthropic returned, which
    // by convention we don't try to parse. The dashboard event will just
    // skip the row from output-honesty math.
    const restore = mockUpstream(
      () =>
        new Response('upstream broke', {
          status: 503,
          headers: { 'content-type': 'text/plain' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.status).toBe(503);
    expect(captured!.measurement).toBeUndefined();
  });

  it('handles message_start with no usage gracefully (still measures content)', async () => {
    // Defensive: if a future Anthropic release ships a message_start
    // without `usage`, the proxy should still scan deltas and report
    // measurement. Only the usage rollup degrades.
    const sseBody =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[]}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi there"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.measurement?.textChars).toBe(8);
  });

  it('extracts stop_reason from the SSE message_delta event', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":9}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.stopReason).toBe('end_turn');
    // message_delta output_tokens must win over message_start's placeholder 1.
    expect(captured!.usage?.output_tokens).toBe(9);
  });

  it('extracts stop_reason "refusal" from a non-stream JSON response', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'msg_r',
            type: 'message',
            role: 'assistant',
            content: [],
            stop_reason: 'refusal',
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.stopReason).toBe('refusal');
  });

  it('extracts OpenAI choices[].finish_reason from a JSON body', async () => {
    const restore = mockUpstream(
      () =>
        new Response(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '' },
                finish_reason: 'content_filter',
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 3 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.stopReason).toBe('content_filter');
  });

  it('leaves stopReason undefined when the stream never ships one', async () => {
    const sseBody =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":1}}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const restore = mockUpstream(
      () =>
        new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    let captured: ProxyEvent | undefined;
    const proxy = createProxy({
      transform: {},
      onRequest: (e) => { captured = e; },
    });

    const res = await proxy(
      new Request('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_REQ_BODY,
      }),
    );
    await res.text();
    await new Promise((r) => setTimeout(r, 20));
    restore();

    expect(captured).toBeDefined();
    expect(captured!.stopReason).toBeUndefined();
  });
});
