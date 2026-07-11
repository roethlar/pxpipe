import { describe, expect, it } from 'vitest';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, ToolDef, ToolResultBlock } from '../src/core/types.js';

function encode(request: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

function largeTools(): ToolDef[] {
  return [{
    name: 'SyntheticShell',
    description: 'ordinary tool documentation '.repeat(8_000),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'ordinary command text' },
        mode: { type: 'string', enum: ['safe', 'inspect'] },
      },
      required: ['command'],
      additionalProperties: false,
    },
  }];
}

function plainOutput(): string {
  return 'ordinary words remain in their original order. '.repeat(350);
}

function allImages(request: MessagesRequest): ContentBlock[] {
  return request.messages.flatMap((message) => {
    if (!Array.isArray(message.content)) return [];
    return message.content.flatMap((block) => {
      if (block.type === 'image') return [block];
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        return block.content.filter((part) => part.type === 'image');
      }
      return [];
    });
  });
}

describe('Anthropic native tool definitions', () => {
  it('ignores every legacy rewrite switch and leaves tools, roles, and order byte-exact', async () => {
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native system text' }],
      tools: largeTools(),
      messages: [
        { role: 'user', content: 'opening request' },
        { role: 'assistant', content: 'native answer' },
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>native reminder</system-reminder>' }] },
      ],
    };
    const input = encode(request);
    const transformed = await buildAnthropicCandidate(input, {
      compressTools: true,
      compressReminders: true,
      collapseHistory: true,
      compressToolResults: false,
      minCompressChars: 1,
      minReminderChars: 1,
    });

    expect(transformed.body).toBe(input);
    expect(decode(transformed.body)).toEqual(request);
    expect(transformed.info.compressed).toBe(false);
    expect(transformed.info.toolMode).toBe('native');
    expect(transformed.info.toolDisposition).toBe('native_default');
    expect(allImages(decode(transformed.body))).toHaveLength(0);
  });

  it('keeps complete tool definitions exact while an eligible tool result is imaged', async () => {
    const tools = largeTools();
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{ type: 'text', text: 'native system text' }],
      tools,
      messages: [
        { role: 'user', content: 'run the tool' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_safe', name: 'SyntheticShell', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'before result' },
            { type: 'tool_result', tool_use_id: 'toolu_safe', content: plainOutput() },
            { type: 'text', text: 'after result' },
          ],
        },
      ],
    };
    const input = encode(request);
    const transformed = await buildAnthropicCandidate(input, {
      compressTools: true,
      compressReminders: true,
      collapseHistory: true,
      compressToolResults: true,
      minToolResultChars: 100,
      cols: 100,
      maxImagesPerToolResult: 10,
    });
    const output = decode(transformed.body);
    const result = (output.messages[2]!.content as ContentBlock[])[1] as ToolResultBlock;

    expect(transformed.info.compressed).toBe(true);
    expect(output.system).toEqual(request.system);
    expect(output.tools).toEqual(tools);
    expect(JSON.stringify(output.tools)).toBe(JSON.stringify(request.tools));
    expect(output.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect((output.messages[2]!.content as ContentBlock[]).map((block) => block.type))
      .toEqual(['text', 'tool_result', 'text']);
    expect(result.tool_use_id).toBe('toolu_safe');
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as ContentBlock[]).every((block) => block.type === 'image')).toBe(true);
    expect(transformed.info.toolMode).toBe('native');
    expect(transformed.info.toolDisposition).toBe('native_default');
    expect(transformed.info.imageSourceText).toBeUndefined();
  });
});
