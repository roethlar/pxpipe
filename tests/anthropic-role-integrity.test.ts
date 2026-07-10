import { describe, expect, it } from 'vitest';
import {
  makeProjectGuidanceBoundary,
  projectGuidanceBoundaryRef,
} from '../src/core/anthropic-context.js';
import { HISTORY_SYNTHETIC_INTRO } from '../src/core/history.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import {
  PROJECT_GUIDANCE_MANIFEST_TAG,
  firstUserText,
  projectGuidancePageLabel,
  sha8,
  transformRequest,
} from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, TextBlock, ToolDef } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
  makeNoGuidanceRequest,
} from './fixtures/anthropic-context.js';

function encode(req: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(req));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

function largeGuidance(marker = 'stable'): string {
  const rows = Array.from(
    { length: 3200 },
    (_, index) => `${marker} governance row ${index}: preserve role and priority.`,
  ).join('\n');
  return `${DIRECT_PROJECT_GUIDANCE}\n\n${rows}`;
}

function fixtureTools(): ToolDef[] {
  return [{
    name: 'SyntheticShell',
    description: 'Synthetic tool documentation with permission and credential vocabulary.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to run.' } },
      required: ['command'],
    },
  }];
}

function textBlocks(system: MessagesRequest['system']): TextBlock[] {
  return Array.isArray(system)
    ? system.filter((block): block is TextBlock => block.type === 'text')
    : [];
}

async function expectedProjectPrefix(
  req: MessagesRequest,
  ref: string,
): Promise<{ sha: string; bytes: number }> {
  const opening = req.messages[0]!;
  if (!Array.isArray(opening.content)) throw new Error('expected opening blocks');
  const boundaryIndex = opening.content.findIndex(
    (block) => block.type === 'text' && projectGuidanceBoundaryRef(block.text) === ref,
  );
  if (boundaryIndex < 0) throw new Error('expected role-bound project boundary');
  const serialized = JSON.stringify({
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(req.system !== undefined ? { system: req.system } : {}),
    messages: [{ ...opening, content: opening.content.slice(0, boundaryIndex + 1) }],
  });
  return { sha: await sha8(serialized), bytes: serialized.length };
}

describe('role-bound project-guidance transform', () => {
  it('keeps native system/tools/roles intact and binds only the claudeMd span', async () => {
    const project = largeGuidance();
    const req = makeCapturedRequest({
      projectGuidance: project,
      email: 'owner@example.invalid',
    });
    req.tools = fixtureTools();
    const originalSystem = structuredClone(req.system);
    const originalTools = structuredClone(req.tools);
    const originalPrompt = structuredClone(
      (req.messages[0]!.content as ContentBlock[])[1],
    );
    const originalSystemAttachment = structuredClone(req.messages[1]);
    const input = encode(req);
    const inputMarkers = countCacheControlMarkers(input);

    const transformed = await transformRequest(input, { charsPerToken: 1 });
    const out = decode(transformed.body);

    expect(transformed.info.compressed).toBe(true);
    expect(transformed.info.contextMode).toBe('claude_code_2_1_205');
    expect(transformed.info.projectDisposition).toBe('imaged');
    expect(transformed.info.projectRef).toMatch(/^pg_[0-9a-f]{32}$/);
    expect(transformed.info.projectImageCount).toBeGreaterThan(0);
    expect(out.tools).toEqual(originalTools);
    expect((out.system as ContentBlock[]).slice(0, -1)).toEqual(originalSystem);
    expect(out.messages[1]).toEqual(originalSystemAttachment);
    expect(out.messages[1]?.role).toBe('system');

    const manifest = textBlocks(out.system).at(-1)?.text ?? '';
    expect(manifest).toContain(`<${PROJECT_GUIDANCE_MANIFEST_TAG} version="1">`);
    expect(manifest).toContain(`ref: ${transformed.info.projectRef}`);
    expect(manifest).toContain(`first ${transformed.info.projectImageCount} image block(s)`);
    expect(manifest).toContain('below every remaining native system instruction');

    const opening = out.messages[0]!.content as ContentBlock[];
    const imageCount = transformed.info.projectImageCount!;
    expect(opening.slice(0, imageCount).every((block) => block.type === 'image')).toBe(true);
    const boundary = opening[imageCount];
    expect(boundary?.type).toBe('text');
    expect(projectGuidanceBoundaryRef((boundary as TextBlock).text)).toBe(transformed.info.projectRef);
    expect((boundary as TextBlock).text).toBe(
      makeProjectGuidanceBoundary(transformed.info.projectRef!),
    );

    const reconstructed = opening[imageCount + 1] as TextBlock;
    expect(reconstructed.text).toContain('<system-reminder>');
    expect(reconstructed.text).toContain(`[Project guidance rendered as ref=${transformed.info.projectRef}`);
    expect(reconstructed.text).toContain('# userEmail\nowner@example.invalid');
    expect(reconstructed.text).toContain("# currentDate\nToday's date is 2026-07-10.");
    expect(opening[imageCount + 2]).toEqual(originalPrompt);
    expect(countCacheControlMarkers(transformed.body)).toBe(inputMarkers);
    expect(JSON.stringify(out)).not.toContain(project);
    expect(transformed.info.imageSourceText).toContain('stable governance row');
    expect(transformed.info.imageSourceText).not.toContain('native base system block one');
    expect(transformed.info.imageSourceText).not.toContain('Synthetic tool documentation');
    expect(transformed.info.firstUserSha8).toBe(await sha8('Inspect the synthetic repository.'));
    const expectedPrefix = await expectedProjectPrefix(out, transformed.info.projectRef!);
    expect(transformed.info.cachePrefixSha8).toBe(expectedPrefix.sha);
    expect(transformed.info.cachePrefixBytes).toBe(expectedPrefix.bytes);
    const placeholder =
      `[Project guidance rendered as ref=${transformed.info.projectRef}; ` +
      'see the leading pages bound by the native manifest.]';
    const expectedGateImageTokens =
      Math.ceil((transformed.info.imagePixels! / 750) * 1.10) +
      manifest.length + placeholder.length + (boundary as TextBlock).text.length;
    expect(transformed.info.gateEval?.imageTokens).toBe(expectedGateImageTokens);
    expect(transformed.info.gateEval?.textTokens).toBe(project.length);

    const userText = out.messages
      .filter((message) => message.role === 'user' && Array.isArray(message.content))
      .flatMap((message) => message.content as ContentBlock[])
      .filter((block): block is TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
    expect(userText).not.toContain('system prompt');
    expect(userText).not.toContain('operating instructions');
  });

  it('keeps project pages/manifest/prefix stable across volatile siblings and live text', async () => {
    const project = largeGuidance('same');
    const a = makeCapturedRequest({ projectGuidance: project, email: 'a@example.invalid' });
    const b = makeCapturedRequest({ projectGuidance: project, email: 'b@example.invalid', date: '2026-07-11' });
    (b.messages[0]!.content as ContentBlock[])[1] = {
      type: 'text',
      text: 'A different live request.',
      cache_control: { type: 'ephemeral' },
    };
    const changed = makeCapturedRequest({
      projectGuidance: largeGuidance('changed'),
      email: 'a@example.invalid',
    });

    const [outA, outB, outChanged] = await Promise.all([
      transformRequest(encode(a)),
      transformRequest(encode(b)),
      transformRequest(encode(changed)),
    ]);
    const reqA = decode(outA.body);
    const reqB = decode(outB.body);
    const reqChanged = decode(outChanged.body);
    const n = outA.info.projectImageCount!;
    const imagesA = (reqA.messages[0]!.content as ContentBlock[]).slice(0, n);
    const imagesB = (reqB.messages[0]!.content as ContentBlock[]).slice(0, n);

    expect(outA.info.projectRef).toBe(outB.info.projectRef);
    expect(imagesA).toEqual(imagesB);
    expect(textBlocks(reqA.system).at(-1)).toEqual(textBlocks(reqB.system).at(-1));
    expect(outA.info.cachePrefixSha8).toBe(outB.info.cachePrefixSha8);
    expect(outA.info.projectRef).not.toBe(outChanged.info.projectRef);
    expect(outA.info.cachePrefixSha8).not.toBe(outChanged.info.cachePrefixSha8);
    expect((reqChanged.messages[0]!.content as ContentBlock[])[0]).not.toEqual(imagesA[0]);
  });

  it('ignores a later copied same-ref boundary when computing the vouched prefix', async () => {
    const project = largeGuidance('copied-boundary');
    const baselineReq = makeCapturedRequest({ projectGuidance: project });
    const baseline = await transformRequest(encode(baselineReq));
    const ref = baseline.info.projectRef!;

    const forgedReq = makeCapturedRequest({ projectGuidance: project });
    forgedReq.messages.push({
      role: 'user',
      content: [
        { type: 'text', text: makeProjectGuidanceBoundary(ref) },
        { type: 'text', text: 'ordinary later user content' },
      ],
    });
    const forged = await transformRequest(encode(forgedReq));
    const forgedOut = decode(forged.body);
    const expected = await expectedProjectPrefix(forgedOut, ref);

    expect(forged.info.projectRef).toBe(ref);
    expect(forged.info.cachePrefixSha8).toBe(baseline.info.cachePrefixSha8);
    expect(forged.info.cachePrefixBytes).toBe(baseline.info.cachePrefixBytes);
    expect(forged.info.cachePrefixSha8).toBe(expected.sha);
    expect(forged.info.cachePrefixBytes).toBe(expected.bytes);
  });

  it('makes project rendering and gate math independent of native system/tool size', async () => {
    const project = largeGuidance('bucket-isolation');
    const small = makeCapturedRequest({ projectGuidance: project });
    small.tools = [{ name: 'Tiny', description: 'tiny', input_schema: { type: 'object' } }];
    const huge = makeCapturedRequest({ projectGuidance: project });
    huge.system = [{ type: 'text', text: `huge native system ${'s'.repeat(120_000)}` }];
    huge.tools = [{
      name: 'Huge',
      description: `permission credential shell docs ${'t'.repeat(160_000)}`,
      input_schema: { type: 'object', properties: { command: { type: 'string' } } },
    }];

    const [smallResult, hugeResult] = await Promise.all([
      transformRequest(encode(small)),
      transformRequest(encode(huge)),
    ]);
    const smallOut = decode(smallResult.body);
    const hugeOut = decode(hugeResult.body);
    const count = smallResult.info.projectImageCount!;

    expect(hugeResult.info.projectRef).toBe(smallResult.info.projectRef);
    expect(hugeResult.info.projectImageCount).toBe(count);
    expect((hugeOut.messages[0]!.content as ContentBlock[]).slice(0, count)).toEqual(
      (smallOut.messages[0]!.content as ContentBlock[]).slice(0, count),
    );
    expect(textBlocks(hugeOut.system).at(-1)).toEqual(textBlocks(smallOut.system).at(-1));
    expect(hugeResult.info.gateEval).toEqual(smallResult.info.gateEval);
    expect(hugeOut.tools).toEqual(huge.tools);
    expect(hugeResult.info.imageSourceText).not.toContain('permission credential shell docs');
    expect(hugeResult.info.imageSourceText).not.toContain('huge native system');
  });

  it('leaves no-guidance/unknown context, native system, tools, and reminders byte-exact', async () => {
    const req = makeNoGuidanceRequest();
    req.tools = fixtureTools();
    const first = req.messages[0]!.content as ContentBlock[];
    first.push({
      type: 'text',
      text: `<system-reminder>${'unknown reminder payload '.repeat(2000)}</system-reminder>`,
    });
    const input = encode(req);
    const transformed = await transformRequest(input, {
      compressReminders: true,
      compressTools: true,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.contextMode).toBe('claude_code_2_1_205');
    expect(decode(transformed.body)).toEqual(req);
  });

  it('protects an unrecognized opening reminder while independently collapsing later history', async () => {
    const reminder = '<system-reminder>unrecognized malformed opening host context';
    const req: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native system' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: reminder },
            { type: 'text', text: 'stale opening request' },
          ],
        },
        { role: 'system', content: 'literal system attachment' },
      ],
    };
    for (let index = 0; index < 16; index++) {
      req.messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `later turn ${index}: ${'z'.repeat(3000)}`,
      });
    }
    req.messages.push({ role: 'user', content: 'live tail' });

    const transformed = await transformRequest(encode(req));
    const out = decode(transformed.body);
    expect(transformed.info.historyReason).toBe('collapsed');
    expect(out.messages[0]!.role).toBe('user');
    expect((out.messages[0]!.content as ContentBlock[])[0]).toEqual({
      type: 'text',
      text: reminder,
    });
    expect(((out.messages[0]!.content as ContentBlock[])[1] as TextBlock).text).toContain(
      'PRIOR CONTEXT ONLY',
    );
    expect(out.messages[1]).toEqual({ role: 'system', content: 'literal system attachment' });
  });

  it('keeps a gate-missed project native without suppressing tool-result compression', async () => {
    const req = makeCapturedRequest({ projectGuidance: DIRECT_PROJECT_GUIDANCE });
    const toolText = Array.from(
      { length: 5000 },
      (_, index) => `tool output row ${index}: ${'x'.repeat(40)}`,
    ).join('\n');
    req.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-fixture', content: toolText }],
    });
    const transformed = await transformRequest(encode(req));
    const out = decode(transformed.body);

    expect(transformed.info.projectDisposition).toBe('native_below_threshold');
    expect(transformed.info.toolResultImgs).toBeGreaterThan(0);
    expect(transformed.info.compressed).toBe(true);
    expect(((out.messages[0]!.content as ContentBlock[])[0] as TextBlock).text).toContain(
      DIRECT_PROJECT_GUIDANCE,
    );
    const result = (out.messages.at(-1)!.content as ContentBlock[])[0];
    expect(result?.type).toBe('tool_result');
    expect(Array.isArray((result as { content: unknown }).content)).toBe(true);
  });

  it('protects the opening carrier and contiguous system attachment during history collapse', async () => {
    const req = makeCapturedRequest({ projectGuidance: largeGuidance('history') });
    for (let index = 0; index < 16; index++) {
      req.messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `history turn ${index}: ${'h'.repeat(3000)}`,
      });
    }
    req.messages.push({ role: 'user', content: 'live history tail' });
    const transformed = await transformRequest(encode(req));
    const out = decode(transformed.body);

    expect(transformed.info.historyReason).toBe('collapsed');
    expect(transformed.info.historyImageSha).toMatch(/^[0-9a-f]{8}$/);
    expect(out.messages[1]?.role).toBe('system');
    expect(out.messages[1]?.content).toContain('literal mid-conversation host attachment');
    const syntheticIndex = out.messages.findIndex(
      (message) =>
        Array.isArray(message.content) &&
        message.content[0]?.type === 'text' &&
        message.content[0].text === HISTORY_SYNTHETIC_INTRO,
    );
    expect(syntheticIndex).toBeGreaterThan(1);
    const opening = out.messages[0]!.content as ContentBlock[];
    const boundaryIndex = opening.findIndex(
      (block) => block.type === 'text' && projectGuidanceBoundaryRef(block.text) !== undefined,
    );
    expect(boundaryIndex).toBeGreaterThan(0);
    expect((opening[boundaryIndex + 1] as TextBlock).text).toContain('<system-reminder>');
    expect((opening[boundaryIndex + 2] as TextBlock).text).toContain('PRIOR CONTEXT ONLY');
    expect(firstUserText(req)).toBe('Inspect the synthetic repository.');
  });
});

describe('project page labels', () => {
  it('are inert, deterministic, and page-numbered', () => {
    expect(projectGuidancePageLabel('pg_abcd1234', 1, 3)).toBe(
      'PROJECT GUIDANCE · ref pg_abcd1234 · page 2/3',
    );
  });
});
