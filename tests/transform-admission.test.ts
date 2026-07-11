import { describe, expect, it } from 'vitest';
import {
  buildAnthropicCandidate,
  transformRequest,
} from '../src/core/transform.js';

const enc = new TextEncoder();

describe('standalone Anthropic transformation is fail-native', () => {
  it('does not expose an unmeasured candidate through the public entry point', async () => {
    const body = enc.encode(JSON.stringify({
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: 'plain tool output line\n'.repeat(500),
          }],
        },
      ],
    }));
    const options = {
      compressProjectGuidance: false,
      compressToolResults: true,
      minToolResultChars: 1,
      charsPerToken: 1,
      reflow: false,
    };
    const candidate = await buildAnthropicCandidate(body, options);
    expect(candidate.info.compressed).toBe(true);

    const publicResult = await transformRequest(body, options);
    expect(publicResult.body).toBe(body);
    expect(publicResult.info).toMatchObject({
      compressed: false,
      reason: 'admission_probe_unavailable',
      imageCount: 0,
      compressedChars: 0,
    });
  });
});
