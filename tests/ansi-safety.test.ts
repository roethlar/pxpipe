import { describe, expect, it } from 'vitest';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type {
  ContentBlock,
  MessagesRequest,
  ToolResultBlock,
} from '../src/core/types.js';

const TERMINAL_CONTROLS = [
  ['CSI SGR', '\u001b[31mred words\u001b[0m'],
  ['OSC terminated by BEL', '\u001b]0;window title\u0007'],
  ['OSC terminated by ST', '\u001b]0;window title\u001b\\'],
  ['C1 CSI', '\u009b31mred words\u009b0m'],
  ['C0 backspace', '\u0008'],
] as const;

function ordinaryProse(repetitions = 8): string {
  return 'ordinary words remain in their original order and keep their meaning. '.repeat(repetitions);
}

function requestWithToolResult(content: ToolResultBlock['content']): MessagesRequest {
  return {
    model: 'claude-fable-5',
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'toolu_terminal_output',
        content,
      }],
    }],
  };
}

function encode(request: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

async function candidate(request: MessagesRequest) {
  const input = encode(request);
  const transformed = await buildAnthropicCandidate(input, {
    compressProjectGuidance: false,
    compressToolResults: true,
    minToolResultChars: 100,
    cols: 100,
    maxImagesPerToolResult: 10,
  });
  return { input, transformed };
}

function firstToolResult(request: MessagesRequest): ToolResultBlock {
  const content = request.messages[0]?.content;
  if (!Array.isArray(content) || content[0]?.type !== 'tool_result') {
    throw new Error('expected a tool_result');
  }
  return content[0];
}

describe('terminal-control safety', () => {
  it.each(TERMINAL_CONTROLS)(
    'keeps a single text result byte-exact when it contains %s before printable prose',
    async (_name, sequence) => {
      const source = `terminal prefix ${sequence} printable suffix ${ordinaryProse()}`;
      const request = requestWithToolResult(source);
      const { input, transformed } = await candidate(request);

      expect(transformed.body).toBe(input);
      expect(transformed.info.compressed).toBe(false);
      expect(transformed.info.imageCount).toBe(0);
      expect(transformed.info.imagedBucketChars).toBeUndefined();
      expect(transformed.info.passthroughReasons?.terminal_control).toBe(1);
      expect(transformed.replacements).toEqual([]);
      expect(decode(transformed.body)).toEqual(request);
    },
  );

  it.each(TERMINAL_CONTROLS)(
    'keeps the complete multipart result native when one part contains %s',
    async (_name, sequence) => {
      const controlledPart = `terminal prefix ${sequence} printable suffix ${ordinaryProse()}`;
      const nativeParts: ContentBlock[] = [
        { type: 'text', text: controlledPart },
        { type: 'text', text: ordinaryProse() },
      ];
      const request = requestWithToolResult(nativeParts);
      const { input, transformed } = await candidate(request);

      expect(transformed.body).toBe(input);
      expect(transformed.info.compressed).toBe(false);
      expect(transformed.info.imageCount).toBe(0);
      expect(transformed.info.imagedBucketChars).toBeUndefined();
      expect(transformed.info.passthroughReasons?.terminal_control).toBe(1);
      expect(transformed.replacements).toEqual([]);
      expect(firstToolResult(decode(transformed.body)).content).toEqual(nativeParts);
    },
  );

  it('keeps ordinary prose eligible when no terminal control is present', async () => {
    const source = ordinaryProse();
    const request = requestWithToolResult(source);
    const { input, transformed } = await candidate(request);
    const output = firstToolResult(decode(transformed.body));
    const parts = output.content as ContentBlock[];

    expect(transformed.body).not.toBe(input);
    expect(transformed.info.compressed).toBe(true);
    expect(transformed.info.imageCount).toBeGreaterThan(0);
    expect(transformed.info.droppedChars).toBe(0);
    expect(transformed.info.droppedCodepointsTop).toBeUndefined();
    expect(transformed.replacements).toHaveLength(1);
    expect(parts.length).toBeGreaterThan(0);
    expect(parts.every((part) => part.type === 'image')).toBe(true);
  });
});
