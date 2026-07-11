import { describe, expect, it } from 'vitest';
import { validateAnthropicMessageStructure } from '../src/core/admission.js';
import { partitionAnthropicContext } from '../src/core/anthropic-context.js';
import { compareNoHijack, type ExactSpanImageReplacement } from '../src/core/no-hijack.js';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type {
  ContentBlock,
  ImageBlock,
  MessagesRequest,
  TextBlock,
  ToolDef,
} from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
  makeNoGuidanceRequest,
} from './fixtures/anthropic-context.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function encode(req: MessagesRequest): Uint8Array {
  return enc.encode(JSON.stringify(req));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(dec.decode(body)) as MessagesRequest;
}

function largeGuidance(marker = 'stable'): string {
  const rows = Array.from(
    { length: 2400 },
    (_, index) => `${marker} governance row ${index}: preserve role and priority.`,
  ).join('\n');
  return `${DIRECT_PROJECT_GUIDANCE}\n\n${rows}`;
}

function fixtureTools(): ToolDef[] {
  return [{
    name: 'SyntheticShell',
    description: 'Synthetic tool documentation. '.repeat(500),
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to run.' } },
      required: ['command'],
    },
  }];
}

function projectDescriptor(
  replacements: readonly ExactSpanImageReplacement[],
): ExactSpanImageReplacement {
  const descriptor = replacements.find(
    (replacement) => replacement.target.kind === 'message_text_block',
  );
  expect(descriptor).toBeDefined();
  return descriptor!;
}

function assertExactProjectReplacement(
  original: MessagesRequest,
  candidate: MessagesRequest,
  descriptor: ExactSpanImageReplacement,
): { prefix: string; suffix: string; parts: ContentBlock[] } {
  expect(descriptor.target.kind).toBe('message_text_block');
  if (descriptor.target.kind !== 'message_text_block') {
    throw new Error('expected project message-text descriptor');
  }

  const beforeMessage = original.messages[descriptor.target.messageIndex]!;
  const afterMessage = candidate.messages[descriptor.target.messageIndex]!;
  expect(beforeMessage.role).toBe('user');
  expect(afterMessage.role).toBe(beforeMessage.role);
  expect(Array.isArray(beforeMessage.content)).toBe(true);
  expect(Array.isArray(afterMessage.content)).toBe(true);
  const beforeContent = beforeMessage.content as ContentBlock[];
  const afterContent = afterMessage.content as ContentBlock[];
  const sourceBlock = beforeContent[descriptor.target.originalBlockIndex] as TextBlock;
  expect(sourceBlock.type).toBe('text');
  expect(sourceBlock.text.slice(descriptor.start, descriptor.end)).toBe(descriptor.expectedText);

  const prefix = sourceBlock.text.slice(0, descriptor.start);
  const suffix = sourceBlock.text.slice(descriptor.end);
  const replacementLength =
    (prefix.length > 0 ? 1 : 0) + descriptor.imageCount + (suffix.length > 0 ? 1 : 0);
  const start = descriptor.target.candidateStartIndex;
  const parts = afterContent.slice(start, start + replacementLength);
  const imageStart = prefix.length > 0 ? 1 : 0;
  const images = parts.slice(imageStart, imageStart + descriptor.imageCount);

  expect(afterContent.slice(0, start)).toEqual(
    beforeContent.slice(0, descriptor.target.originalBlockIndex),
  );
  expect(afterContent.slice(start + replacementLength)).toEqual(
    beforeContent.slice(descriptor.target.originalBlockIndex + 1),
  );
  if (prefix) expect(parts[0]).toEqual({ type: 'text', text: prefix });
  expect(images).toHaveLength(descriptor.imageCount);
  expect(images.every((block) => block.type === 'image')).toBe(true);
  expect(images.every((block) =>
    (block as ImageBlock).source.media_type === 'image/png'
    && (block as ImageBlock).source.data.startsWith('iVBORw0KGgo'))).toBe(true);
  if (suffix) {
    const suffixBlock = parts.at(-1) as TextBlock;
    expect(suffixBlock.type).toBe('text');
    expect(suffixBlock.text).toBe(suffix);
  }
  return { prefix, suffix, parts };
}

function expectNoProxyProse(req: MessagesRequest): void {
  const wire = JSON.stringify(req);
  expect(wire).not.toContain('pxpipe_project_guidance_manifest');
  expect(wire).not.toContain('pxpipe_runtime_context_manifest');
  expect(wire).not.toContain('PXPIPE RUNTIME CONTEXT');
  expect(wire).not.toContain('[Project guidance rendered');
  expect(wire).not.toContain('[End of rendered');
  expect(wire).not.toContain('[Earlier conversation rendered');
  expect(wire).not.toContain('[Exact identifiers from the rendered context');
}

describe('Anthropic safe project-guidance candidate', () => {
  it('changes only the exact project span and keeps system, tools, roles, and runtime bytes native', async () => {
    const req = makeCapturedRequest({
      projectGuidance: largeGuidance(),
      email: 'owner@example.invalid',
      date: '2026-07-10',
    });
    req.tools = fixtureTools();
    const original = structuredClone(req);
    const input = encode(req);
    const built = await buildAnthropicCandidate(input, { minCompressChars: 1 });
    const out = decode(built.body);

    expect(built.info.compressed).toBe(true);
    expect(built.info.projectDisposition).toBe('imaged');
    expect(built.info.toolMode).toBe('native');
    expect(built.info.toolDisposition).toBe('native_default');
    expect(built.info.runtimeMetadataDisposition).toBeUndefined();
    expect(built.info.historyReason).toBeUndefined();
    expect(built.info.imageSourceText).toBeUndefined();
    expect(built.info.recoverable).toBeUndefined();
    expect(out.system).toEqual(original.system);
    expect(out.tools).toEqual(original.tools);
    expect(out.messages.slice(1)).toEqual(original.messages.slice(1));

    const descriptor = projectDescriptor(built.replacements);
    const replacement = assertExactProjectReplacement(original, out, descriptor);
    expect(replacement.prefix).toContain('<system-reminder>');
    expect(replacement.suffix).toContain(
      "# userEmail\nThe user's email address is owner@example.invalid.",
    );
    expect(replacement.suffix).toContain("# currentDate\nToday's date is 2026-07-10.");
    expect(replacement.suffix).toContain('</system-reminder>');
    expect(replacement.suffix).not.toContain('PXPIPE RUNTIME CONTEXT');

    const contract = compareNoHijack('anthropic', original, out, built.replacements);
    expect(contract.ok).toBe(true);
    expect(contract.added).toEqual([]);
    expect(contract.moved).toEqual([]);
    expect(contract.forbiddenProse).toEqual([]);
    expect(countCacheControlMarkers(built.body)).toBe(countCacheControlMarkers(input));
    expect(validateAnthropicMessageStructure(out)).toEqual({ valid: true });
    expectNoProxyProse(out);
  });

  it('keeps the opening carrier marker on the final exact replacement part', async () => {
    const req = makeCapturedRequest({
      projectGuidance: largeGuidance('marked'),
      email: 'marked@example.invalid',
    });
    const opening = req.messages[0]!.content as ContentBlock[];
    opening[0] = {
      ...(opening[0] as TextBlock),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    };
    const original = structuredClone(req);
    const input = encode(req);
    const built = await buildAnthropicCandidate(input, { minCompressChars: 1 });
    const out = decode(built.body);
    const descriptor = projectDescriptor(built.replacements);
    const { parts } = assertExactProjectReplacement(original, out, descriptor);

    expect(parts.slice(0, -1).every(
      (part) => (part as { cache_control?: unknown }).cache_control === undefined,
    )).toBe(true);
    expect((parts.at(-1) as TextBlock).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(countCacheControlMarkers(built.body)).toBe(countCacheControlMarkers(input));
    expect(compareNoHijack('anthropic', original, out, built.replacements).ok).toBe(true);
  });

  it('does not let legacy flags reactivate tool, reminder, runtime, or history rewrites', async () => {
    const req = makeCapturedRequest({
      projectGuidance: largeGuidance('legacy-flags'),
      email: 'flags@example.invalid',
      date: '2026-07-11',
    });
    req.tools = fixtureTools();
    req.messages.push({
      role: 'user',
      content: `<system-reminder>${'generic host reminder '.repeat(2000)}</system-reminder>`,
    });
    for (let index = 0; index < 20; index++) {
      req.messages.push({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `history turn ${index}: ${'history '.repeat(1000)}`,
      });
    }
    const original = structuredClone(req);
    const built = await buildAnthropicCandidate(encode(req), {
      minCompressChars: 1,
      compressTools: true,
      compressReminders: true,
      collapseHistory: true,
      historyAmortizationHorizon: 50,
      priorWarmTokens: 1_000_000,
      priorWarmImageTokens: 1_000_000,
      reflow: true,
      multiCol: 4,
      emitRecoverable: true,
    });
    const out = decode(built.body);

    expect(built.replacements).toHaveLength(1);
    expect(projectDescriptor(built.replacements).target.kind).toBe('message_text_block');
    expect(out.system).toEqual(original.system);
    expect(out.tools).toEqual(original.tools);
    expect(out.messages.slice(1)).toEqual(original.messages.slice(1));
    expect(out.messages.map((message) => message.role)).toEqual(
      original.messages.map((message) => message.role),
    );
    expect(built.info.toolMode).toBe('native');
    expect(built.info.toolDisposition).toBe('native_default');
    expect(built.info.runtimeMetadataDisposition).toBeUndefined();
    expect(built.info.historyReason).toBeUndefined();
    expect(built.info.recoverable).toBeUndefined();
    expect(compareNoHijack('anthropic', original, out, built.replacements).ok).toBe(true);
    expect(validateAnthropicMessageStructure(out)).toEqual({ valid: true });
    expectNoProxyProse(out);
  });

  it('returns the exact original bytes when no safe source span exists', async () => {
    const req = makeNoGuidanceRequest();
    req.tools = fixtureTools();
    req.messages.push({
      role: 'user',
      content: `<system-reminder>${'ordinary reminder '.repeat(2000)}</system-reminder>`,
    });
    const input = encode(req);
    const built = await buildAnthropicCandidate(input, {
      minCompressChars: 1,
      compressTools: true,
      compressReminders: true,
      collapseHistory: true,
    });

    expect(built.body).toBe(input);
    expect(built.info.compressed).toBe(false);
    expect(built.replacements).toEqual([]);
    expect(built.changedSpans).toEqual([]);
    expect(decode(built.body)).toEqual(req);
  });

  it('preserves the reported system-before-assistant sequence while long history stays native', async () => {
    const req = makeCapturedRequest({ projectGuidance: largeGuidance('role-order') });
    for (let index = 0; index < 24; index++) {
      req.messages.push({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `long history ${index}: ${'h'.repeat(3000)}`,
      });
    }
    req.messages.push({ role: 'user', content: 'live history tail' });
    const original = structuredClone(req);
    const built = await buildAnthropicCandidate(encode(req), {
      minCompressChars: 1,
      collapseHistory: true,
      historyAmortizationHorizon: 100,
    });
    const out = decode(built.body);

    expect(original.messages[1]?.role).toBe('system');
    expect(original.messages[2]?.role).toBe('assistant');
    expect(out.messages[1]).toEqual(original.messages[1]);
    expect(out.messages[2]).toEqual(original.messages[2]);
    expect(out.messages.slice(1)).toEqual(original.messages.slice(1));
    expect(out.messages).toHaveLength(original.messages.length);
    expect(JSON.stringify(out)).not.toContain('[Earlier conversation rendered');
    expect(validateAnthropicMessageStructure(out)).toEqual({ valid: true });
    expect(compareNoHijack('anthropic', original, out, built.replacements).ok).toBe(true);
  });
});
