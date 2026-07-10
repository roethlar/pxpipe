/**
 * END-TO-END cache-alignment contract through the REAL proxy.
 *
 * Unlike anthropic-cache-align / gpt-cache-align (which call collapseHistory /
 * planGptCollapse directly), this drives `createProxy` against a FAKE upstream
 * and asserts on the bytes the proxy actually FORWARDS. That closes the gap the
 * unit tests can't see: routing, the gate, marker relocation, transform-once,
 * and — the headline — that the cacheable image PREFIX stays byte-identical as
 * the conversation grows turn-by-turn (the real Claude Code / OpenCode loop).
 *
 *   fake api  = the upstream output (canned responses + count_tokens probe)
 *   our input = pxpipe's transform of the request body
 *
 * If a regression ever makes the rendered prefix non-deterministic (timestamp,
 * map ordering, re-imaging on every turn), the byte-identity assertions below go
 * red — which is exactly the cache-busting failure that costs real money.
 *
 * Run just this file:  pnpm vitest run tests/cache-stability-e2e.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  makeProjectGuidanceBoundary,
  projectGuidanceBoundaryRef,
} from '../src/core/anthropic-context.js';
import { createProxy } from '../src/core/proxy.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import { HISTORY_SYNTHETIC_INTRO } from '../src/core/history.js';
import {
  PROJECT_GUIDANCE_MANIFEST_TAG,
  sha8,
  type TransformInfo,
} from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, TextBlock } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

// ---------------------------------------------------------------------------
// Fake upstream — records every outbound MAIN request body and answers with a
// canned, well-formed response so the proxy completes. The /count_tokens probe
// is answered separately (never recorded as a main request).
// ---------------------------------------------------------------------------
interface Captured {
  url: string;
  path: string;
  body: string;
  authorization: string | null;
  apiKey: string | null;
}

function fakeUpstream() {
  const main: Captured[] = [];
  const sidePaths: string[] = [];
  const real = globalThis.fetch;

  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    const path = url.pathname;

    // Anthropic baseline probe — stub it, don't record as a main request.
    if (path.endsWith('/count_tokens')) {
      sidePaths.push(path);
      return new Response(JSON.stringify({ input_tokens: 9999 }), {
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
    // Anthropic /v1/messages
    return new Response(
      JSON.stringify({
        id: 'msg_1',
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

  return {
    main,
    sidePaths,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

/** Force imaging deterministically (matches proxy-usage.test.ts). */
const FORCE = { charsPerToken: 1, minCompressChars: 1 } as const;

const slab = (n: number) => '# CLAUDE.md\nYou are helpful.\n' + 'rule. '.repeat(Math.ceil(n / 6));
const filler = (n: number) => 'x'.repeat(n);

function largeProjectGuidance(marker = 'stable'): string {
  const rows = Array.from(
    { length: 3200 },
    (_, index) => `${marker} governance row ${index}: preserve role and priority.`,
  ).join('\n');
  return `${DIRECT_PROJECT_GUIDANCE}\n\n${rows}`;
}

// ---- outbound-body inspectors -------------------------------------------
/** Every Anthropic image block across all messages, in order, with its marker. */
function anthropicImages(bodyText: string): { data: string; marked: boolean }[] {
  const b = JSON.parse(bodyText);
  const out: { data: string; marked: boolean }[] = [];
  for (const m of b.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const blk of m.content) {
      if (blk?.type === 'image') {
        out.push({ data: blk.source.data, marked: blk.cache_control !== undefined });
      }
    }
  }
  return out;
}

/** History images are identified by their synthetic banner, never by message index. */
function anthropicHistoryImages(bodyText: string): { data: string; marked: boolean }[] {
  const body = JSON.parse(bodyText) as MessagesRequest;
  const synthetic = body.messages.find(
    (message) =>
      Array.isArray(message.content) &&
      message.content[0]?.type === 'text' &&
      message.content[0].text === HISTORY_SYNTHETIC_INTRO,
  );
  if (!synthetic || !Array.isArray(synthetic.content)) return [];
  return synthetic.content
    .filter((block) => block.type === 'image')
    .map((block) => ({
      data: block.source.data,
      marked: block.cache_control !== undefined,
    }));
}

interface ProjectContract {
  ref: string;
  images: { data: string; marked: boolean }[];
  manifest: string;
  boundary: string;
}

/** Read the role-binding contract using TransformInfo + the shared boundary parser. */
function projectContract(bodyText: string, info: TransformInfo): ProjectContract {
  expect(info.projectDisposition).toBe('imaged');
  expect(info.projectRef).toMatch(/^pg_[0-9a-f]{32}$/);
  expect(info.projectImageCount).toBeGreaterThan(0);
  const ref = info.projectRef!;
  const body = JSON.parse(bodyText) as MessagesRequest;
  const carrier = body.messages.find(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (block) => block.type === 'text' && projectGuidanceBoundaryRef(block.text) === ref,
      ),
  );
  expect(carrier).toBeDefined();
  expect(Array.isArray(carrier!.content)).toBe(true);
  const content = carrier!.content as ContentBlock[];
  const boundaryIndex = content.findIndex(
    (block) => block.type === 'text' && projectGuidanceBoundaryRef(block.text) === ref,
  );
  expect(boundaryIndex).toBe(info.projectImageCount);
  const projectBlocks = content.slice(0, boundaryIndex);
  expect(projectBlocks.every((block) => block.type === 'image')).toBe(true);
  const images = projectBlocks.map((block) => {
    const image = block as Extract<ContentBlock, { type: 'image' }>;
    return {
      data: image.source.data,
      marked: image.cache_control !== undefined,
    };
  });
  const system = Array.isArray(body.system) ? body.system : [];
  const manifest = system.find(
    (block): block is TextBlock =>
      block.type === 'text' && block.text.includes(`<${PROJECT_GUIDANCE_MANIFEST_TAG} version="1">`),
  )?.text;
  expect(manifest).toBeDefined();
  expect(manifest).toContain(`ref: ${ref}`);
  expect(manifest).toContain(`first ${images.length} image block(s)`);
  const boundary = (content[boundaryIndex] as TextBlock).text;
  expect(boundary).toBe(makeProjectGuidanceBoundary(ref));
  return { ref, images, manifest: manifest!, boundary };
}

/** GPT chat-completions image data URLs across all messages, in order. */
function gptChatImages(bodyText: string): string[] {
  const b = JSON.parse(bodyText);
  const out: string[] = [];
  for (const m of b.messages ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) if (c?.type === 'image_url') out.push(c.image_url.url);
  }
  return out;
}

/** GPT Responses image data URLs across all input items, in order.
 *  (Extract the data URL, not the whole block — append-only correctness is about
 *  the image BYTES, not structural fields like `detail`.) */
function gptResponsesImages(bodyText: string): string[] {
  const b = JSON.parse(bodyText);
  const out: string[] = [];
  for (const m of b.input ?? []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) if (c?.type === 'input_image') out.push(c.image_url);
  }
  return out;
}

// ---- request-body builders ----------------------------------------------
function anthropicBody(opts: {
  model?: string;
  slabChars?: number;
  /** Appended verbatim to the slab text INSIDE the marked system block —
   *  used to inject a volatile `# Environment` section next to static content. */
  sysSuffix?: string;
  turns: { role: 'user' | 'assistant'; text: string }[];
}): string {
  const system = opts.slabChars
    ? [
        {
          type: 'text',
          text: slab(opts.slabChars) + (opts.sysSuffix ?? ''),
          cache_control: { type: 'ephemeral' },
        },
      ]
    : 'short';
  return JSON.stringify({
    model: opts.model ?? 'claude-fable-5',
    max_tokens: 16,
    system,
    messages: opts.turns.map((t) => ({ role: t.role, content: t.text })),
  });
}

function anthropicProjectBody(opts: {
  model?: string;
  projectGuidance?: string;
  liveText?: string;
  email?: string;
  date?: string;
  turns?: { role: 'user' | 'assistant'; text: string }[];
} = {}): string {
  const req = makeCapturedRequest({
    projectGuidance: opts.projectGuidance ?? largeProjectGuidance(),
    email: opts.email ?? 'owner@example.invalid',
    date: opts.date ?? '2026-07-10',
  });
  req.model = opts.model ?? 'claude-fable-5';
  req.max_tokens = 16;
  const opening = req.messages[0]!.content as ContentBlock[];
  opening[1] = {
    type: 'text',
    text: opts.liveText ?? 'Inspect the synthetic repository.',
    cache_control: { type: 'ephemeral' },
  };
  for (const turn of opts.turns ?? []) {
    req.messages.push({ role: turn.role, content: turn.text });
  }
  return JSON.stringify(req);
}

function turns(n: number, chars: number): { role: 'user' | 'assistant'; text: string }[] {
  return Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    text: `turn ${i}: ${filler(chars)}`,
  }));
}

async function driveAnthropic(body: string, cap = fakeUpstream(), proxyOpts = {}) {
  const proxy = createProxy({
    upstream: 'http://anthropic.test',
    apiKey: 'sk-ant-test',
    transform: FORCE,
    onRequest: () => {},
    ...proxyOpts,
  });
  const res = await proxy(
    new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
      body,
    }),
  );
  await res.text();
  return cap;
}

async function driveAnthropicWithInfo(body: string): Promise<{
  cap: ReturnType<typeof fakeUpstream>;
  info: TransformInfo;
}> {
  const cap = fakeUpstream();
  let resolveInfo!: (info: TransformInfo) => void;
  let rejectInfo!: (error: Error) => void;
  const infoPromise = new Promise<TransformInfo>((resolve, reject) => {
    resolveInfo = resolve;
    rejectInfo = reject;
  });
  await driveAnthropic(body, cap, {
    onRequest: (event: { info?: TransformInfo }) => {
      if (event.info) resolveInfo(event.info);
      else rejectInfo(new Error('Anthropic proxy event omitted TransformInfo'));
    },
  });
  return { cap, info: await infoPromise };
}

// ===========================================================================
describe('e2e cache alignment — Anthropic /v1/messages through the real proxy', () => {
  it('never adds a cache_control marker; every caller marker is conserved', async () => {
    const body = anthropicProjectBody();
    const original = JSON.parse(body) as MessagesRequest;
    const inMarks = countCacheControlMarkers(new TextEncoder().encode(body));
    const { cap, info } = await driveAnthropicWithInfo(body);
    cap.restore();

    expect(cap.main).toHaveLength(1);
    expect(inMarks).toBe(3); // two native-system markers + the live-prompt marker
    const outMarks = countCacheControlMarkers(new TextEncoder().encode(cap.main[0]!.body));
    expect(outMarks).toBe(inMarks);
    const forwarded = JSON.parse(cap.main[0]!.body) as MessagesRequest;
    expect((forwarded.system as ContentBlock[]).slice(0, (original.system as ContentBlock[]).length))
      .toEqual(original.system);
    expect(projectContract(cap.main[0]!.body, info).images.every((image) => !image.marked)).toBe(true);
  });

  it('keeps the caller-owned live marker on the original live block after project pages', async () => {
    const input = anthropicProjectBody({ liveText: 'caller-owned live prompt' });
    const { cap, info } = await driveAnthropicWithInfo(input);
    cap.restore();

    const contract = projectContract(cap.main[0]!.body, info);
    const body = JSON.parse(cap.main[0]!.body) as MessagesRequest;
    const carrier = body.messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === 'text' && projectGuidanceBoundaryRef(block.text) === contract.ref,
        ),
    )!;
    const live = (carrier.content as ContentBlock[]).find(
      (block): block is TextBlock => block.type === 'text' && block.text === 'caller-owned live prompt',
    );
    expect(live?.cache_control).toEqual({ type: 'ephemeral' });
    expect(contract.images.every((image) => !image.marked)).toBe(true);
    expect(countCacheControlMarkers(new TextEncoder().encode(cap.main[0]!.body))).toBe(
      countCacheControlMarkers(new TextEncoder().encode(input)),
    );
  });

  it('CACHE-STABLE: project images/ref/manifest/prefix ignore live-prompt changes', async () => {
    const project = largeProjectGuidance('same');
    const run1 = await driveAnthropicWithInfo(anthropicProjectBody({
      projectGuidance: project,
      liveText: 'first live request',
    }));
    run1.cap.restore();
    const run2 = await driveAnthropicWithInfo(anthropicProjectBody({
      projectGuidance: project,
      liveText: 'different live request with volatile environment observations',
    }));
    run2.cap.restore();

    const a = projectContract(run1.cap.main[0]!.body, run1.info);
    const b = projectContract(run2.cap.main[0]!.body, run2.info);
    expect(b.ref).toBe(a.ref);
    expect(b.images).toEqual(a.images);
    expect(b.manifest).toBe(a.manifest);
    expect(b.boundary).toBe(a.boundary);
    expect(run1.info.cachePrefixSha8).toMatch(/^[0-9a-f]{8}$/);
    expect(run2.info.cachePrefixSha8).toBe(run1.info.cachePrefixSha8);
  });

  it('APPEND-ONLY: frozen history images stay byte-identical when growth advances the collapse window', async () => {
    // No slab (every image is a history page). 30 turns collapses a small
    // window; 120 turns advances the boundary and emits MORE pages. The earlier
    // pages must render identical bytes so Anthropic cache_reads the prefix.
    // NB: Anthropic's LAST history image is partial (it absorbs content as the
    // boundary moves), so the invariant is "all-but-last pages are a byte-
    // identical prefix" — not the whole list (that's the GPT sealed-section rule).
    const cap1 = await driveAnthropic(anthropicBody({ turns: turns(30, 4000) }));
    cap1.restore();
    const cap2 = await driveAnthropic(anthropicBody({ turns: turns(120, 4000) }));
    cap2.restore();

    const a = anthropicImages(cap1.main[0]!.body).map((i) => i.data);
    const b = anthropicImages(cap2.main[0]!.body).map((i) => i.data);
    expect(a.length).toBeGreaterThan(1);
    expect(b.length).toBeGreaterThan(a.length); // boundary advanced → pages appended
    expect(b[0]).toBe(a[0]); // the frozen prefix anchor never re-renders
    // Empirically (this path, dense char-packed images) the LAST page is partial:
    // it absorbs more content as the boundary advances, so it legitimately differs.
    // Earlier pages must be a byte-identical prefix. (GPT's sealed sections are
    // stricter — see the GPT append-only test, which asserts the FULL prefix.)
    expect(b.slice(0, a.length - 1)).toEqual(a.slice(0, a.length - 1));
    // Native system context contributes no movable image anchor; input had 0 markers.
    // (plain-string system), so the proxy must not invent one.
    expect(countCacheControlMarkers(new TextEncoder().encode(cap1.main[0]!.body))).toBe(0);
  });

  it('CARRY-OVER (#11): finds frozen history pages by banner after a protected project prefix', async () => {
    const project = largeProjectGuidance('history-prefix');
    const run1 = await driveAnthropicWithInfo(anthropicProjectBody({
      projectGuidance: project,
      turns: turns(80, 4000),
    }));
    run1.cap.restore();
    const run2 = await driveAnthropicWithInfo(anthropicProjectBody({
      projectGuidance: project,
      turns: turns(200, 4000),
    }));
    run2.cap.restore();

    const imgs1 = anthropicHistoryImages(run1.cap.main[0]!.body);
    const imgs2 = anthropicHistoryImages(run2.cap.main[0]!.body);
    expect(imgs1.length).toBeGreaterThan(1);
    expect(imgs2.length).toBeGreaterThan(imgs1.length);
    // The final page can still grow; every earlier frozen history page is stable.
    expect(imgs2.slice(0, imgs1.length - 1)).toEqual(imgs1.slice(0, imgs1.length - 1));
    expect(run1.info.historyImageSha).toBe(await sha8(imgs1.map((image) => image.data).join('')));
    expect(run2.info.historyImageSha).toBe(await sha8(imgs2.map((image) => image.data).join('')));
    expect(projectContract(run2.cap.main[0]!.body, run2.info).ref).toBe(
      projectContract(run1.cap.main[0]!.body, run1.info).ref,
    );
  });

  it('history collapse preserves caller marker ownership and keeps history pages unmarked', async () => {
    const input = anthropicProjectBody({ turns: turns(120, 4000) });
    const run = await driveAnthropicWithInfo(input);
    run.cap.restore();

    expect(run.info.historyReason).toBe('collapsed');
    const historyImages = anthropicHistoryImages(run.cap.main[0]!.body);
    expect(historyImages.length).toBeGreaterThan(0);
    expect(historyImages.every((image) => !image.marked)).toBe(true);
    expect(projectContract(run.cap.main[0]!.body, run.info).images.every((image) => !image.marked)).toBe(true);
    expect(countCacheControlMarkers(new TextEncoder().encode(run.cap.main[0]!.body))).toBe(
      countCacheControlMarkers(new TextEncoder().encode(input)),
    );
    const forwarded = JSON.parse(run.cap.main[0]!.body) as MessagesRequest;
    const syntheticIndex = forwarded.messages.findIndex(
      (message) =>
        Array.isArray(message.content) &&
        message.content[0]?.type === 'text' &&
        message.content[0].text === HISTORY_SYNTHETIC_INTRO,
    );
    expect(syntheticIndex).toBeGreaterThan(1);
  });

  it('RUNTIME SPLIT: volatile reminder siblings never re-render project pages or prefix', async () => {
    const project = largeProjectGuidance('runtime-stable');
    const run1 = await driveAnthropicWithInfo(anthropicProjectBody({
      projectGuidance: project,
      email: 'clean@example.invalid',
      date: '2026-07-10',
    }));
    run1.cap.restore();
    const run2 = await driveAnthropicWithInfo(anthropicProjectBody({
      projectGuidance: project,
      email: 'modified@example.invalid',
      date: '2026-07-11',
    }));
    run2.cap.restore();

    const a = projectContract(run1.cap.main[0]!.body, run1.info);
    const b = projectContract(run2.cap.main[0]!.body, run2.info);
    expect(b.ref).toBe(a.ref);
    expect(b.images).toEqual(a.images);
    expect(b.manifest).toBe(a.manifest);
    expect(run2.info.cachePrefixSha8).toBe(run1.info.cachePrefixSha8);
    const forwarded = JSON.parse(run2.cap.main[0]!.body) as MessagesRequest;
    const reminderText = forwarded.messages
      .filter((message) => Array.isArray(message.content))
      .flatMap((message) => message.content as ContentBlock[])
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .find((text) => text.includes('# currentDate'));
    expect(reminderText).toContain('# userEmail\nmodified@example.invalid');
    expect(reminderText).toContain("# currentDate\nToday's date is 2026-07-11.");
  });

  it('FIRST COLLAPSE: protected project contract/prefix stay stable before a frozen history chunk', async () => {
    const project = largeProjectGuidance('first-collapse');
    const body1 = anthropicProjectBody({ projectGuidance: project, turns: turns(15, 4000) });
    const run1 = await driveAnthropicWithInfo(body1);
    run1.cap.restore();
    const body2 = anthropicProjectBody({ projectGuidance: project, turns: turns(17, 4000) });
    const run2 = await driveAnthropicWithInfo(body2);
    run2.cap.restore();

    const contract1 = projectContract(run1.cap.main[0]!.body, run1.info);
    const contract2 = projectContract(run2.cap.main[0]!.body, run2.info);
    for (const [run, input, contract] of [
      [run1, body1, contract1],
      [run2, body2, contract2],
    ] as const) {
      expect(run.info.historyReason).toBe('collapsed');
      expect(anthropicHistoryImages(run.cap.main[0]!.body).length).toBeGreaterThan(0);
      expect(anthropicHistoryImages(run.cap.main[0]!.body).every((image) => !image.marked)).toBe(true);
      expect(contract.images.every((image) => !image.marked)).toBe(true);
      expect(countCacheControlMarkers(new TextEncoder().encode(run.cap.main[0]!.body))).toBe(
        countCacheControlMarkers(new TextEncoder().encode(input)),
      );
    }
    expect(contract2.ref).toBe(contract1.ref);
    expect(contract2.images).toEqual(contract1.images);
    expect(contract2.manifest).toBe(contract1.manifest);
    expect(run2.info.cachePrefixSha8).toBe(run1.info.cachePrefixSha8);
  });

  it('GATE: an out-of-scope model is forwarded byte-for-byte untouched (no images)', async () => {
    // claude-3-5-sonnet is NOT in the default PXPIPE_MODELS scope → passthrough.
    const body = anthropicBody({ model: 'claude-3-5-sonnet', slabChars: 80_000, turns: turns(4, 20) });
    const cap = await driveAnthropic(body);
    cap.restore();
    expect(anthropicImages(cap.main[0]!.body)).toHaveLength(0);
    // "untouched" must mean the whole payload, not merely image-free.
    expect(JSON.parse(cap.main[0]!.body)).toEqual(JSON.parse(body));
  });

  it('ROUTING + AUTH: forwards to the configured upstream; only count_tokens side calls (dual probe with a marker)', async () => {
    const cap = await driveAnthropic(anthropicBody({ slabChars: 80_000, turns: turns(4, 20) }));
    // count_tokens is fire-and-forget — give it a tick before asserting.
    await new Promise((r) => setTimeout(r, 30));
    cap.restore();

    expect(cap.main).toHaveLength(1);
    expect(cap.main[0]!.url).toBe('http://anthropic.test/v1/messages');
    expect(cap.main[0]!.apiKey).toBe('sk-ant-test');
    // The body carries a cache_control marker, so BOTH probes fire: the full-body
    // baseline AND the truncated cacheable-prefix probe. Exactly two, both
    // count_tokens, no other side endpoint leaks. A suppressed second probe → red.
    expect(cap.sidePaths).toEqual([
      '/v1/messages/count_tokens',
      '/v1/messages/count_tokens',
    ]);
  });

  it('produces valid JSON with well-formed base64 PNGs on EVERY page', async () => {
    const { cap, info } = await driveAnthropicWithInfo(anthropicProjectBody());
    cap.restore();
    const parsed = JSON.parse(cap.main[0]!.body);
    expect(Array.isArray(parsed.messages)).toBe(true);
    const contract = projectContract(cap.main[0]!.body, info);
    const imgs = contract.images;
    expect(imgs.length).toBeGreaterThan(0);
    // EVERY page must be a real PNG (base64 PNG magic = 'iVBORw0KGgo'), not just
    // the first — a corrupted page 2+ would otherwise slip through.
    expect(imgs.every((i) => i.data.length > 100 && i.data.startsWith('iVBORw0KGgo'))).toBe(true);
  });
});

// ===========================================================================
describe('e2e cache alignment — GPT (OpenAI) through the real proxy', () => {
  function gptChatBody(opts: {
    model?: string;
    systemChars: number;
    turns: { role: 'user' | 'assistant'; text: string }[];
  }): string {
    return JSON.stringify({
      model: opts.model ?? 'gpt-5.6',
      messages: [
        { role: 'system', content: slab(opts.systemChars) },
        ...opts.turns.map((t) => ({ role: t.role, content: t.text })),
      ],
    });
  }

  function gptResponsesBody(opts: {
    systemChars: number;
    turns: { role: 'user' | 'assistant'; text: string }[];
  }): string {
    return JSON.stringify({
      model: 'gpt-5.6',
      instructions: slab(opts.systemChars),
      input: opts.turns.map((t) => ({ role: t.role, content: t.text })),
    });
  }

  async function driveGpt(path: string, body: string, cap = fakeUpstream()) {
    const proxy = createProxy({
      openAIUpstream: 'https://openai.test',
      openAIApiKey: 'sk-openai-test',
      transform: FORCE,
      onRequest: () => {},
    });
    const res = await proxy(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    await res.text();
    return cap;
  }

  it('chat: emits NO cache_control (OpenAI prefix cache is markerless)', async () => {
    const cap = await driveGpt(
      '/v1/chat/completions',
      gptChatBody({ systemChars: 60_000, turns: turns(4, 20) }),
    );
    cap.restore();
    expect(cap.main).toHaveLength(1);
    expect(countCacheControlMarkers(new TextEncoder().encode(cap.main[0]!.body))).toBe(0);
    expect(gptChatImages(cap.main[0]!.body).length).toBeGreaterThan(0);
  });

  it('chat APPEND-ONLY: the imaged prefix is byte-identical as the conversation grows', async () => {
    // Big system → slab images AND (since the slab gate clears) history collapses.
    // The cacheable prefix = [slab image] + [frozen history pages]. Stability comes
    // from sectionTokens-sealed sections keyed by ABSOLUTE turn index (t="N"):
    // earlier turns render identical bytes regardless of how much tail is appended.
    const small = turns(30, 4000);
    const cap1 = await driveGpt('/v1/chat/completions', gptChatBody({ systemChars: 60_000, turns: small }));
    cap1.restore();
    const cap2 = await driveGpt(
      '/v1/chat/completions',
      gptChatBody({ systemChars: 60_000, turns: [...small, ...turns(20, 4000)] }),
    );
    cap2.restore();

    const a = gptChatImages(cap1.main[0]!.body);
    const b = gptChatImages(cap2.main[0]!.body);
    expect(a.length).toBeGreaterThan(1); // slab image + ≥1 sealed history page
    expect(b.length).toBeGreaterThan(a.length); // growth sealed more pages
    // GPT seals whole sections (leftover stays text) → strict prefix append-only.
    expect(b.slice(0, a.length)).toEqual(a);
  });

  it('responses APPEND-ONLY: the imaged prefix is byte-identical as the conversation grows', async () => {
    const small = turns(30, 4000);
    const cap1 = await driveGpt('/v1/responses', gptResponsesBody({ systemChars: 60_000, turns: small }));
    cap1.restore();
    const cap2 = await driveGpt(
      '/v1/responses',
      gptResponsesBody({ systemChars: 60_000, turns: [...small, ...turns(20, 4000)] }),
    );
    cap2.restore();

    const a = gptResponsesImages(cap1.main[0]!.body);
    const b = gptResponsesImages(cap2.main[0]!.body);
    expect(a.length).toBeGreaterThan(1); // slab image + ≥1 sealed history page
    expect(b.length).toBeGreaterThan(a.length); // growth sealed more pages
    expect(b.slice(0, a.length)).toEqual(a);
  });

  it('GATE: an out-of-scope GPT model is forwarded byte-for-byte untouched (no images)', async () => {
    const body = gptChatBody({ model: 'gpt-4o', systemChars: 60_000, turns: turns(4, 20) });
    const cap = await driveGpt('/v1/chat/completions', body);
    cap.restore();
    expect(gptChatImages(cap.main[0]!.body)).toHaveLength(0);
    expect(JSON.parse(cap.main[0]!.body)).toEqual(JSON.parse(body));
  });

  it('ROUTING + AUTH: forwards to the configured OpenAI upstream with the configured key', async () => {
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
