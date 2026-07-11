import { afterEach, describe, expect, it } from 'vitest';
import { createProxy, type ProxyEvent } from '../src/core/proxy.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

interface CapturedRequest {
  readonly url: string;
  readonly body: Uint8Array;
}

async function sha8(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body as BufferSource);
  return Array.from(new Uint8Array(digest).subarray(0, 4))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function anthropicResponse(): Response {
  return new Response(JSON.stringify({
    id: 'msg_request_isolation',
    type: 'message',
    role: 'assistant',
    content: [],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { headers: { 'content-type': 'application/json' } });
}

function openAIResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl_request_isolation',
    object: 'chat.completion',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: 'ok' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { headers: { 'content-type': 'application/json' } });
}

describe('request-local proxy state', () => {
  it('keeps sequential Sonnet, Fable, Sol, and Grok bodies, models, and hashes isolated', async () => {
    const bodies = [
      JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16,
        system: [
          { type: 'text', text: 'SONNET_SYSTEM_FIRST' },
          { type: 'text', text: 'SONNET_SYSTEM_SECOND' },
        ],
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'SONNET_REQUEST_FIRST' },
            { type: 'text', text: 'SONNET_REQUEST_SECOND' },
          ],
        }],
      }),
      JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 16,
        system: [
          { type: 'text', text: 'FABLE_SYSTEM_FIRST' },
          { type: 'text', text: 'FABLE_SYSTEM_SECOND' },
        ],
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'FABLE_REQUEST_FIRST' },
            { type: 'text', text: 'FABLE_REQUEST_SECOND' },
          ],
        }],
      }),
      JSON.stringify({
        model: 'gpt-5.6-sol',
        messages: [
          { role: 'system', content: 'SOL_SYSTEM_FIRST' },
          { role: 'system', content: 'SOL_SYSTEM_SECOND' },
          { role: 'user', content: 'SOL_REQUEST_FIRST' },
          { role: 'user', content: 'SOL_REQUEST_SECOND' },
        ],
      }),
      JSON.stringify({
        model: 'grok-4.5',
        messages: [
          { role: 'system', content: 'GROK_SYSTEM_FIRST' },
          { role: 'system', content: 'GROK_SYSTEM_SECOND' },
          { role: 'user', content: 'GROK_REQUEST_FIRST' },
          { role: 'user', content: 'GROK_REQUEST_SECOND' },
        ],
      }),
    ];
    const expectedBytes = bodies.map((body) => encoder.encode(body));
    const paths = [
      '/v1/messages',
      '/v1/messages',
      '/v1/chat/completions',
      '/v1/chat/completions',
    ];
    const expectedModels = [
      'claude-sonnet-4-6',
      'claude-fable-5',
      'gpt-5.6-sol',
      'grok-4.5',
    ];
    const requestMarkers = ['SONNET_', 'FABLE_', 'SOL_', 'GROK_'];
    const captures: CapturedRequest[] = [];
    const events: ProxyEvent[] = [];
    let resolveEvents: (() => void) | undefined;
    const allEvents = new Promise<void>((resolve) => {
      resolveEvents = resolve;
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      captures.push({
        url: request.url,
        body: new Uint8Array(await request.arrayBuffer()),
      });
      return request.url.includes('anthropic.test') ? anthropicResponse() : openAIResponse();
    }) as typeof fetch;

    const proxy = createProxy({
      upstream: 'http://anthropic.test',
      openAIUpstream: 'http://openai.test',
      transform: {
        compress: true,
        compressProjectGuidance: true,
        compressToolResults: true,
        minCompressChars: 1,
        minToolResultChars: 1,
      },
      onRequest: (event) => {
        events.push(event);
        if (events.length === bodies.length) resolveEvents?.();
      },
    });

    for (let index = 0; index < bodies.length; index++) {
      const response = await proxy(new Request(`http://localhost${paths[index]}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: bodies[index],
      }));
      expect(response.status).toBe(200);
      await response.text();
    }
    await allEvents;

    expect(captures.map((capture) => capture.url)).toEqual([
      'http://anthropic.test/v1/messages',
      'http://anthropic.test/v1/messages',
      'http://openai.test/v1/chat/completions',
      'http://openai.test/v1/chat/completions',
    ]);
    expect(captures.map((capture) => capture.body)).toEqual(expectedBytes);
    expect(events.map((event) => event.model)).toEqual(expectedModels);
    expect(events.map((event) => event.reqBodySha8)).toEqual(
      await Promise.all(expectedBytes.map((body) => sha8(body))),
    );

    for (let index = 0; index < captures.length; index++) {
      const outgoing = decoder.decode(captures[index]!.body);
      expect(outgoing).toBe(bodies[index]);
      expect(outgoing.indexOf(`${requestMarkers[index]}SYSTEM_FIRST`))
        .toBeLessThan(outgoing.indexOf(`${requestMarkers[index]}SYSTEM_SECOND`));
      expect(outgoing.indexOf(`${requestMarkers[index]}REQUEST_FIRST`))
        .toBeLessThan(outgoing.indexOf(`${requestMarkers[index]}REQUEST_SECOND`));
      for (let other = 0; other < requestMarkers.length; other++) {
        if (other !== index) expect(outgoing).not.toContain(requestMarkers[other]);
      }
      expect(events[index]!.reqBodySha8).toBe(await sha8(captures[index]!.body));
    }
  });
});
