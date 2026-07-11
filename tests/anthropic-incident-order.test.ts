import { describe, expect, it, vi } from 'vitest';
import {
  admitAnthropicCandidate,
  validateAnthropicMessageStructure,
} from '../src/core/admission.js';
import { compareNoHijack } from '../src/core/no-hijack.js';
import { buildAnthropicCandidate } from '../src/core/transform.js';
import type { ContentBlock, MessagesRequest } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  makeCapturedRequest,
} from './fixtures/anthropic-context.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(request: MessagesRequest): Uint8Array {
  return encoder.encode(JSON.stringify(request));
}

function decode(body: Uint8Array): MessagesRequest {
  return JSON.parse(decoder.decode(body)) as MessagesRequest;
}

function incidentRequest(): MessagesRequest {
  const projectGuidance = [
    DIRECT_PROJECT_GUIDANCE,
    ...Array.from(
      { length: 360 },
      (_, index) => `role-order rule ${index}: retain the caller's exact message sequence.`,
    ),
  ].join('\n');
  const request = makeCapturedRequest({ projectGuidance });

  // The captured opening already has the reported user -> literal system ->
  // assistant sequence. Add older turns using both string and block-array hook
  // attachment shapes so a history rewrite cannot hide an ordering regression.
  request.messages.push(
    { role: 'user', content: 'older user turn' },
    {
      role: 'system',
      content: [{
        type: 'text',
        text: '<system-reminder>SessionStart hook attachment</system-reminder>',
      }],
    },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'older assistant response after the hook' }],
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'live user turn' },
        {
          type: 'text',
          text: '<system-reminder>PostToolUse hook attachment</system-reminder>',
        },
      ],
    },
  );
  return request;
}

describe('Anthropic incident message order', () => {
  it('keeps the reported system attachments and old history in exact input order', async () => {
    const request = incidentRequest();
    const original = structuredClone(request);
    const built = await buildAnthropicCandidate(encode(request), {
      minCompressChars: 1,
      collapseHistory: true,
      compressReminders: true,
      historyAmortizationHorizon: 100,
    });
    const candidate = decode(built.body);

    expect(built.info.compressed).toBe(true);
    expect(built.replacements).toHaveLength(1);
    expect(candidate.messages).toHaveLength(original.messages.length);
    expect(candidate.messages.map((message) => message.role)).toEqual(
      original.messages.map((message) => message.role),
    );
    expect(candidate.messages.slice(1)).toEqual(original.messages.slice(1));
    expect(candidate.messages[1]).toEqual({
      role: 'system',
      content: '<system-reminder>literal mid-conversation host attachment</system-reminder>',
    });
    expect(candidate.messages[2]).toEqual({ role: 'assistant', content: 'Acknowledged.' });
    expect(candidate.messages[3]).toEqual(original.messages[3]);
    expect(candidate.messages[4]).toEqual(original.messages[4]);
    expect(candidate.messages[5]).toEqual(original.messages[5]);
    expect(candidate.messages[6]).toEqual(original.messages[6]);
    expect(candidate.messages.filter((message) => message.role === 'user')).toHaveLength(
      original.messages.filter((message) => message.role === 'user').length,
    );
    expect(validateAnthropicMessageStructure(candidate)).toEqual({ valid: true });
    expect(compareNoHijack('anthropic', original, candidate, built.replacements).ok).toBe(true);
    expect(JSON.stringify(candidate)).not.toContain('[Earlier conversation rendered');
  });

  it('rejects the whole candidate before probing if a synthetic user follows a normal system', async () => {
    const originalRequest = incidentRequest();
    const originalBody = encode(originalRequest);
    const invalidCandidate = structuredClone(originalRequest);
    invalidCandidate.messages.splice(2, 0, {
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aW1hZ2U=',
        },
      } as ContentBlock],
    });
    const probe = vi.fn(async () => 1);

    expect(validateAnthropicMessageStructure(invalidCandidate)).toEqual({
      valid: false,
      reason: 'system_role_order',
      messageIndex: 1,
    });
    const decision = await admitAnthropicCandidate({
      originalBody,
      candidateBody: encode(invalidCandidate),
      changedSpanCache: [{ kind: 'cold' }],
      probe,
    });

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toBe('candidate_structure_invalid');
    expect(decision.body).toBe(originalBody);
    expect(decode(decision.body)).toEqual(originalRequest);
    expect(probe).not.toHaveBeenCalled();
  });
});
