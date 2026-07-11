import { describe, expect, it } from 'vitest';
import { DENSE_CONTENT_CHARS_PER_IMAGE } from '../src/core/render.js';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type {
  ContentBlock,
  ImageBlock,
  MessagesRequest,
  ToolResultBlock,
} from '../src/core/types.js';

function encode(request: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

function image(data: string): ImageBlock {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data },
  };
}

function plainOutput(repetitions = 350): string {
  return 'ordinary words remain in their original order. '.repeat(repetitions);
}

function toolResultAt(request: MessagesRequest, messageIndex: number, blockIndex: number): ToolResultBlock {
  const content = request.messages[messageIndex]!.content;
  if (!Array.isArray(content) || content[blockIndex]?.type !== 'tool_result') {
    throw new Error('expected tool result');
  }
  return content[blockIndex];
}

async function expectExactNative(
  request: MessagesRequest,
  options: Parameters<typeof buildAnthropicCandidate>[1] = {},
): Promise<void> {
  const input = encode(request);
  const transformed = await buildAnthropicCandidate(input, {
    compressToolResults: true,
    minToolResultChars: 100,
    cols: 80,
    ...options,
  });

  expect(transformed.body).toBe(input);
  expect(decode(transformed.body)).toEqual(request);
  expect(transformed.info.compressed).toBe(false);
}

describe('Anthropic safe tool-result imaging', () => {
  it('replaces only one exact text part inside its original container and preserves request order', async () => {
    const source = plainOutput();
    const existing = image('existing');
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native system' }],
      messages: [
        { role: 'user', content: 'run it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_parts', name: 'Read', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_parts',
              is_error: false,
              content: [
                existing,
                { type: 'text', text: source, cache_control: { type: 'ephemeral', ttl: '5m' } },
                { type: 'text', text: 'short native suffix' },
              ],
            },
            { type: 'text', text: 'after', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    const transformed = await buildAnthropicCandidate(encode(request), {
      compressToolResults: true,
      minToolResultChars: 100,
      cols: 100,
      maxImagesPerToolResult: 10,
    });
    const output = decode(transformed.body);
    const outer = output.messages[2]!.content as ContentBlock[];
    const result = outer[1] as ToolResultBlock;
    const inner = result.content as ContentBlock[];

    expect(transformed.info.compressed).toBe(true);
    expect(output.system).toEqual(request.system);
    expect(output.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(outer.map((block) => block.type)).toEqual(['text', 'tool_result', 'text']);
    expect(outer[0]).toEqual({ type: 'text', text: 'before' });
    expect(outer[2]).toEqual({ type: 'text', text: 'after', cache_control: { type: 'ephemeral' } });
    expect(result.tool_use_id).toBe('toolu_parts');
    expect(result.is_error).toBe(false);
    expect(inner[0]).toEqual(existing);
    expect(inner.at(-1)).toEqual({ type: 'text', text: 'short native suffix' });
    const replacements = inner.slice(1, -1);
    expect(replacements.length).toBeGreaterThan(0);
    expect(replacements.every((block) => block.type === 'image')).toBe(true);
    expect(replacements.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral', ttl: '5m' } });
    expect(replacements.slice(0, -1).every((block) => !('cache_control' in block))).toBe(true);
    expect(transformed.info.imageSourceText).toBeUndefined();
    expect(transformed.info.recoverable).toBeUndefined();
  });

  it('keeps an oversized result exact instead of truncating it to the page limit', async () => {
    const source = plainOutput(1_000);
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_oversized', content: source }],
      }],
    };

    await expectExactNative(request, { maxImagesPerToolResult: 1 });
    expect(toolResultAt(request, 0, 0).content).toBe(source);
  });

  it('keeps a result exact when existing images exhaust the request-wide limit', async () => {
    const existing = Array.from({ length: 100 }, (_, index) => image(`existing-${index}`));
    const source = plainOutput();
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [
        { role: 'user', content: existing },
        { role: 'assistant', content: 'continue' },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_full', content: source }],
        },
      ],
    };

    await expectExactNative(request, { maxImagesPerToolResult: 10 });
    expect(toolResultAt(request, 2, 0).content).toBe(source);
  });

  it('rejects the whole candidate instead of selecting a subset at the global image limit', async () => {
    const existing = Array.from({ length: 96 }, (_, index) => image(`existing-${index}`));
    const first = plainOutput(500);
    const second = 'different ordinary words stay in place. '.repeat(600);
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [
          ...existing,
          { type: 'tool_result', tool_use_id: 'toolu_first', content: first },
          { type: 'tool_result', tool_use_id: 'toolu_second', content: second },
        ],
      }],
    };
    const input = encode(request);
    const transformed = await buildAnthropicCandidate(input, {
      compressToolResults: true,
      minToolResultChars: 100,
      cols: 40,
      maxImagesPerToolResult: 10,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.reason).toBe('candidate_image_limit');
    expect(transformed.replacements).toEqual([]);
    expect(decode(transformed.body)).toEqual(request);
  });

  it('keeps unsupported and error result shapes exact', async () => {
    const source = plainOutput();
    const unsupported = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_unsupported',
          content: source,
          unknown_extension: true,
        }],
      }],
    } as unknown as MessagesRequest;
    const error: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_error',
          content: source,
          is_error: true,
        }],
      }],
    };

    await expectExactNative(unsupported, { maxImagesPerToolResult: 10 });
    await expectExactNative(error, { maxImagesPerToolResult: 10 });
  });

  it('keeps an exact identifier native even when it crosses a scan-window boundary', async () => {
    const prefix = 'ordinary words '.repeat(
      Math.ceil(DENSE_CONTENT_CHARS_PER_IMAGE / 'ordinary words '.length),
    ).slice(0, DENSE_CONTENT_CHARS_PER_IMAGE - 4);
    const source = `${prefix} abcdef123 ${plainOutput(100)}`;
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_identifier', content: source }],
      }],
    };
    const input = encode(request);
    const transformed = await buildAnthropicCandidate(input, {
      compressToolResults: true,
      minToolResultChars: 100,
      maxImagesPerToolResult: 10,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.passthroughReasons?.exact_identifier).toBe(1);
  });

  it('keeps unfamiliar explicitly labelled identifiers native', async () => {
    const source = 'job_id=qz91lm2n\n'.repeat(800);
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_job_ids', content: source }],
      }],
    };
    const input = encode(request);
    const transformed = await buildAnthropicCandidate(input, {
      compressToolResults: true,
      minToolResultChars: 100,
      maxImagesPerToolResult: 10,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.passthroughReasons?.exact_identifier).toBe(1);
  });

  it('keeps structured data native when opaque values cannot be classified safely', async () => {
    const source = '{"widget":"qzlmnp"}\n'.repeat(500);
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_structured', content: source }],
      }],
    };
    const input = encode(request);
    const transformed = await buildAnthropicCandidate(input, {
      compressToolResults: true,
      minToolResultChars: 100,
      maxImagesPerToolResult: 10,
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.passthroughReasons?.exact_identifier).toBe(1);
  });
});
