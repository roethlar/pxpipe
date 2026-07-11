import { describe, expect, it } from 'vitest';
import { countCacheControlMarkers } from '../src/core/measurement.js';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest, ToolResultBlock } from '../src/core/types.js';

function encode(request: MessagesRequest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(request));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(new TextDecoder().decode(body)) as MessagesRequest;
}

function outputText(): string {
  return 'ordinary words remain in their original order. '.repeat(350);
}

async function candidate(request: MessagesRequest) {
  return buildAnthropicCandidate(encode(request), {
    compressToolResults: true,
    minToolResultChars: 100,
    cols: 100,
    maxImagesPerToolResult: 10,
  });
}

describe('Anthropic caller-owned cache markers', () => {
  it('does not invent a marker when exact tool-result imaging has none to preserve', async () => {
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_unmarked', content: outputText() }],
      }],
    };
    const input = encode(request);
    const transformed = await candidate(request);

    expect(transformed.info.compressed).toBe(true);
    expect(countCacheControlMarkers(input)).toBe(0);
    expect(countCacheControlMarkers(transformed.body)).toBe(0);
  });

  it('preserves system and live-tail markers while moving only a replaced part marker to its last image', async () => {
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      system: [{
        type: 'text',
        text: 'native system text',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_marked', name: 'Read', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_marked',
            content: [
              { type: 'text', text: outputText(), cache_control: { type: 'ephemeral', ttl: '5m' } },
              { type: 'text', text: 'short native suffix' },
            ],
          }],
        },
        {
          role: 'user',
          content: [{
            type: 'text',
            text: 'caller-owned live tail',
            cache_control: { type: 'ephemeral' },
          }],
        },
      ],
    };
    const input = encode(request);
    const transformed = await candidate(request);
    const output = decode(transformed.body);
    const result = (output.messages[1]!.content as ContentBlock[])[0] as ToolResultBlock;
    const parts = result.content as ContentBlock[];
    const images = parts.slice(0, -1);

    expect(transformed.info.compressed).toBe(true);
    expect(countCacheControlMarkers(transformed.body)).toBe(countCacheControlMarkers(input));
    expect(output.system).toEqual(request.system);
    expect(output.messages[2]).toEqual(request.messages[2]);
    expect(parts.at(-1)).toEqual({ type: 'text', text: 'short native suffix' });
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((block) => block.type === 'image')).toBe(true);
    expect(images.at(-1)).toMatchObject({
      type: 'image',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
    expect(images.slice(0, -1).every((block) => !('cache_control' in block))).toBe(true);
  });

  it('keeps a marker on an imaged string result in its original outer container', async () => {
    const request: MessagesRequest = {
      model: 'claude-fable-5',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_outer',
          content: outputText(),
          cache_control: { type: 'ephemeral', ttl: '5m' },
        }],
      }],
    };
    const input = encode(request);
    const transformed = await candidate(request);
    const output = decode(transformed.body);
    const result = (output.messages[0]!.content as ContentBlock[])[0] as ToolResultBlock;

    expect(transformed.info.compressed).toBe(true);
    expect(countCacheControlMarkers(transformed.body)).toBe(countCacheControlMarkers(input));
    expect(result.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(Array.isArray(result.content)).toBe(true);
    expect((result.content as ContentBlock[]).every((block) =>
      block.type === 'image' && !('cache_control' in block))).toBe(true);
  });
});
