import { describe, expect, it } from 'vitest';
import { transformAnthropicMessages } from '../src/core/library.js';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, ToolResultBlock } from '../src/core/types.js';

const BIG = 'ordinary readable prose '.repeat(2_500);

function encode(request: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function requestWith(...results: ToolResultBlock[]): MessagesRequest {
  return {
    model: 'claude-fable-5',
    system: 'native system text',
    messages: [{ role: 'user', content: results }],
  };
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

function toolResult(body: Uint8Array, id: string): ToolResultBlock {
  const request = decode(body);
  const blocks = request.messages[0]!.content;
  if (!Array.isArray(blocks)) throw new Error('expected content blocks');
  const result = blocks.find(
    (block): block is ToolResultBlock =>
      block.type === 'tool_result' && block.tool_use_id === id,
  );
  if (!result) throw new Error(`missing tool result ${id}`);
  return result;
}

function hasImage(result: ToolResultBlock): boolean {
  return Array.isArray(result.content)
    && result.content.some((block) => block.type === 'image');
}

const exactOptions = {
  minToolResultChars: 100,
  cols: 100,
  maxImagesPerToolResult: 10,
} as const;

describe('keepSharp fidelity hint', () => {
  it('images an eligible tool result when no caller hint protects it', async () => {
    const input = encode(requestWith({
      type: 'tool_result',
      tool_use_id: 'toolu_default',
      content: BIG,
    }));
    const transformed = await buildAnthropicCandidate(input, exactOptions);

    expect(transformed.info.compressed).toBe(true);
    expect(transformed.info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(transformed.info.keptSharpBlocks ?? 0).toBe(0);
    expect(hasImage(toolResult(transformed.body, 'toolu_default'))).toBe(true);
  });

  it('keeps a protected tool result byte-exact', async () => {
    const input = encode(requestWith({
      type: 'tool_result',
      tool_use_id: 'toolu_kept',
      content: BIG,
    }));
    const transformed = await buildAnthropicCandidate(input, {
      ...exactOptions,
      keepSharp: (block) => block.kind === 'tool_result',
    });

    expect(transformed.body).toBe(input);
    expect(transformed.info.toolResultImgs ?? 0).toBe(0);
    expect(transformed.info.keptSharpBlocks).toBe(1);
    expect(toolResult(transformed.body, 'toolu_kept').content).toBe(BIG);
  });

  it('passes the exact source kind, text, and tool-use id to the predicate', async () => {
    const seen: Array<{ kind: string; toolUseId?: string; text: string }> = [];
    await buildAnthropicCandidate(encode(requestWith({
      type: 'tool_result',
      tool_use_id: 'toolu_descriptor',
      content: BIG,
    })), {
      ...exactOptions,
      keepSharp: (block) => {
        seen.push({ kind: block.kind, toolUseId: block.toolUseId, text: block.text });
        return false;
      },
    });

    expect(seen).toEqual([{
      kind: 'tool_result',
      toolUseId: 'toolu_descriptor',
      text: BIG,
    }]);
  });

  it('protects one result without moving or disabling an eligible sibling', async () => {
    const input = encode(requestWith(
      { type: 'tool_result', tool_use_id: 'keep_me', content: BIG },
      { type: 'tool_result', tool_use_id: 'image_me', content: BIG },
    ));
    const transformed = await buildAnthropicCandidate(input, {
      ...exactOptions,
      keepSharp: (block) => block.toolUseId === 'keep_me',
    });
    const output = decode(transformed.body);
    const blocks = output.messages[0]!.content as ContentBlock[];

    expect(transformed.info.compressed).toBe(true);
    expect(transformed.info.keptSharpBlocks).toBe(1);
    expect(blocks.map((block) =>
      block.type === 'tool_result' ? block.tool_use_id : block.type))
      .toEqual(['keep_me', 'image_me']);
    expect(toolResult(transformed.body, 'keep_me').content).toBe(BIG);
    expect(hasImage(toolResult(transformed.body, 'image_me'))).toBe(true);
  });

  it('treats a throwing predicate as false without breaking the request', async () => {
    const transformed = await buildAnthropicCandidate(encode(requestWith({
      type: 'tool_result',
      tool_use_id: 'toolu_throw',
      content: BIG,
    })), {
      ...exactOptions,
      keepSharp: () => {
        throw new Error('caller bug');
      },
    });

    expect(transformed.info.compressed).toBe(true);
    expect(transformed.info.keptSharpBlocks ?? 0).toBe(0);
    expect(hasImage(toolResult(transformed.body, 'toolu_throw'))).toBe(true);
  });

  it('keeps the public library wrapper native without admission probes', async () => {
    const input = encode(requestWith(
      { type: 'tool_result', tool_use_id: 'keep_me', content: BIG },
      { type: 'tool_result', tool_use_id: 'image_me', content: BIG },
    ));
    const result = await transformAnthropicMessages({
      body: input,
      model: 'claude-fable-5',
      options: { keepSharp: (block) => block.toolUseId === 'keep_me' },
    });

    expect(result.applied).toBe(false);
    expect(result.body).toBe(input);
    expect(result.info.reason).toBe('admission_probe_unavailable');
    expect(toolResult(result.body, 'keep_me').content).toBe(BIG);
    expect(hasImage(toolResult(result.body, 'image_me'))).toBe(false);
  });
});
