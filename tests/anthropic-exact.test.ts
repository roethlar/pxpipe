import { describe, expect, it } from 'vitest';
import {
  applyAnthropicExactImageReplacements,
  replaceAnthropicToolResultTextWithImages,
  replaceAnthropicUserTextSpanWithImages,
} from '../src/core/anthropic-exact.js';
import {
  CLAUDE_CODE_2_1_205_SOURCE,
  partitionAnthropicContext,
  type ProjectGuidanceSegment,
} from '../src/core/anthropic-context.js';
import { compareNoHijack } from '../src/core/no-hijack.js';
import type {
  ContentBlock,
  ImageBlock,
  MessagesRequest,
  TextBlock,
  ToolResultBlock,
} from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

function image(data: string): ImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function projectSource(
  text: string,
  start: number,
  end: number,
  messageIndex = 0,
  blockIndex = 0,
): ProjectGuidanceSegment {
  return {
    kind: 'project_guidance',
    source: CLAUDE_CODE_2_1_205_SOURCE,
    locator: { messageIndex, blockIndex, start, end },
    text: text.slice(start, end),
  };
}

function contentAt(request: MessagesRequest, messageIndex = 0): ContentBlock[] {
  const content = request.messages[messageIndex]!.content;
  if (!Array.isArray(content)) throw new Error('expected content blocks');
  return content;
}

describe('exact Anthropic user-span splice', () => {
  it('keeps exact carrier prefix/suffix adjacent and moves its marker only to the final part', () => {
    const request = makeCapturedRequest({
      projectGuidance: DIRECT_PROJECT_GUIDANCE,
      email: 'owner@example.invalid',
      date: '2026-07-10',
    });
    request.model = 'claude-fable-5';
    const opening = contentAt(request)[0] as TextBlock;
    opening.cache_control = { type: 'ephemeral', ttl: '1h' };
    const source = partitionAnthropicContext(request).projectGuidance;
    expect(source).toBeDefined();
    const before = structuredClone(request);
    const images = deepFreeze([image('page-a'), image('page-b')]);
    deepFreeze(request);

    const result = replaceAnthropicUserTextSpanWithImages({
      request,
      source: source!,
      images,
      id: 'project',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    expect(request).toEqual(before);
    expect(images.every((part) => part.cache_control === undefined)).toBe(true);
    const output = contentAt(result.request);
    expect(output[0]).toEqual({
      type: 'text',
      text: opening.text.slice(0, source!.locator.start),
    });
    expect(output[1]).toEqual(image('page-a'));
    expect(output[2]).toEqual(image('page-b'));
    expect(output[3]).toEqual({
      type: 'text',
      text: opening.text.slice(source!.locator.end),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    expect(output[4]).toBe(contentAt(request)[1]);
    expect(result.changedSpan).toEqual({ messageIndex: 0, blockIndex: 0 });
    expect(result.descriptor).toMatchObject({
      id: 'project',
      target: {
        kind: 'message_text_block',
        messageIndex: 0,
        originalBlockIndex: 0,
        candidateStartIndex: 0,
      },
      start: source!.locator.start,
      end: source!.locator.end,
      expectedText: source!.text,
      imageCount: 2,
    });
    const comparison = compareNoHijack(
      'anthropic',
      request,
      result.request,
      [result.descriptor],
    );
    expect(comparison.ok).toBe(true);
    expect(comparison.replacements).toEqual([{ id: 'project', accepted: true }]);
  });

  it('fails with the exact original object for wrong provenance, source bytes, shapes, images, or indices', () => {
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'before PROJECT after' }],
      }],
    };
    const source = projectSource('before PROJECT after', 7, 14);

    const wrongProvenance = {
      ...source,
      source: 'untrusted_source',
    } as unknown as ProjectGuidanceSegment;
    const wrongBytes = { ...source, text: 'NOT PROJECT' };
    const badIndex = {
      ...source,
      locator: { ...source.locator, blockIndex: 0.5 },
    } as ProjectGuidanceSegment;
    const unsupported = structuredClone(request);
    (contentAt(unsupported)[0] as unknown as Record<string, unknown>).citation = 'extra';
    const markedImage = {
      ...image('page'),
      cache_control: { type: 'ephemeral' },
    } as ImageBlock;

    const cases = [
      {
        request,
        result: replaceAnthropicUserTextSpanWithImages({
          request, source: wrongProvenance, images: [image('page')], id: 'x',
        }),
        reason: 'wrong_source',
      },
      {
        request,
        result: replaceAnthropicUserTextSpanWithImages({
          request, source: wrongBytes, images: [image('page')], id: 'x',
        }),
        reason: 'wrong_source',
      },
      {
        request,
        result: replaceAnthropicUserTextSpanWithImages({
          request, source: badIndex, images: [image('page')], id: 'x',
        }),
        reason: 'ambiguous_indices',
      },
      {
        request: unsupported,
        result: replaceAnthropicUserTextSpanWithImages({
          request: unsupported, source, images: [image('page')], id: 'x',
        }),
        reason: 'unsupported_shape',
      },
      {
        request,
        result: replaceAnthropicUserTextSpanWithImages({
          request, source, images: [], id: 'x',
        }),
        reason: 'empty_images',
      },
      {
        request,
        result: replaceAnthropicUserTextSpanWithImages({
          request, source, images: [markedImage], id: 'x',
        }),
        reason: 'unsupported_shape',
      },
    ];

    for (const testCase of cases) {
      const before = structuredClone(testCase.request);
      expect(testCase.result).toMatchObject({ ok: false, reason: testCase.reason });
      expect(testCase.result.request).toBe(testCase.request);
      expect(testCase.request).toEqual(before);
    }
  });
});

describe('exact Anthropic tool_result splice', () => {
  it('replaces a complete successful string inside the same container and preserves every sibling/key', () => {
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_string',
            content: 'complete tool output',
            is_error: false,
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
          { type: 'text', text: 'after' },
        ],
      }],
    };
    const originalBlocks = contentAt(request);
    const originalTool = originalBlocks[1] as ToolResultBlock;
    const originalKeys = Object.keys(originalTool);
    const before = structuredClone(request);
    deepFreeze(request);

    const result = replaceAnthropicToolResultTextWithImages({
      request,
      source: {
        kind: 'tool_result_string',
        messageIndex: 0,
        blockIndex: 1,
        expectedText: 'complete tool output',
      },
      images: [image('tool-a'), image('tool-b')],
      id: 'tool-string',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    expect(request).toEqual(before);
    const output = contentAt(result.request);
    expect(output[0]).toBe(originalBlocks[0]);
    expect(output[2]).toBe(originalBlocks[2]);
    const tool = output[1] as ToolResultBlock;
    expect(Object.keys(tool)).toEqual(originalKeys);
    expect({ ...tool, content: originalTool.content }).toEqual(originalTool);
    expect(tool.content).toEqual([image('tool-a'), image('tool-b')]);
    expect(result.changedSpan).toEqual({ messageIndex: 0, blockIndex: 1 });
    expect(compareNoHijack('anthropic', request, result.request, [result.descriptor]).ok)
      .toBe(true);
  });

  it('replaces one complete text part, keeps inner order, and moves only that part marker', () => {
    const trailing = image('already-present');
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_parts',
          is_error: false,
          cache_control: { type: 'ephemeral', ttl: '1h' },
          content: [
            { type: 'text', text: 'head' },
            {
              type: 'text',
              text: 'exact selected part',
              cache_control: { type: 'ephemeral', ttl: '5m' },
            },
            trailing,
          ],
        }],
      }],
    };

    const result = replaceAnthropicToolResultTextWithImages({
      request,
      source: {
        kind: 'tool_result_text_part',
        messageIndex: 0,
        blockIndex: 0,
        partIndex: 1,
        expectedText: 'exact selected part',
      },
      images: [image('part-a'), image('part-b')],
      id: 'tool-part',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const tool = contentAt(result.request)[0] as ToolResultBlock;
    expect(tool.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(tool.content).toEqual([
      { type: 'text', text: 'head' },
      image('part-a'),
      {
        ...image('part-b'),
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
      trailing,
    ]);
    expect(result.changedSpan).toEqual({
      messageIndex: 0,
      blockIndex: 0,
      toolResultPartIndex: 1,
    });
    expect(compareNoHijack('anthropic', request, result.request, [result.descriptor]).ok)
      .toBe(true);
  });

  it('fails native for error results, partial/wrong source, unsupported keys, empty images, or ambiguous parts', () => {
    const base = (): MessagesRequest => ({
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_failure',
          content: 'complete output',
        }],
      }],
    });
    const run = (
      request: MessagesRequest,
      source: Parameters<typeof replaceAnthropicToolResultTextWithImages>[0]['source'],
      images: ImageBlock[] = [image('page')],
    ) => replaceAnthropicToolResultTextWithImages({ request, source, images, id: 'tool' });

    const errored = base();
    (contentAt(errored)[0] as ToolResultBlock).is_error = true;
    const unsupported = base();
    (contentAt(unsupported)[0] as unknown as Record<string, unknown>).extra = true;
    const arrayContent = base();
    (contentAt(arrayContent)[0] as ToolResultBlock).content = [
      { type: 'text', text: 'complete output' },
    ];
    const cases = [
      {
        request: errored,
        result: run(errored, {
          kind: 'tool_result_string', messageIndex: 0, blockIndex: 0,
          expectedText: 'complete output',
        }),
        reason: 'error_result',
      },
      {
        request: base(),
        source: {
          kind: 'tool_result_string' as const, messageIndex: 0, blockIndex: 0,
          expectedText: 'output',
        },
        reason: 'wrong_source',
      },
      {
        request: unsupported,
        result: run(unsupported, {
          kind: 'tool_result_string', messageIndex: 0, blockIndex: 0,
          expectedText: 'complete output',
        }),
        reason: 'unsupported_shape',
      },
      {
        request: arrayContent,
        result: run(arrayContent, {
          kind: 'tool_result_text_part', messageIndex: 0, blockIndex: 0,
          partIndex: 9, expectedText: 'complete output',
        }),
        reason: 'ambiguous_indices',
      },
      {
        request: base(),
        source: {
          kind: 'tool_result_string' as const, messageIndex: 0, blockIndex: 0,
          expectedText: 'complete output',
        },
        images: [] as ImageBlock[],
        reason: 'empty_images',
      },
    ];
    for (const testCase of cases) {
      const request = testCase.request;
      const result = 'result' in testCase
        ? testCase.result
        : run(request, testCase.source!, testCase.images);
      const before = structuredClone(request);
      expect(result).toMatchObject({ ok: false, reason: testCase.reason });
      expect(result.request).toBe(request);
      expect(request).toEqual(before);
    }
  });
});

describe('atomic exact Anthropic replacement batch', () => {
  it('rebases project, later tool_result, and multiple inner part indices in one candidate', () => {
    const opening = 'PRE PROJECT POST';
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: opening,
            cache_control: { type: 'ephemeral', ttl: '1h' },
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_parts',
            content: [
              { type: 'text', text: 'part zero' },
              { type: 'text', text: 'untouched middle' },
              {
                type: 'text',
                text: 'part two',
                cache_control: { type: 'ephemeral', ttl: '5m' },
              },
            ],
          },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_string',
            content: 'string output',
          },
          { type: 'text', text: 'live request' },
        ],
      }],
    };
    const source = projectSource(opening, 4, 11);
    const result = applyAnthropicExactImageReplacements({
      request,
      operations: [
        {
          kind: 'user_text_span',
          source,
          images: [image('project-a'), image('project-b')],
          id: 'project',
        },
        {
          kind: 'tool_result_text',
          source: {
            kind: 'tool_result_text_part',
            messageIndex: 0,
            blockIndex: 1,
            partIndex: 0,
            expectedText: 'part zero',
          },
          images: [image('zero-a'), image('zero-b'), image('zero-c')],
          id: 'part-zero',
        },
        {
          kind: 'tool_result_text',
          source: {
            kind: 'tool_result_string',
            messageIndex: 0,
            blockIndex: 2,
            expectedText: 'string output',
          },
          images: [image('string')],
          id: 'string',
        },
        {
          kind: 'tool_result_text',
          source: {
            kind: 'tool_result_text_part',
            messageIndex: 0,
            blockIndex: 1,
            partIndex: 2,
            expectedText: 'part two',
          },
          images: [image('two-a'), image('two-b')],
          id: 'part-two',
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);

    const descriptor = (id: string) =>
      result.descriptors.find((item) => item.id === id)!;
    expect(descriptor('project').target).toMatchObject({
      kind: 'message_text_block',
      originalBlockIndex: 0,
      candidateStartIndex: 0,
    });
    expect(descriptor('part-zero').target).toMatchObject({
      kind: 'tool_result_text_part',
      originalBlockIndex: 1,
      originalPartIndex: 0,
      candidateBlockIndex: 4,
      candidateStartIndex: 0,
    });
    expect(descriptor('part-two').target).toMatchObject({
      kind: 'tool_result_text_part',
      originalBlockIndex: 1,
      originalPartIndex: 2,
      candidateBlockIndex: 4,
      candidateStartIndex: 4,
    });
    expect(descriptor('string').target).toMatchObject({
      kind: 'tool_result_string',
      originalBlockIndex: 2,
      candidateBlockIndex: 5,
      candidateStartIndex: 0,
    });
    // compareNoHijack normalizes nested array splices last-to-first.
    expect(result.descriptors.findIndex((item) => item.id === 'part-two'))
      .toBeLessThan(result.descriptors.findIndex((item) => item.id === 'part-zero'));
    expect(compareNoHijack('anthropic', request, result.request, result.descriptors).ok)
      .toBe(true);

    for (let index = 0; index < result.descriptors.length; index++) {
      const item = result.descriptors[index]!;
      const location = result.changedSpans[index]!;
      if (item.id === 'project') {
        expect(location).toEqual({ messageIndex: 0, blockIndex: 0 });
      } else if (item.id === 'string') {
        expect(location).toEqual({ messageIndex: 0, blockIndex: 2 });
      } else {
        expect(location).toMatchObject({ messageIndex: 0, blockIndex: 1 });
      }
    }
  });

  it('rejects duplicate targets wholly native', () => {
    const text = 'PRE PROJECT POST';
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    };
    const source = projectSource(text, 4, 11);
    const result = applyAnthropicExactImageReplacements({
      request,
      operations: [
        { kind: 'user_text_span', source, images: [image('a')], id: 'a' },
        { kind: 'user_text_span', source, images: [image('b')], id: 'b' },
      ],
    });
    expect(result).toEqual({
      ok: false,
      request,
      reason: 'ambiguous_indices',
    });
    expect(result.request).toBe(request);
  });
});

describe('no-hijack drift rejection', () => {
  it('rejects marker movement within a replacement and image movement across tool_result containers', () => {
    const markedRequest: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: 'PROJECT',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        }],
      }],
    };
    const marked = replaceAnthropicUserTextSpanWithImages({
      request: markedRequest,
      source: projectSource('PROJECT', 0, 7),
      images: [image('a'), image('b')],
      id: 'marked',
    });
    if (!marked.ok) throw new Error(marked.reason);
    const markerDrift = structuredClone(marked.request);
    const markerParts = contentAt(markerDrift);
    markerParts[0] = {
      ...(markerParts[0] as ImageBlock),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    };
    delete (markerParts[1] as ImageBlock).cache_control;
    const markerComparison = compareNoHijack(
      'anthropic',
      markedRequest,
      markerDrift,
      [marked.descriptor],
    );
    expect(markerComparison.ok).toBe(false);
    expect(markerComparison.replacements[0]).toMatchObject({ accepted: false });

    const toolRequest: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'one', content: 'first' },
          { type: 'tool_result', tool_use_id: 'two', content: 'second' },
        ],
      }],
    };
    const tool = replaceAnthropicToolResultTextWithImages({
      request: toolRequest,
      source: {
        kind: 'tool_result_string',
        messageIndex: 0,
        blockIndex: 0,
        expectedText: 'first',
      },
      images: [image('tool')],
      id: 'tool',
    });
    if (!tool.ok) throw new Error(tool.reason);
    const crossed = structuredClone(tool.request);
    const crossedBlocks = contentAt(crossed);
    const movedImages = (crossedBlocks[0] as ToolResultBlock).content;
    (crossedBlocks[0] as ToolResultBlock).content = 'first';
    (crossedBlocks[1] as ToolResultBlock).content =
      movedImages as Array<TextBlock | ImageBlock>;
    const crossedComparison = compareNoHijack(
      'anthropic',
      toolRequest,
      crossed,
      [tool.descriptor],
    );
    expect(crossedComparison.ok).toBe(false);
    expect(crossedComparison.replacements[0]).toMatchObject({ accepted: false });
  });
});
