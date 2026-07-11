import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProxy,
  type ProxyConfig,
  type ProxyEvent,
} from '../src/core/proxy.js';
import {
  classifyReservedRoute,
  resolveSubscriptionBase,
  serializedQuerySuffix,
} from '../src/core/subscription-routing.js';

const encoder = new TextEncoder();
const realFetch = globalThis.fetch;

interface Capture {
  readonly url: string;
  readonly method: string;
  readonly redirect: RequestRedirect;
  readonly headers: Headers;
  readonly body: Uint8Array;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function installFetchStub(captures: Capture[]): void {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    captures.push({
      url: request.url,
      method: request.method,
      redirect: request.redirect,
      headers: new Headers(request.headers),
      body: new Uint8Array(await request.arrayBuffer()),
    });
    return new Response(JSON.stringify({
      id: 'synthetic',
      usage: { input_tokens: 3, output_tokens: 2 },
    }), {
      headers: {
        'content-type': 'application/json',
        connection: 'x-response-hop',
        'keep-alive': 'timeout=5',
        'proxy-connection': 'keep-alive',
        'proxy-authenticate': 'Basic fake',
        'proxy-authorization': 'Basic fake',
        te: 'trailers',
        trailer: 'x-trailer',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'content-encoding': 'gzip',
        'content-length': '9999',
        'x-response-hop': 'remove-me',
        'x-response-keep': 'keep-me',
      },
    });
  }) as typeof fetch;
}

function makeProxy(overrides: ProxyConfig = {}) {
  return createProxy({
    upstream: 'https://anthropic.test',
    openAIUpstream: 'https://openai.test',
    codexUpstream: 'https://chatgpt.test/backend-api/codex',
    grokUpstream: 'https://grok.test',
    ...overrides,
  });
}

function reservedRequest(
  path: string,
  method = 'GET',
  body?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: 'Bearer opaque-subscription-token',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body,
  });
}

async function settleEvents(events: readonly ProxyEvent[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && events.length < count; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  expect(events).toHaveLength(count);
}

describe('pure reserved route helpers', () => {
  it.each([
    ['/_pxpipe/codex/responses', 'POST', 'codex', '/responses', true],
    ['/_pxpipe/codex/responses/compact', 'POST', 'codex', '/responses/compact', true],
    ['/_pxpipe/codex/models', 'GET', 'codex', '/models', false],
    ['/_pxpipe/codex/models/gpt-5.6-sol', 'GET', 'codex', '/models/gpt-5.6-sol', false],
    ['/_pxpipe/grok/v1/responses', 'POST', 'grok', '/v1/responses', true],
    ['/_pxpipe/grok/v1/models', 'GET', 'grok', '/v1/models', false],
    ['/_pxpipe/grok/v1/models/grok-4.5', 'GET', 'grok', '/v1/models/grok-4.5', false],
    ['/_pxpipe/grok/v1/models-v2', 'GET', 'grok', '/v1/models-v2', false],
    ['/_pxpipe/grok/v1/settings', 'GET', 'grok', '/v1/settings', false],
    ['/_pxpipe/grok/v1/login-config', 'GET', 'grok', '/v1/login-config', false],
    ['/_pxpipe/grok/v1/subagents/bundle', 'GET', 'grok', '/v1/subagents/bundle', false],
  ] as const)(
    'classifies %s',
    (pathname, method, vendor, upstreamPath, hasBody) => {
      expect(classifyReservedRoute(pathname, method)).toEqual({
        kind: 'route',
        vendor,
        upstreamPath,
        hasBody,
      });
    },
  );

  it('distinguishes nonreserved, invalid, and wrong-method paths', () => {
    expect(classifyReservedRoute('/v1/messages', 'POST')).toEqual({ kind: 'none' });
    expect(classifyReservedRoute('/_pxpipeish/codex/models', 'GET')).toEqual({ kind: 'invalid' });
    expect(classifyReservedRoute('/_pxpipe/codex/models', 'POST')).toEqual({
      kind: 'method_not_allowed',
      allow: 'GET',
    });
    expect(classifyReservedRoute('/_pxpipe/codex/responses', 'GET')).toEqual({
      kind: 'method_not_allowed',
      allow: 'POST',
    });
  });

  it.each([
    '/_pxpipe/codex/models/',
    '/_pxpipe/codex//models',
    '/_pxpipe/codex/../grok/v1/models',
    '/_pxpipe/codex/%2e%2e/grok/v1/models',
    '/_pxpipe/codex/models/%2fsecret',
    '/_pxpipe/codex/models/%5Csecret',
    '/_pxpipe/codex/models/%25secret',
    '/_pxpipe/codex/models/%',
    '/_pxpipe/codex\\models',
    '/_pxpipe/codex/_pxpipe/grok/v1/models',
    '/_pxpipe/grok/v1/settings/child',
  ])('rejects unsafe or unknown reserved pathname %s', (pathname) => {
    expect(classifyReservedRoute(pathname, 'GET')).toEqual({ kind: 'invalid' });
  });

  it('validates subscription bases without erasing a fixed path', () => {
    expect(resolveSubscriptionBase('https://chatgpt.test/backend-api/codex/')).toEqual({
      ok: true,
      base: 'https://chatgpt.test/backend-api/codex',
    });
    expect(resolveSubscriptionBase('https://grok.test/')).toEqual({
      ok: true,
      base: 'https://grok.test',
    });
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['   ', 'missing'],
    ['http://chatgpt.test/backend-api/codex', 'invalid'],
    ['https://user:pass@chatgpt.test/backend-api/codex', 'invalid'],
    ['https://chatgpt.test/backend-api/codex?x=1', 'invalid'],
    ['https://chatgpt.test/backend-api/codex?', 'invalid'],
    ['https://chatgpt.test/backend-api/codex#x', 'invalid'],
    ['https://chatgpt.test/backend-api/codex#', 'invalid'],
    ['https://chatgpt.test/backend-api/../codex', 'invalid'],
    ['https://chatgpt.test/backend-api/%2e%2e/codex', 'invalid'],
    ['https://chatgpt.test/backend-api/%2Fcodex', 'invalid'],
    ['https://chatgpt.test/backend-api/%25codex', 'invalid'],
    ['https://chatgpt.test/backend-api//codex', 'invalid'],
    ['https://chatgpt.test/backend-api\\codex', 'invalid'],
  ] as const)('rejects unsafe subscription base %s', (value, reason) => {
    expect(resolveSubscriptionBase(value)).toEqual({ ok: false, reason });
  });

  it.each([
    ['http://localhost/path', ''],
    ['http://localhost/path?', '?'],
    ['http://localhost/path?a=&a&b=+&x=%2f&x=%2F', '?a=&a&b=+&x=%2f&x=%2F'],
  ])('preserves the serialized query in %s', (url, suffix) => {
    expect(serializedQuerySuffix(url)).toEqual({ ok: true, suffix });
  });

  it('rejects serialized fragments', () => {
    expect(serializedQuerySuffix('http://localhost/path#')).toEqual({ ok: false });
    expect(serializedQuerySuffix('http://localhost/path?x=1#fragment')).toEqual({ ok: false });
  });
});

describe('reserved subscription forwarding', () => {
  const body = JSON.stringify({ model: 'synthetic-model', input: 'exact body' });

  it.each([
    ['POST', '/_pxpipe/codex/responses', '/responses'],
    ['POST', '/_pxpipe/codex/responses/compact', '/responses/compact'],
    ['GET', '/_pxpipe/codex/models', '/models'],
    ['GET', '/_pxpipe/codex/models/gpt-5.6-sol', '/models/gpt-5.6-sol'],
  ])('forwards Codex %s %s to its exact base path', async (method, localPath, upstreamPath) => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const response = await makeProxy()(reservedRequest(
      localPath,
      method,
      method === 'POST' ? body : undefined,
    ));
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe(`https://chatgpt.test/backend-api/codex${upstreamPath}`);
  });

  it.each([
    ['POST', '/_pxpipe/grok/v1/responses', '/v1/responses'],
    ['GET', '/_pxpipe/grok/v1/models', '/v1/models'],
    ['GET', '/_pxpipe/grok/v1/models/grok-4.5', '/v1/models/grok-4.5'],
    ['GET', '/_pxpipe/grok/v1/models-v2', '/v1/models-v2'],
    ['GET', '/_pxpipe/grok/v1/settings', '/v1/settings'],
    ['GET', '/_pxpipe/grok/v1/login-config', '/v1/login-config'],
    ['GET', '/_pxpipe/grok/v1/subagents/bundle', '/v1/subagents/bundle'],
  ])('forwards Grok %s %s exactly', async (method, localPath, upstreamPath) => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const response = await makeProxy()(reservedRequest(
      localPath,
      method,
      method === 'POST' ? body : undefined,
    ));
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe(`https://grok.test${upstreamPath}`);
  });

  it.each([
    ['?', '?'],
    ['?a=&a&b=+&x=%2f&x=%2F', '?a=&a&b=+&x=%2f&x=%2F'],
    ['?=empty&&tail=', '?=empty&&tail='],
  ])('preserves exact query suffix %s', async (query, expected) => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const response = await makeProxy()(reservedRequest(`/_pxpipe/codex/models${query}`));
    await response.arrayBuffer();
    expect(captures[0]?.url).toBe(`https://chatgpt.test/backend-api/codex/models${expected}`);
  });

  it('preserves end-to-end headers and strips the complete hop-by-hop set', async () => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const response = await makeProxy()(reservedRequest(
      '/_pxpipe/grok/v1/responses',
      'POST',
      body,
      {
        connection: 'x-dynamic-hop',
        host: 'forged-host.test',
        'keep-alive': 'timeout=5',
        'proxy-connection': 'keep-alive',
        'proxy-authenticate': 'Basic fake',
        'proxy-authorization': 'Basic fake',
        te: 'trailers',
        trailer: 'x-trailer',
        'transfer-encoding': 'chunked',
        upgrade: 'websocket',
        'content-length': '9999',
        expect: '100-continue',
        'accept-encoding': 'gzip',
        'x-dynamic-hop': 'remove-me',
        'chatgpt-account-id': 'acct_fake',
        'x-xai-client': 'xai-value',
        'x-grok-client': 'grok-value',
        'x-end-to-end': 'keep-me',
      },
    ));
    await response.arrayBuffer();

    const headers = captures[0]!.headers;
    expect(headers.get('authorization')).toBe('Bearer opaque-subscription-token');
    expect(headers.get('chatgpt-account-id')).toBe('acct_fake');
    expect(headers.get('x-xai-client')).toBe('xai-value');
    expect(headers.get('x-grok-client')).toBe('grok-value');
    expect(headers.get('x-end-to-end')).toBe('keep-me');
    for (const name of [
      'connection',
      'host',
      'keep-alive',
      'proxy-connection',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'content-length',
      'expect',
      'accept-encoding',
      'x-dynamic-hop',
    ]) {
      expect(headers.get(name), name).toBeNull();
    }
    for (const name of [
      'connection',
      'keep-alive',
      'proxy-connection',
      'proxy-authenticate',
      'proxy-authorization',
      'te',
      'trailer',
      'transfer-encoding',
      'upgrade',
      'content-encoding',
      'content-length',
      'x-response-hop',
    ]) {
      expect(response.headers.get(name), name).toBeNull();
    }
    expect(response.headers.get('x-response-keep')).toBe('keep-me');
  });

  it('bypasses hostile generic settings, keys, gateway headers, and transforms', async () => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const transform = vi.fn(() => {
      throw new Error('reserved traffic consulted transform settings');
    });
    const proxy = makeProxy({
      provider: 'cloudflare-ai-gateway',
      gatewayBaseUrl: undefined,
      gatewayHeaders: {
        authorization: 'Bearer hostile-gateway',
        'cf-aig-authorization': 'Bearer hostile-gateway',
      },
      upstream: 'https://hostile-anthropic.test',
      openAIUpstream: 'https://hostile-openai.test',
      apiKey: 'hostile-anthropic-key',
      openAIApiKey: 'hostile-openai-key',
      transform,
      codexUpstream: 'https://chatgpt.test/backend-api/codex',
    });

    const response = await proxy(reservedRequest(
      '/_pxpipe/codex/responses',
      'POST',
      JSON.stringify({ model: 'grok-4.5', input: 'route by path only' }),
      { 'chatgpt-account-id': 'acct_fake' },
    ));
    await response.arrayBuffer();

    expect(response.status).toBe(200);
    expect(transform).not.toHaveBeenCalled();
    expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe('https://chatgpt.test/backend-api/codex/responses');
    expect(captures[0]?.redirect).toBe('manual');
    expect(captures[0]?.headers.get('authorization')).toBe('Bearer opaque-subscription-token');
    expect(captures[0]?.headers.get('x-api-key')).toBeNull();
    expect(captures[0]?.headers.get('cf-aig-authorization')).toBeNull();

    const generic = await proxy(new Request('http://localhost/ordinary'));
    expect(generic.status).toBe(500);
    expect(captures).toHaveLength(1);
  });

  it('fails vendor redirects locally without exposing a followable location', async () => {
    const calls: Array<{ readonly url: string; readonly redirect: RequestRedirect | undefined }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, {
        status: 307,
        headers: { location: 'https://wrong-vendor.test/steal' },
      });
    }) as typeof fetch;

    const response = await makeProxy()(reservedRequest(
      '/_pxpipe/codex/models',
      'GET',
      undefined,
      { 'chatgpt-account-id': 'acct_fake' },
    ));

    expect(response.status).toBe(502);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ error: 'reserved_upstream_redirect' });
    expect(calls).toEqual([{
      url: 'https://chatgpt.test/backend-api/codex/models',
      redirect: 'manual',
    }]);
  });

  it('preserves a non-followable 304 cache response for auxiliary GETs', async () => {
    const calls: Array<{ readonly url: string; readonly redirect: RequestRedirect | undefined }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push({ url: String(input), redirect: init?.redirect });
      return new Response(null, {
        status: 304,
        headers: { etag: '"synthetic"' },
      });
    }) as typeof fetch;

    const response = await makeProxy()(reservedRequest('/_pxpipe/grok/v1/models'));
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe('"synthetic"');
    expect(calls).toEqual([{
      url: 'https://grok.test/v1/models',
      redirect: 'manual',
    }]);
  });

  it('keeps vendor and generic configuration failures independent', async () => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const proxy = makeProxy({
      codexUpstream: 'http://invalid-codex.test',
      grokUpstream: 'https://grok.test',
    });

    const codex = await proxy(reservedRequest('/_pxpipe/codex/models'));
    expect(codex.status).toBe(503);
    const grok = await proxy(reservedRequest('/_pxpipe/grok/v1/models'));
    await grok.arrayBuffer();
    expect(grok.status).toBe(200);
    const generic = await proxy(new Request('http://localhost/ordinary'));
    await generic.arrayBuffer();

    expect(captures.map((capture) => capture.url)).toEqual([
      'https://grok.test/v1/models',
      'https://anthropic.test/ordinary',
    ]);
  });
});

describe('reserved local failures', () => {
  it.each([
    ['unknown route', '/_pxpipe/codex/unknown', 'GET', {}, {}, 404, null],
    ['prefix lookalike', '/_pxpipeish/codex/models', 'GET', {}, {}, 404, null],
    ['encoded separator', '/_pxpipe/codex/models/%2Fsecret', 'GET', {}, {}, 404, null],
    ['duplicate segment', '/_pxpipe/codex//models', 'GET', {}, {}, 404, null],
    ['fragment', '/_pxpipe/codex/models#fragment', 'GET', {}, {}, 404, null],
    ['wrong GET', '/_pxpipe/codex/responses', 'GET', {}, {}, 405, 'POST'],
    ['wrong POST', '/_pxpipe/grok/v1/settings', 'POST', {}, {}, 405, 'GET'],
    ['missing auth', '/_pxpipe/codex/models', 'GET', { authorization: '' }, {}, 401, null],
    [
      'connection-nominated auth',
      '/_pxpipe/codex/models',
      'GET',
      { connection: 'authorization' },
      {},
      401,
      null,
    ],
    [
      'connection-nominated account',
      '/_pxpipe/codex/models',
      'GET',
      { connection: 'chatgpt-account-id', 'chatgpt-account-id': 'acct_fake' },
      {},
      401,
      null,
    ],
    [
      'connection-nominated x-xai credential',
      '/_pxpipe/grok/v1/models',
      'GET',
      { connection: 'x-xai-auth', 'x-xai-auth': 'opaque' },
      {},
      401,
      null,
    ],
    [
      'connection-nominated x-grok credential',
      '/_pxpipe/grok/v1/models',
      'GET',
      { connection: 'x-grok-auth', 'x-grok-auth': 'opaque' },
      {},
      401,
      null,
    ],
    [
      'missing base',
      '/_pxpipe/codex/models',
      'GET',
      {},
      { codexUpstream: undefined },
      503,
      null,
    ],
    [
      'invalid base',
      '/_pxpipe/grok/v1/models',
      'GET',
      {},
      { grokUpstream: 'http://grok.test' },
      503,
      null,
    ],
  ] as const)(
    '%s is fixed and performs zero fetches',
    async (_name, path, method, headers, config, status, allow) => {
      const captures: Capture[] = [];
      installFetchStub(captures);
      const response = await makeProxy(config)(reservedRequest(path, method, undefined, headers));

      expect(response.status).toBe(status);
      expect(response.headers.get('allow')).toBe(allow);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({
        error: status === 404
          ? 'reserved_route_not_found'
          : status === 405
            ? 'reserved_method_not_allowed'
            : status === 401
              ? 'reserved_authorization_required'
              : 'reserved_upstream_unavailable',
      });
      expect(captures).toHaveLength(0);
    },
  );

  it('checks authorization before selected-vendor configuration', async () => {
    const captures: Capture[] = [];
    installFetchStub(captures);
    const response = await makeProxy({ codexUpstream: undefined })(new Request(
      'http://localhost/_pxpipe/codex/models',
    ));
    expect(response.status).toBe(401);
    expect(captures).toHaveLength(0);
  });
});

describe('exact pass-through and request isolation', () => {
  it('alternates Codex, compact, and Grok without rewriting, probing, or leaking state', async () => {
    const captures: Capture[] = [];
    const events: ProxyEvent[] = [];
    installFetchStub(captures);
    const transform = vi.fn(() => {
      throw new Error('reserved request reached compression');
    });
    const proxy = makeProxy({
      transform,
      onRequest: (event) => {
        events.push(event);
      },
    });
    const cases = [
      {
        path: '/_pxpipe/codex/responses',
        destination: 'https://chatgpt.test/backend-api/codex/responses',
        model: 'grok-4.5',
        body: '{ "model": "grok-4.5", "input": "codex unique α" }',
      },
      {
        path: '/_pxpipe/codex/responses/compact',
        destination: 'https://chatgpt.test/backend-api/codex/responses/compact',
        model: undefined,
        body: '{ "input": "compact unique β", "opaque": [3, 2, 1] }',
      },
      {
        path: '/_pxpipe/grok/v1/responses',
        destination: 'https://grok.test/v1/responses',
        model: 'gpt-5.6-sol',
        body: '{ "model": "gpt-5.6-sol", "input": "grok unique γ" }',
      },
      {
        path: '/_pxpipe/codex/responses',
        destination: 'https://chatgpt.test/backend-api/codex/responses',
        model: 'top-level-safe',
        body: '{ "metadata": { "model": "nested-private" }, "model": "top-level-safe", "input": "nested first" }',
      },
    ] as const;

    for (const item of cases) {
      const response = await proxy(reservedRequest(item.path, 'POST', item.body));
      await response.arrayBuffer();
    }
    await settleEvents(events, cases.length);

    expect(transform).not.toHaveBeenCalled();
    expect(captures).toHaveLength(cases.length);
    expect(captures.every((capture) => !capture.url.includes('count_tokens'))).toBe(true);
    for (let index = 0; index < cases.length; index += 1) {
      const item = cases[index]!;
      const expectedBody = encoder.encode(item.body);
      const capture = captures[index]!;
      const event = events[index]!;
      expect(capture.url).toBe(item.destination);
      expect(capture.body).toEqual(expectedBody);
      expect(createHash('sha256').update(capture.body).digest('hex')).toBe(
        createHash('sha256').update(expectedBody).digest('hex'),
      );
      expect(event.model).toBe(item.model);
      expect(event.reqBodySha8).toBe(
        createHash('sha256').update(expectedBody).digest('hex').slice(0, 8),
      );
      expect(event.info).toMatchObject({
        compressed: false,
        imageCount: 0,
        imageBytes: 0,
        origChars: 0,
        compressedChars: 0,
      });
      expect(event.info).not.toHaveProperty('baselineTokens');
      expect(event.info).not.toHaveProperty('admissionSignedSavingsTokens');
      expect(event.info).not.toHaveProperty('imagePngs');
    }
  });
});
