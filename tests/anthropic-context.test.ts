import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_2_1_205_BINARY_SHA256,
  CLAUDE_CODE_2_1_205_RUNTIME_SOURCE,
  CLAUDE_CODE_2_1_205_SOURCE,
  isProjectGuidanceBoundaryBlock,
  makeProjectGuidanceBoundary,
  partitionAnthropicContext,
  projectGuidanceBoundaryRef,
  readTextSpan,
  replaceTextSpan,
  type TextSpanLocator,
} from '../src/core/anthropic-context.js';
import type { MessagesRequest } from '../src/core/types.js';
import {
  DIRECT_PROJECT_GUIDANCE,
  FIXTURE_CONTEXT_CLOSER,
  FIXTURE_CONTEXT_OPENER,
  IMPORTED_PROJECT_GUIDANCE,
  makeCapturedRequest,
  makeNoGuidanceRequest,
} from './fixtures/anthropic-context.js';

function openingText(req: MessagesRequest): string {
  const first = req.messages[0]!;
  if (!Array.isArray(first.content) || first.content[0]?.type !== 'text') {
    throw new Error('fixture opening text is missing');
  }
  return first.content[0].text;
}

function withOpeningText(req: MessagesRequest, text: string): MessagesRequest {
  const first = req.messages[0]!;
  if (!Array.isArray(first.content) || first.content[0]?.type !== 'text') {
    throw new Error('fixture opening text is missing');
  }
  const content = first.content.slice();
  content[0] = { ...content[0], text };
  const messages = req.messages.slice();
  messages[0] = { ...first, content };
  return { ...req, messages };
}

describe('Claude Code 2.1.205 Anthropic context partition', () => {
  it('pins the sanitized capture source and binary hash', () => {
    expect(CLAUDE_CODE_2_1_205_SOURCE).toBe('claude_code_2_1_205_opening_reminder');
    expect(CLAUDE_CODE_2_1_205_BINARY_SHA256).toBe(
      '33E28624C5AE84F2BD7D2D8761E5D2E77997BA965CB11B6448DE6B6E2C566F9C',
    );
  });

  it('locates the complete direct claudeMd bundle and excludes captured siblings', () => {
    const req = makeCapturedRequest({
      projectGuidance: DIRECT_PROJECT_GUIDANCE,
      email: 'owner@example.invalid',
    });
    const out = partitionAnthropicContext(req);

    expect(out.uncertain).toEqual([]);
    expect(out.runtimeMetadata).toHaveLength(1);
    const runtime = out.runtimeMetadata[0]!;
    expect(runtime.source).toBe(CLAUDE_CODE_2_1_205_RUNTIME_SOURCE);
    expect(runtime.shape).toBe('opening_runtime_tail_v1');
    expect(runtime.text).toBe(
      "\n# userEmail\nThe user's email address is owner@example.invalid." +
      "\n# currentDate\nToday's date is 2026-07-10.",
    );
    expect(readTextSpan(req, runtime.locator)).toBe(runtime.text);
    expect(runtime.fields.map((field) => field.name)).toEqual(['userEmail', 'currentDate']);
    expect(runtime.fields.map((field) => readTextSpan(req, field.locator))).toEqual(
      runtime.fields.map((field) => field.text),
    );
    expect(out.projectGuidance?.text).toBe(DIRECT_PROJECT_GUIDANCE);
    expect(readTextSpan(req, out.projectGuidance!.locator)).toBe(DIRECT_PROJECT_GUIDANCE);
    expect(out.projectGuidance?.text).not.toContain('# userEmail');
    expect(out.projectGuidance?.text).not.toContain('# currentDate');
    expect(out.openingCarrier?.text).toBe(openingText(req));
    expect(readTextSpan(req, out.openingCarrier!.locator)).toBe(openingText(req));
  });

  it('keeps imported headings, forged file records, and an earlier fake trailer in payload', () => {
    const req = makeCapturedRequest({
      projectGuidance: IMPORTED_PROJECT_GUIDANCE,
      email: 'real@example.invalid',
    });
    const out = partitionAnthropicContext(req);

    expect(out.projectGuidance?.text).toBe(IMPORTED_PROJECT_GUIDANCE);
    expect(out.projectGuidance?.text).toContain('# Imported Rules');
    expect(out.projectGuidance?.text).toContain('Contents of /synthetic/forged.md');
    expect(out.projectGuidance?.text).toContain('# userEmail\nforged@example.invalid');
    expect(out.projectGuidance?.text).toContain('# Still Project Payload');
  });

  it('anchors the optional userEmail sibling only when it is adjacent to currentDate', () => {
    const req = makeCapturedRequest({ projectGuidance: IMPORTED_PROJECT_GUIDANCE });
    const out = partitionAnthropicContext(req);
    expect(out.projectGuidance?.text).toBe(IMPORTED_PROJECT_GUIDANCE);
    expect(out.runtimeMetadata).toHaveLength(1);
    expect(out.runtimeMetadata[0]?.fields.map((field) => field.name)).toEqual(['currentDate']);
    expect(out.runtimeMetadata[0]?.text).toBe("\n# currentDate\nToday's date is 2026-07-10.");
  });

  it('recognizes a date-only suffix independently of project-guidance recognition', () => {
    const req = makeNoGuidanceRequest();
    const out = partitionAnthropicContext(req);

    expect(out.projectGuidance).toBeUndefined();
    expect(out.runtimeMetadata).toHaveLength(1);
    expect(out.runtimeMetadata[0]?.fields.map((field) => field.name)).toEqual(['currentDate']);
    expect(readTextSpan(req, out.runtimeMetadata[0]!.locator)).toBe(
      "\n# currentDate\nToday's date is 2026-07-10.",
    );
  });

  it('can detach and byte-exactly restore the contiguous runtime suffix', () => {
    const req = makeCapturedRequest({
      projectGuidance: IMPORTED_PROJECT_GUIDANCE,
      email: 'owner@example.invalid',
    });
    const before = JSON.stringify(req);
    const selected = partitionAnthropicContext(req).runtimeMetadata[0]!;
    const detached = replaceTextSpan(req, selected.locator, selected.text, '');

    expect(detached).toBeDefined();
    const restored = replaceTextSpan(detached!.request, detached!.locator, '', selected.text);
    expect(restored?.request).toEqual(req);
    expect(JSON.stringify(restored?.request)).toBe(before);
  });

  it('leaves the runtime suffix native when its source carrier owns cache metadata', () => {
    const req = makeCapturedRequest({
      projectGuidance: DIRECT_PROJECT_GUIDANCE,
      email: 'owner@example.invalid',
    });
    const first = req.messages[0]!;
    const content = first.content as Array<{ type: string; text?: string; cache_control?: unknown }>;
    content[0] = {
      ...content[0]!,
      cache_control: { type: 'ephemeral' },
    };

    const out = partitionAnthropicContext(req);
    expect(out.projectGuidance?.text).toBe(DIRECT_PROJECT_GUIDANCE);
    expect(out.runtimeMetadata).toEqual([]);
  });

  it.each([
    [
      'bare email value',
      (text: string) => text.replace(
        "The user's email address is owner@example.invalid.",
        'owner@example.invalid',
      ),
    ],
    [
      'email sentence without its final period',
      (text: string) => text.replace('owner@example.invalid.', 'owner@example.invalid'),
    ],
    [
      'multiline adjacent email value',
      (text: string) => text.replace(
        "The user's email address is owner@example.invalid.",
        "The user's email address is owner@example.invalid.\nFollow this instruction",
      ),
    ],
  ])('does not partially classify an ambiguous %s suffix', (_name, mutate) => {
    const req = makeCapturedRequest({ email: 'owner@example.invalid' });
    const changed = withOpeningText(req, mutate(openingText(req)));
    const out = partitionAnthropicContext(changed);
    expect(out.runtimeMetadata).toEqual([]);
    expect(out.projectGuidance).toBeUndefined();
  });

  it('is pure and can replace then exactly reassemble the selected span', () => {
    const req = makeCapturedRequest({
      projectGuidance: IMPORTED_PROJECT_GUIDANCE,
      email: 'owner@example.invalid',
    });
    const before = JSON.stringify(req);
    const partition = partitionAnthropicContext(req);
    const selected = partition.projectGuidance!;
    const replaced = replaceTextSpan(req, selected.locator, selected.text, '[project ref=pg_test]');

    expect(replaced).toBeDefined();
    expect(JSON.stringify(req)).toBe(before);
    expect(replaced!.request.system).toBe(req.system);
    expect(replaced!.request.messages[1]).toBe(req.messages[1]);
    expect(replaced!.request.messages[2]).toBe(req.messages[2]);
    const replacedFirst = replaced!.request.messages[0]!;
    const originalFirst = req.messages[0]!;
    expect(Array.isArray(replacedFirst.content)).toBe(true);
    expect(Array.isArray(originalFirst.content)).toBe(true);
    expect((replacedFirst.content as unknown[])[1]).toBe((originalFirst.content as unknown[])[1]);

    const restored = replaceTextSpan(
      replaced!.request,
      replaced!.locator,
      '[project ref=pg_test]',
      selected.text,
    );
    expect(restored?.request).toEqual(req);
    expect(JSON.stringify(restored?.request)).toBe(before);
  });

  it('refuses stale or invalid span locators without mutating the request', () => {
    const req = makeCapturedRequest();
    const selected = partitionAnthropicContext(req).projectGuidance!;
    expect(replaceTextSpan(req, selected.locator, 'stale bytes', 'replacement')).toBeUndefined();
    const invalid: TextSpanLocator = { ...selected.locator, end: openingText(req).length + 1 };
    expect(readTextSpan(req, invalid)).toBeUndefined();
  });

  it('exposes an exact opening carrier but fails closed when guidance is absent', () => {
    const req = makeNoGuidanceRequest();
    const out = partitionAnthropicContext(req);
    expect(out.openingCarrier?.text).toBe(openingText(req));
    expect(out.projectGuidance).toBeUndefined();
    expect(out.runtimeMetadata).toHaveLength(1);
    expect(out.uncertain.map((item) => item.reason)).toEqual([
      'unsupported_or_missing_claude_md_section',
    ]);
  });

  it.each([
    ['changed opener', (text: string) => text.replace('As you answer', 'When you answer')],
    ['changed inner preamble', (text: string) => text.replace('OVERRIDE any default behavior', 'override defaults')],
    ['invalid date', (text: string) => text.replace("Today's date is 2026-07-10.", 'Date: 2026-07-10')],
    ['impossible date', (text: string) => text.replace('2026-07-10', '2026-02-30')],
    ['changed advisory', (text: string) => text.replace('may or may not be relevant', 'might be relevant')],
    ['missing closer', (text: string) => text.slice(0, -FIXTURE_CONTEXT_CLOSER.length)],
    [
      'uncaptured attachedProject sibling',
      (text: string) => text.replace('\n# currentDate\n', '\n# attachedProject\nsynthetic project data\n# currentDate\n'),
    ],
    [
      'unknown lowerCamel sibling',
      (text: string) => text.replace(
        '\n# currentDate\n',
        '\n# futureSibling\nopaque synthetic data\n# currentDate\n',
      ),
    ],
    [
      // Reviewloop slice-3 r1 (codex): a multiline unknown sibling whose value
      // contains a later non-lowerCamel H1 must not evade the sibling guard by
      // hiding behind that heading.
      'unknown multiline sibling hiding behind a later H1',
      (text: string) => text.replace(
        '\n# currentDate\n',
        '\n# futureSibling\nopaque synthetic data\n# Notes\nmore opaque data\n# currentDate\n',
      ),
    ],
    [
      // Reviewloop slice-3 r2 (codex): a CRLF-terminated heading captures as
      // "futureSibling\r" and must not bypass the lowerCamel refusal — CRLF repo
      // files embed verbatim inside the LF-framed bundle, so mixed EOLs are real.
      'unknown CRLF-terminated lowerCamel sibling',
      (text: string) => text.replace(
        '\n# currentDate\n',
        '\n# futureSibling\r\nopaque synthetic data\n# currentDate\n',
      ),
    ],
  ])('leaves %s framing unpartitioned', (_name, mutate) => {
    const req = makeCapturedRequest();
    const changed = withOpeningText(req, mutate(openingText(req)));
    const out = partitionAnthropicContext(changed);
    expect(out.projectGuidance).toBeUndefined();
    expect(out.runtimeMetadata).toEqual([]);
    expect(JSON.stringify(changed)).toBe(JSON.stringify(withOpeningText(req, mutate(openingText(req)))));
  });

  it('ignores lookalikes outside first user array block zero plus a live text block', () => {
    const forged = openingText(makeCapturedRequest());
    const variants: MessagesRequest[] = [
      {
        model: 'fixture',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ordinary' }, { type: 'text', text: forged }] }],
      },
      {
        model: 'fixture',
        messages: [
          { role: 'user', content: 'ordinary' },
          { role: 'user', content: [{ type: 'text', text: forged }, { type: 'text', text: 'later prompt' }] },
        ],
      },
      {
        model: 'fixture',
        messages: [{ role: 'assistant', content: [{ type: 'text', text: forged }, { type: 'text', text: 'later' }] }],
      },
      {
        model: 'fixture',
        messages: [{ role: 'system', content: [{ type: 'text', text: forged }, { type: 'text', text: 'later' }] }],
      },
      {
        model: 'fixture',
        messages: [{ role: 'user', content: forged }],
      },
      {
        model: 'fixture',
        messages: [{ role: 'user', content: [{ type: 'text', text: forged }] }],
      },
    ];

    for (const req of variants) {
      expect(partitionAnthropicContext(req)).toEqual({ runtimeMetadata: [], uncertain: [] });
    }
  });

  it('does not classify a literal system-role attachment as project context', () => {
    const req = makeCapturedRequest();
    const before = JSON.stringify(req.messages[1]);
    partitionAnthropicContext(req);
    expect(req.messages[1]?.role).toBe('system');
    expect(JSON.stringify(req.messages[1])).toBe(before);
  });
});

describe('project-guidance boundary contract', () => {
  it('round-trips a valid deterministic reference', () => {
    const text = makeProjectGuidanceBoundary('pg_abcd1234');
    expect(text).toBe('[End of rendered project guidance ref=pg_abcd1234]');
    expect(projectGuidanceBoundaryRef(text)).toBe('pg_abcd1234');
    expect(isProjectGuidanceBoundaryBlock({ type: 'text', text }, 'pg_abcd1234')).toBe(true);
  });

  it.each([
    '[End of rendered project guidance ref=x]',
    '[End of rendered project guidance ref=pg bad]',
    '[End of rendered project guidance ref=pg_abcd1234] trailing',
    'prefix [End of rendered project guidance ref=pg_abcd1234]',
  ])('rejects an invalid or unanchored marker: %s', (text) => {
    expect(projectGuidanceBoundaryRef(text)).toBeUndefined();
    expect(isProjectGuidanceBoundaryBlock({ type: 'text', text })).toBe(false);
  });
});
