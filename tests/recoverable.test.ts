/**
 * The provenance-safe Anthropic path never returns caller source text through
 * diagnostics. `emitRecoverable` remains a compatibility option, but cannot
 * expose imaged text from the active request builder. The public standalone
 * wrapper also remains fail-native because it has no admission-probe transport.
 */

import { describe, expect, it } from 'vitest';
import { buildAnthropicCandidate as transformRequest } from '../src/core/transform.js';
import { transformAnthropicMessages } from '../src/core/library.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function makeReq(content: unknown[], model = 'claude-3-5-sonnet') {
  return enc.encode(
    JSON.stringify({
      model,
      system: 'x'.repeat(80_000),
      messages: [{ role: 'user', content }],
    }),
  );
}

function parse(body: Uint8Array): any {
  return JSON.parse(dec.decode(body));
}

function userBlocks(body: Uint8Array): any[] {
  const req = parse(body);
  const user = (req.messages ?? []).find((m: any) => m.role === 'user');
  return Array.isArray(user?.content) ? user.content : [];
}

// Big enough that the profitability gate images it by default.
const BIG = 'ordinary readable prose '.repeat(2_500);

describe('emitRecoverable on the safe Anthropic path', () => {
  it('emits no recovery map by default, even when exact content is imaged', async () => {
    const { info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { multiCol: 1, charsPerToken: 2 },
    );
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(info.recoverable).toBeUndefined();
  });

  it('does not expose source text when emitRecoverable is true', async () => {
    const { body, info } = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { multiCol: 1, charsPerToken: 2, emitRecoverable: true },
    );

    const tr = userBlocks(body).find((b) => b.type === 'tool_result');
    const hasImage =
      Array.isArray(tr?.content) &&
      tr.content.some((b: any) => b.type === 'image');
    expect(hasImage).toBe(true);
    expect(info.toolResultImgs ?? 0).toBeGreaterThan(0);
    expect(info.recoverable).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain(BIG);
  });

  it('emitRecoverable cannot change the candidate body', async () => {
    const without = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { multiCol: 1, charsPerToken: 2 },
    );
    const withRecoverable = await transformRequest(
      makeReq([{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }]),
      { multiCol: 1, charsPerToken: 2, emitRecoverable: true },
    );
    expect(withRecoverable.body).toEqual(without.body);
    expect(withRecoverable.info.recoverable).toBeUndefined();
  });

  it('does not expose a block that keepSharp kept as native text', async () => {
    const input = makeReq([{ type: 'tool_result', tool_use_id: 'keep_me', content: BIG }]);
    const { body, info } = await transformRequest(
      input,
      {
        multiCol: 1,
        charsPerToken: 2,
        emitRecoverable: true,
        keepSharp: (blk) => blk.toolUseId === 'keep_me',
      },
    );
    expect(info.keptSharpBlocks ?? 0).toBeGreaterThan(0);
    expect(info.toolResultImgs ?? 0).toBe(0);
    expect(info.recoverable).toBeUndefined();
    expect(body).toBe(input);
  });

  it('never returns either source when one sibling is native and one is imaged', async () => {
    const { body, info } = await transformRequest(
      makeReq([
        { type: 'tool_result', tool_use_id: 'keep_me', content: BIG },
        { type: 'tool_result', tool_use_id: 'image_me', content: BIG },
      ]),
      {
        multiCol: 1,
        charsPerToken: 2,
        emitRecoverable: true,
        keepSharp: (blk) => blk.toolUseId === 'keep_me',
      },
    );
    const blocks = userBlocks(body).filter((block) => block.type === 'tool_result');
    const kept = blocks.find((block) => block.tool_use_id === 'keep_me');
    const imaged = blocks.find((block) => block.tool_use_id === 'image_me');
    expect(kept?.content).toBe(BIG);
    expect(Array.isArray(imaged?.content)).toBe(true);
    expect(imaged.content.every((part: any) => part.type === 'image')).toBe(true);
    expect(info.recoverable).toBeUndefined();
    expect(JSON.stringify(info)).not.toContain(BIG);
  });

  it('does not leak candidate recovery text through the unmeasured public wrapper', async () => {
    const input = makeReq(
      [{ type: 'tool_result', tool_use_id: 'toolu_a', content: BIG }],
      'claude-fable-5',
    );
    const result = await transformAnthropicMessages({
      body: input,
      model: 'claude-fable-5',
      options: { charsPerToken: 2, emitRecoverable: true },
    });
    expect(result.applied).toBe(false);
    expect(result.body).toBe(input);
    expect(result.info.reason).toBe('admission_probe_unavailable');
    expect(result.info.recoverable).toBeUndefined();
  });
});
