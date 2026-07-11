import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateRawRequestTarget } from '../src/node-target.js';

interface RunningProxy {
  readonly child: ChildProcessWithoutNullStreams;
  readonly fetchLog: string;
  readonly port: number;
  readonly root: string;
  output: string;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

interface CapturedFetch {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly bodyBase64: string;
  readonly redirect?: string;
}

interface WireTrap {
  readonly server: net.Server;
  readonly port: number;
  readonly requestLines: string[];
}

const roots = new Set<string>();
const live = new Set<RunningProxy>();
const wireTraps = new Set<WireTrap>();

const CLEAN_ENV_KEYS = [
  'PORT',
  'HOST',
  'PXPIPE_UPSTREAM',
  'ANTHROPIC_UPSTREAM',
  'OPENAI_UPSTREAM',
  'OPENAI_API_KEY',
  'PXPIPE_PROVIDER',
  'PXPIPE_GATEWAY_BASE_URL',
  'PXPIPE_GATEWAY_HEADERS',
  'PXPIPE_CODEX_UPSTREAM',
  'PXPIPE_GROK_UPSTREAM',
  'PXPIPE_CONFIG',
  'PXPIPE_LOG',
  'PXPIPE_MODELS',
  'PXPIPE_DISABLE',
  'PXPIPE_DUMP_DIR',
  'PXPIPE_TEST_WIRE_PORT',
] as const;

afterEach(async () => {
  await Promise.all([...live].map((proxy) => stopProxy(proxy)));
  await Promise.all([...wireTraps].map((trap) => stopWireTrap(trap)));
});

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to allocate a loopback port');
  }
  const port = address.port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startWireTrap(): Promise<WireTrap> {
  const requestLines: string[] = [];
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk: Buffer) => {
      if (answered) return;
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      answered = true;
      requestLines.push(received.subarray(0, headerEnd).toString('latin1').split('\r\n')[0] ?? '');
      const body = '{"ok":true}';
      socket.end([
        'HTTP/1.1 200 OK',
        'content-type: application/json',
        `content-length: ${Buffer.byteLength(body)}`,
        'connection: close',
        '',
        body,
      ].join('\r\n'));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('failed to start wire trap');
  }
  const trap = { server, port: address.port, requestLines };
  wireTraps.add(trap);
  return trap;
}

async function stopWireTrap(trap: WireTrap): Promise<void> {
  wireTraps.delete(trap);
  if (!trap.server.listening) return;
  trap.server.close();
  await once(trap.server, 'close');
}

async function startProxy(
  overrides: Record<string, string | null> = {},
): Promise<RunningProxy> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-node-boundary-'));
  roots.add(root);
  const fetchLog = path.join(root, 'fetches.jsonl');
  const eventsFile = path.join(root, 'events.jsonl');
  const configFile = path.join(root, 'missing-config.json');
  const preloader = path.join(root, 'capture-fetch.mjs');
  fs.writeFileSync(preloader, `
import * as fs from 'node:fs';

const nativeFetch = globalThis.fetch;

async function bodyBytes(body) {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  return Buffer.from(await new Response(body).arrayBuffer());
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' || input instanceof URL
    ? String(input)
    : input.url;
  new URL(url);
  if (process.env.PXPIPE_TEST_WIRE_PORT) {
    const target = new URL(url);
    target.protocol = 'http:';
    target.hostname = '127.0.0.1';
    target.port = process.env.PXPIPE_TEST_WIRE_PORT;
    return nativeFetch(target.href, init);
  }
  const headers = Object.fromEntries(new Headers(init.headers ?? input.headers).entries());
  const body = await bodyBytes(init.body);
  fs.appendFileSync(process.env.PXPIPE_TEST_FETCH_LOG, JSON.stringify({
    url,
    method: init.method ?? input.method ?? 'GET',
    headers,
    bodyBase64: body.toString('base64'),
    redirect: init.redirect,
  }) + '\\n');
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
`);

  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of CLEAN_ENV_KEYS) delete env[key];
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    PXPIPE_CODEX_UPSTREAM: 'https://codex.test/backend-api/codex',
    PXPIPE_GROK_UPSTREAM: 'https://grok.test',
    PXPIPE_CONFIG: configFile,
    PXPIPE_LOG: eventsFile,
    PXPIPE_MODELS: 'off',
    PXPIPE_TEST_FETCH_LOG: fetchLog,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', preloader, 'src/node.ts'],
    {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const proxy: RunningProxy = { child, fetchLog, port, root, output: '' };
  live.add(proxy);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`proxy start timed out:\n${proxy.output}`));
    }, 10_000);
    const onData = (chunk: Buffer) => {
      proxy.output += String(chunk);
      if (proxy.output.includes('[pxpipe] listening on')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited before ready (${code ?? signal}):\n${proxy.output}`));
    });
  });

  return proxy;
}

async function stopProxy(proxy: RunningProxy): Promise<void> {
  live.delete(proxy);
  if (proxy.child.exitCode !== null || proxy.child.signalCode !== null) return;
  const exited = once(proxy.child, 'exit').then(() => true);
  proxy.child.kill('SIGTERM');
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000));
  if (!(await Promise.race([exited, timedOut]))) {
    const forcedExit = once(proxy.child, 'exit');
    proxy.child.kill('SIGKILL');
    await forcedExit;
  }
}

function readFetches(proxy: RunningProxy): CapturedFetch[] {
  if (!fs.existsSync(proxy.fetchLog)) return [];
  const text = fs.readFileSync(proxy.fetchLog, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line) as CapturedFetch);
}

async function rawRequest(
  port: number,
  target: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<RawResponse> {
  const method = options.method ?? 'GET';
  const body = Buffer.isBuffer(options.body)
    ? options.body
    : Buffer.from(options.body ?? '');
  const headers: Record<string, string> = {
    host: `127.0.0.1:${port}`,
    connection: 'close',
    ...options.headers,
  };
  if (body.byteLength > 0 && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(body.byteLength);
  }

  const requestHead = [
    `${method} ${target} HTTP/1.1`,
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ].join('\r\n');

  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(5_000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('connect', () => socket.write(Buffer.concat([Buffer.from(requestHead, 'latin1'), body])));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
  });

  const separator = bytes.indexOf('\r\n\r\n');
  if (separator === -1) throw new Error(`invalid HTTP response: ${bytes.toString('latin1')}`);
  const lines = bytes.subarray(0, separator).toString('latin1').split('\r\n');
  const statusMatch = /^HTTP\/1\.1 (\d{3})/u.exec(lines[0] ?? '');
  if (!statusMatch) throw new Error(`invalid HTTP status: ${lines[0] ?? ''}`);
  const responseHeaders: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) responseHeaders[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number(statusMatch[1]),
    headers: responseHeaders,
    body: bytes.subarray(separator + 4),
  };
}

describe('raw reserved request-target validation', () => {
  it('ignores queries and unrelated paths but rejects every normalizable reserved form', () => {
    for (const target of [
      '/',
      '/dashboard?next=/_pxpipe/..%2f%25\\',
      '/ordinary/_pxpipe-note',
      'http://_pxpipe.example/ordinary',
      '/_pxpipe/codex/responses',
      '/_pxpipe/codex/responses?next=/_pxpipe/..%2f%25\\',
      '/_pxpipe/codex/unknown',
    ]) {
      expect(validateRawRequestTarget(target), target).toEqual({ ok: true });
    }

    for (const target of [
      'http://attacker.invalid/_pxpipe/codex/responses',
      'http:_pxpipe/codex/../grok/v1/responses',
      'http:_pxpipe/codex/%2e%2e/grok/v1/responses',
      'http:_pxpipe\\codex\\..\\grok\\v1\\responses',
      '//attacker.invalid/_pxpipe/codex/responses',
      '/_pxpipe/./codex/responses',
      '/_pxpipe/%2e/codex/responses',
      '/_pxpipe/../grok/v1/responses',
      '/_pxpipe/%2E%2e/grok/v1/responses',
      '/_pxpipe/.%2e/grok/v1/responses',
      '/_pxpipe/%2e./grok/v1/responses',
      '/_pxpipe/codex%2fresponses',
      '/_pxpipe/codex%5Cresponses',
      '/_pxpipe/codex%25responses',
      '/_pxpipe/codex/%',
      '/_pxpipe/codex/%2',
      '/_pxpipe\\codex\\responses',
      '/x\\..\\_pxpipeish\\codex\\models',
      '/_pxpipe/codex/responses#fragment',
      '/_pxpipe/codex/responses?x=#fragment',
      '/_pxpipe//codex/responses',
      '/_pxpipe/codex/_pxpipe/responses',
      '/x/../_pxpipe/codex/responses',
      '/x/%2e%2e/_pxpipe/codex/responses',
      '/x/../_pxpipeish/codex/models',
      '/_pxpipeish/codex/responses',
    ]) {
      expect(validateRawRequestTarget(target), target).toEqual({ ok: false });
    }
  });

  it('returns fixed 404s with zero fetches through the real Node socket boundary', async () => {
    const proxy = await startProxy();
    const attacks = [
      'http://attacker.invalid/_pxpipe/codex/responses',
      'http:_pxpipe/codex/../grok/v1/responses',
      'http:_pxpipe/codex/%2e%2e/grok/v1/responses',
      'http:_pxpipe\\codex\\..\\grok\\v1\\responses',
      '//attacker.invalid/_pxpipe/codex/responses',
      '/_pxpipe/./codex/responses',
      '/_pxpipe/%2e/codex/responses',
      '/_pxpipe/../grok/v1/responses',
      '/_pxpipe/../dashboard',
      '/_pxpipe/%2E%2e/grok/v1/responses',
      '/_pxpipe/.%2e/grok/v1/responses',
      '/_pxpipe/%2e./grok/v1/responses',
      '/_pxpipe/codex%2fresponses',
      '/_pxpipe/codex%5Cresponses',
      '/_pxpipe/codex%25responses',
      '/_pxpipe/codex/%',
      '/_pxpipe/codex/%2',
      '/_pxpipe\\codex\\responses',
      '/x\\..\\_pxpipeish\\codex\\models',
      '/_pxpipe/codex/responses#fragment',
      '/_pxpipe/codex/responses?x=#fragment',
      '/_pxpipe//codex/responses',
      '/_pxpipe/codex/_pxpipe/responses',
      '/_pxpipe/codex/%5fpxpipe/responses',
      '/x/../_pxpipe/codex/responses',
      '/x/%2e%2e/_pxpipe/codex/responses',
      '/x/../_pxpipeish/codex/models',
      '/_pxpipeish/codex/responses',
      '/_pxpipe/codex/unknown',
    ];
    const parserRejected = new Set([
      'http:_pxpipe/codex/../grok/v1/responses',
      'http:_pxpipe/codex/%2e%2e/grok/v1/responses',
      'http:_pxpipe\\codex\\..\\grok\\v1\\responses',
    ]);

    for (const target of attacks) {
      const response = await rawRequest(proxy.port, target, {
        method: 'POST',
        headers: { authorization: 'Bearer local-subscription' },
        body: '{}',
      });
      // llhttp rejects same-scheme relative request targets before Node creates
      // an IncomingMessage. They are still local and perform zero fetches.
      expect(response.status, target).toBe(parserRejected.has(target) ? 400 : 404);
    }
    expect(readFetches(proxy)).toEqual([]);
  }, 30_000);
});

describe('Node subscription environment boundary', () => {
  it('preserves dashboard traffic and exact Codex/Grok destinations, queries, headers, and bodies', async () => {
    const proxy = await startProxy();

    expect((await rawRequest(proxy.port, '/dashboard')).status).toBe(200);
    expect((await rawRequest(proxy.port, '/dashboard?next=/_pxpipe/..')).status).toBe(200);
    expect(readFetches(proxy)).toEqual([]);

    const codexBody = Buffer.from('{"model":"gpt-5.6-sol","text":"caf\u00e9"}', 'utf8');
    const codexQuery = '?dup=1&dup=&empty&plus=a+b&pct=%2f';
    expect((await rawRequest(proxy.port, `/_pxpipe/codex/responses${codexQuery}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer codex-subscription',
        'chatgpt-account-id': 'account-1',
        'content-type': 'application/json',
      },
      body: codexBody,
    })).status).toBe(200);

    expect((await rawRequest(proxy.port, '/_pxpipe/codex/responses?', {
      method: 'POST',
      headers: { authorization: 'Bearer codex-subscription' },
      body: '{}',
    })).status).toBe(200);

    expect((await rawRequest(proxy.port, '/_pxpipe/codex/responses', {
      method: 'POST',
      headers: {
        host: 'attacker.invalid/ordinary',
        authorization: 'Bearer host-isolated',
      },
      body: '{}',
    })).status).toBe(200);

    expect((await rawRequest(proxy.port, '/_pxpipe/codex/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer proto-isolated',
        'x-forwarded-proto': 'http://attacker.invalid/ordinary',
      },
      body: '{}',
    })).status).toBe(200);

    const grokQuery = '?next=/_pxpipe/..&plus=a+b&pct=%2F';
    expect((await rawRequest(proxy.port, `/_pxpipe/grok/v1/models/model-1${grokQuery}`, {
      headers: {
        authorization: 'Bearer grok-subscription',
        'x-xai-client': 'grok-cli',
      },
    })).status).toBe(200);

    const fetches = readFetches(proxy);
    expect(fetches).toHaveLength(5);
    expect(fetches[0]).toMatchObject({
      url: `https://codex.test/backend-api/codex/responses${codexQuery}`,
      method: 'POST',
      bodyBase64: codexBody.toString('base64'),
      redirect: 'manual',
    });
    expect(fetches[0]?.headers.authorization).toBe('Bearer codex-subscription');
    expect(fetches[0]?.headers['chatgpt-account-id']).toBe('account-1');
    expect(fetches[1]?.url).toBe('https://codex.test/backend-api/codex/responses?');
    expect(fetches[2]?.url).toBe('https://codex.test/backend-api/codex/responses');
    expect(fetches[2]?.headers.authorization).toBe('Bearer host-isolated');
    expect(fetches[3]?.url).toBe('https://codex.test/backend-api/codex/responses');
    expect(fetches[3]?.headers.authorization).toBe('Bearer proto-isolated');
    expect(fetches[4]).toMatchObject({
      url: `https://grok.test/v1/models/model-1${grokQuery}`,
      method: 'GET',
      bodyBase64: '',
      redirect: 'manual',
    });
    expect(fetches[4]?.headers.authorization).toBe('Bearer grok-subscription');
    expect(fetches[4]?.headers['x-xai-client']).toBe('grok-cli');
  }, 30_000);

  it('preserves query order, spelling, and a bare question mark on the native client wire', async () => {
    const trap = await startWireTrap();
    const proxy = await startProxy({ PXPIPE_TEST_WIRE_PORT: String(trap.port) });
    const query = '?dup=1&dup=&empty&plus=a+b&pct=%2f';

    expect((await rawRequest(proxy.port, `/_pxpipe/codex/responses${query}`, {
      method: 'POST',
      headers: { authorization: 'Bearer codex-subscription' },
      body: '{}',
    })).status).toBe(200);
    expect((await rawRequest(proxy.port, '/_pxpipe/codex/responses?', {
      method: 'POST',
      headers: { authorization: 'Bearer codex-subscription' },
      body: '{}',
    })).status).toBe(200);

    expect(trap.requestLines).toEqual([
      `POST /backend-api/codex/responses${query} HTTP/1.1`,
      'POST /backend-api/codex/responses? HTTP/1.1',
    ]);
  }, 30_000);

  it('keeps method, authorization, and selected-vendor configuration failures local', async () => {
    const proxy = await startProxy({ PXPIPE_GROK_UPSTREAM: 'http://grok.invalid' });

    const wrongMethod = await rawRequest(proxy.port, '/_pxpipe/codex/responses', {
      headers: { authorization: 'Bearer codex-subscription' },
    });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe('POST');

    expect((await rawRequest(proxy.port, '/_pxpipe/codex/responses', {
      method: 'POST',
      body: '{}',
    })).status).toBe(401);

    expect((await rawRequest(proxy.port, '/_pxpipe/grok/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer grok-subscription' },
      body: '{}',
    })).status).toBe(503);
    expect(readFetches(proxy)).toEqual([]);

    expect((await rawRequest(proxy.port, '/_pxpipe/codex/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer codex-subscription' },
      body: '{}',
    })).status).toBe(200);
    expect(readFetches(proxy)).toHaveLength(1);

    await stopProxy(proxy);
    const missing = await startProxy({ PXPIPE_CODEX_UPSTREAM: null });
    expect((await rawRequest(missing.port, '/_pxpipe/codex/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer codex-subscription' },
      body: '{}',
    })).status).toBe(503);
    expect(readFetches(missing)).toEqual([]);
  }, 30_000);

  it('starts with hostile generic settings while keeping reserved credentials isolated', async () => {
    const cases: Array<{
      name: string;
      env: Record<string, string | null>;
      genericStatus: number;
    }> = [
      {
        name: 'unknown provider',
        env: {
          PXPIPE_PROVIDER: 'unknown-provider',
          PXPIPE_GATEWAY_BASE_URL: 'https://must-not-be-used.test',
        },
        genericStatus: 500,
      },
      {
        name: 'missing gateway base',
        env: { PXPIPE_PROVIDER: 'cloudflare-ai-gateway' },
        genericStatus: 500,
      },
      {
        name: 'malformed gateway headers',
        env: {
          PXPIPE_GATEWAY_HEADERS: '{not-json',
          PXPIPE_GATEWAY_BASE_URL: 'https://must-not-be-used.test',
        },
        genericStatus: 500,
      },
      {
        name: 'malformed nonempty gateway base',
        env: {
          PXPIPE_PROVIDER: 'cloudflare-ai-gateway',
          PXPIPE_GATEWAY_BASE_URL: 'not a URL',
        },
        genericStatus: 500,
      },
      {
        name: 'malformed gateway header name',
        env: {
          PXPIPE_PROVIDER: 'cloudflare-ai-gateway',
          PXPIPE_GATEWAY_BASE_URL: 'https://gateway.test',
          PXPIPE_GATEWAY_HEADERS: 'Bad Header=value',
        },
        genericStatus: 500,
      },
      {
        name: 'invalid generic upstreams and hostile key',
        env: {
          ANTHROPIC_UPSTREAM: 'not a URL',
          OPENAI_UPSTREAM: 'not a URL',
          OPENAI_API_KEY: 'hostile-generic-key',
        },
        genericStatus: 502,
      },
    ];

    for (const testCase of cases) {
      const proxy = await startProxy(testCase.env);
      const reserved = await rawRequest(proxy.port, '/_pxpipe/codex/responses', {
        method: 'POST',
        headers: { authorization: 'Bearer subscription-token' },
        body: '{}',
      });
      expect(reserved.status, testCase.name).toBe(200);
      const afterReserved = readFetches(proxy);
      expect(afterReserved, testCase.name).toHaveLength(1);
      expect(afterReserved[0]?.url, testCase.name).toBe(
        'https://codex.test/backend-api/codex/responses',
      );
      expect(afterReserved[0]?.headers.authorization, testCase.name).toBe(
        'Bearer subscription-token',
      );

      const generic = await rawRequest(proxy.port, '/v1/responses', {
        method: 'POST',
        body: '{}',
      });
      expect(generic.status, testCase.name).toBe(testCase.genericStatus);
      if (testCase.genericStatus === 500) {
        expect(generic.headers['content-type'], testCase.name).toBe('application/json');
      }
      expect(readFetches(proxy), testCase.name).toHaveLength(1);
      await stopProxy(proxy);
    }
  }, 60_000);

  it('normalizes a whitespace OpenAI key to unset at the real process boundary', async () => {
    const proxy = await startProxy({ OPENAI_API_KEY: '  \t  ' });
    expect((await rawRequest(proxy.port, '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })).status).toBe(200);

    expect((await rawRequest(proxy.port, '/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer caller-token',
        'content-type': 'application/json',
      },
      body: '{}',
    })).status).toBe(200);

    const fetches = readFetches(proxy);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(fetches[0]?.headers).not.toHaveProperty('authorization');
    expect(fetches[1]?.headers.authorization).toBe('Bearer caller-token');
  }, 30_000);
});
