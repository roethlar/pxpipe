import { describe, expect, it } from 'vitest';
import {
  buildCacheablePrefixCountTokensBody,
  resolveChangedSpanCacheCoverage,
} from '../src/core/measurement.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const body = (value: unknown): Uint8Array => enc.encode(JSON.stringify(value));

function request(content: unknown[]): Uint8Array {
  return body({
    model: 'claude-fable-5',
    messages: [{ role: 'user', content }],
  });
}

describe('resolveChangedSpanCacheCoverage', () => {
  it('reports a project-opening block as covered by its caller marker', () => {
    const bytes = request([
      {
        type: 'text',
        text: 'project context',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
      { type: 'text', text: 'live turn' },
    ]);

    expect(resolveChangedSpanCacheCoverage(bytes, [{ messageIndex: 0, blockIndex: 0 }]))
      .toEqual([{
        kind: 'covered',
        marker: { kind: 'message_block', messageIndex: 0, blockIndex: 0 },
        rawTtl: '5m',
      }]);
  });

  it('uses the last marker in tools, system, then message cache order', () => {
    const bytes = body({
      model: 'claude-fable-5',
      tools: [{
        name: 'lookup',
        input_schema: { type: 'object' },
        cache_control: { type: 'ephemeral', ttl: '1h' },
      }],
      system: [{
        type: 'text',
        text: 'system context',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'project context' },
          {
            type: 'text',
            text: 'later caller breakpoint',
            cache_control: { type: 'ephemeral' },
          },
        ],
      }],
    });

    expect(resolveChangedSpanCacheCoverage(bytes, [{ messageIndex: 0, blockIndex: 0 }]))
      .toEqual([{
        kind: 'covered',
        marker: { kind: 'message_block', messageIndex: 0, blockIndex: 1 },
        rawTtl: undefined,
      }]);
  });

  it('reports spans after the governing marker as cold', () => {
    const bytes = request([
      {
        type: 'text',
        text: 'cached prefix',
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'live result' },
    ]);

    expect(resolveChangedSpanCacheCoverage(bytes, [{ messageIndex: 0, blockIndex: 1 }]))
      .toEqual([{ kind: 'cold' }]);
  });

  it('classifies covered and cold spans independently in one call', () => {
    const bytes = request([
      { type: 'text', text: 'project context' },
      {
        type: 'text',
        text: 'cached prefix end',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'live result' },
    ]);

    expect(resolveChangedSpanCacheCoverage(bytes, [
      { messageIndex: 0, blockIndex: 0 },
      { messageIndex: 0, blockIndex: 2 },
    ])).toEqual([
      {
        kind: 'covered',
        marker: { kind: 'message_block', messageIndex: 0, blockIndex: 1 },
        rawTtl: '5m',
      },
      { kind: 'cold' },
    ]);
  });

  it('reports valid spans as cold when the caller supplied no marker', () => {
    const bytes = request([{ type: 'text', text: 'project context' }]);

    expect(resolveChangedSpanCacheCoverage(bytes, [{ messageIndex: 0, blockIndex: 0 }]))
      .toEqual([{ kind: 'cold' }]);
  });

  it.each([
    ['5m', '5m'],
    ['1h', '1h'],
    [undefined, undefined],
  ] as const)('preserves the caller TTL %s without normalization', (ttl, expected) => {
    const bytes = request([{
      type: 'text',
      text: 'project context',
      cache_control: {
        type: 'ephemeral',
        ...(ttl === undefined ? {} : { ttl }),
      },
    }]);

    expect(resolveChangedSpanCacheCoverage(bytes, [{ messageIndex: 0, blockIndex: 0 }]))
      .toEqual([{
        kind: 'covered',
        marker: { kind: 'message_block', messageIndex: 0, blockIndex: 0 },
        rawTtl: expected,
      }]);
  });

  it('fails closed for malformed bodies and invalid or ambiguous positions', () => {
    expect(resolveChangedSpanCacheCoverage(enc.encode('{'), [
      { messageIndex: 0, blockIndex: 0 },
    ])).toEqual([{ kind: 'unknown', reason: 'invalid_body' }]);

    const bytes = request([
      { type: 'text', text: 'ordinary text' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_1',
        content: [{ type: 'text', text: 'nested text' }],
      },
    ]);
    expect(resolveChangedSpanCacheCoverage(bytes, [
      { messageIndex: -1, blockIndex: 0 },
      { messageIndex: 0, blockIndex: 9 },
      { messageIndex: 0, blockIndex: 1 },
      { messageIndex: 0, blockIndex: 0, toolResultPartIndex: 0 },
      { messageIndex: 0, blockIndex: 1, toolResultPartIndex: 9 },
    ])).toEqual([
      { kind: 'unknown', reason: 'invalid_location' },
      { kind: 'unknown', reason: 'invalid_location' },
      { kind: 'unknown', reason: 'ambiguous_location' },
      { kind: 'unknown', reason: 'invalid_location' },
      { kind: 'unknown', reason: 'invalid_location' },
    ]);
  });

  it('uses the same nested tool-result part order as the prefix builder', () => {
    const bytes = request([{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: [
        {
          type: 'text',
          text: 'cached result',
          cache_control: { type: 'ephemeral', ttl: '1h' },
        },
        { type: 'text', text: 'live result' },
      ],
    }]);

    expect(resolveChangedSpanCacheCoverage(bytes, [
      { messageIndex: 0, blockIndex: 0, toolResultPartIndex: 0 },
      { messageIndex: 0, blockIndex: 0, toolResultPartIndex: 1 },
    ])).toEqual([
      {
        kind: 'covered',
        marker: {
          kind: 'tool_result_part',
          messageIndex: 0,
          blockIndex: 0,
          toolResultPartIndex: 0,
        },
        rawTtl: '1h',
      },
      { kind: 'cold' },
    ]);

    const prefixBytes = buildCacheablePrefixCountTokensBody(bytes);
    expect(prefixBytes).not.toBeNull();
    const prefix = JSON.parse(dec.decode(prefixBytes!)) as {
      messages: Array<{ content: Array<{ content: unknown[] }> }>;
    };
    expect(prefix.messages[0]?.content[0]?.content).toEqual([{
      type: 'text',
      text: 'cached result',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }]);
  });

  it('preserves cache-relevant top-level controls in every prefix probe shape', () => {
    const controls = {
      tool_choice: { type: 'tool', name: 'lookup' },
      thinking: { type: 'enabled', budget_tokens: 1_024 },
      mcp_servers: [{ type: 'url', url: 'https://mcp.invalid' }],
    };
    const variants = [
      {
        model: 'claude-fable-5',
        ...controls,
        tools: [{
          name: 'lookup',
          input_schema: { type: 'object' },
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: 'x' }],
      },
      {
        model: 'claude-fable-5',
        ...controls,
        system: [{
          type: 'text',
          text: 'cached system',
          cache_control: { type: 'ephemeral' },
        }],
        messages: [{ role: 'user', content: 'x' }],
      },
      {
        model: 'claude-fable-5',
        ...controls,
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: 'cached message',
            cache_control: { type: 'ephemeral' },
          }],
        }],
      },
    ];

    for (const variant of variants) {
      const prefixBytes = buildCacheablePrefixCountTokensBody(body(variant));
      expect(prefixBytes).not.toBeNull();
      expect(JSON.parse(dec.decode(prefixBytes!))).toMatchObject(controls);
    }
  });
});
