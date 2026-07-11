import { describe, expect, it } from 'vitest';
import { readCallerCacheControlTier } from '../src/core/measurement.js';

const enc = new TextEncoder();
const body = (value: unknown): Uint8Array => enc.encode(JSON.stringify(value));

describe('readCallerCacheControlTier', () => {
  it('returns the tier on the last caller-owned breakpoint in cache order', () => {
    expect(readCallerCacheControlTier(body({
      model: 'claude-fable-5',
      tools: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }],
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'early', cache_control: { type: 'ephemeral', ttl: '1h' } },
          { type: 'text', text: 'late', cache_control: { type: 'ephemeral', ttl: '5m' } },
        ],
      }],
    }))).toBe('5m');
  });

  it('uses one-hour pricing for omitted or unknown TTL values', () => {
    for (const ttl of [undefined, 'future', 300]) {
      expect(readCallerCacheControlTier(body({
        model: 'claude-fable-5',
        messages: [{
          role: 'user',
          content: [{
            type: 'text',
            text: 'prefix',
            cache_control: { type: 'ephemeral', ...(ttl === undefined ? {} : { ttl }) },
          }],
        }],
      }))).toBe('conservative_1h');
    }
  });

  it('returns an exact none for a marker-free or malformed request', () => {
    expect(readCallerCacheControlTier(body({
      model: 'claude-fable-5',
      messages: [{ role: 'user', content: 'plain' }],
    }))).toBe('none');
    expect(readCallerCacheControlTier(enc.encode('{'))).toBe('none');
  });
});
