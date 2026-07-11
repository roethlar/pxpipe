import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildClientCandidate,
  buildUninstallCandidate,
  decodeToml,
  findLegacyFootprints,
  parseAndIndexToml,
  validateClientConfigReceipt,
  verifyReceiptOwnership,
} from '../src/macos-local-config.js';

const bytes = (value: string): Uint8Array => Buffer.from(value, 'utf8');
const text = (value: Uint8Array): string => Buffer.from(value).toString('utf8');
const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

const resealReceipt = (input: unknown): unknown => {
  const receipt = structuredClone(input) as Record<string, unknown>;
  const edits = receipt.edits as Array<Record<string, unknown>>;
  const payload = {
    schemaVersion: receipt.schemaVersion,
    client: receipt.client,
    fileExisted: receipt.fileExisted,
    originalFileSha256: receipt.originalFileSha256,
    ownerFileSha256: receipt.ownerFileSha256,
    appliedFileSha256: receipt.appliedFileSha256,
    edits: edits.map((edit) => {
      if (edit.kind === 'replace') {
        return {
          kind: edit.kind,
          table: edit.table,
          key: edit.key,
          originalRhsBase64: edit.originalRhsBase64,
          appliedRhsBase64: edit.appliedRhsBase64,
        };
      }
      if (edit.kind === 'insert-key') {
        return {
          kind: edit.kind,
          table: edit.table,
          key: edit.key,
          appliedLineBase64: edit.appliedLineBase64,
          appliedStart: edit.appliedStart,
          ownedPrefixBase64: edit.ownedPrefixBase64,
          ownedSuffixBase64: edit.ownedSuffixBase64,
        };
      }
      return {
        kind: edit.kind,
        table: edit.table,
        appliedLineBase64: edit.appliedLineBase64,
        appliedStart: edit.appliedStart,
        ownedPrefixBase64: edit.ownedPrefixBase64,
        ownedSuffixBase64: edit.ownedSuffixBase64,
      };
    }),
  };
  receipt.ledgerSha256 = createHash('sha256')
    .update(JSON.stringify(payload), 'utf8')
    .digest('hex');
  return receipt;
};

describe('macOS local client config editor', () => {
  it('creates the complete fixed Codex and Grok configurations', () => {
    const codex = buildClientCandidate('codex', null, 47821);
    expect(text(codex.bytes)).toBe([
      'model = "gpt-5.6-sol"',
      'model_provider = "pxpipe_local"',
      '',
      '[model_providers.pxpipe_local]',
      'name = "pxpipe local"',
      'base_url = "http://127.0.0.1:47821/_pxpipe/codex"',
      'wire_api = "responses"',
      'requires_openai_auth = true',
      'supports_websockets = false',
    ].join('\n'));

    const grok = buildClientCandidate('grok', null, 47821);
    expect(text(grok.bytes)).toBe([
      '[models]',
      'default = "grok-4.5"',
      '',
      '[endpoints]',
      'cli_chat_proxy_base_url = "http://127.0.0.1:47821/_pxpipe/grok/v1"',
    ].join('\n'));
    expect(codex.receipt.fileExisted).toBe(false);
    expect(grok.receipt.fileExisted).toBe(false);
  });

  it('preserves BOM, CRLF, comments, spacing, Unicode, and final-newline state', () => {
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from([
        '# café',
        'model   =   "old"   # keep this comment',
        'unrelated = "雪"',
        '',
        '[model_providers.pxpipe_local]',
        'name = "owner name" # same line',
      ].join('\r\n')),
    ]);
    const candidate = buildClientCandidate('codex', original, 47991);
    const output = Buffer.from(candidate.bytes);
    expect(output.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const body = output.subarray(3).toString('utf8');
    expect(body).toContain('model   =   "gpt-5.6-sol"   # keep this comment');
    expect(body).toContain('unrelated = "雪"');
    expect(body).toContain('name = "pxpipe local" # same line');
    expect(body).toContain('\r\n');
    expect(body).not.toMatch(/(^|[^\r])\n/u);
    expect(body.endsWith('\n')).toBe(false);
  });

  it('uses full TOML parsing and rejects invalid UTF-8', () => {
    expect(() => parseAndIndexToml(bytes('x = [\n'))).toThrow(/invalid TOML/u);
    expect(() => decodeToml(Uint8Array.from([0xc3, 0x28]))).toThrow(/UTF-8/u);
  });

  it('rejects duplicate BOMs and bare carriage returns', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    expect(() => decodeToml(Buffer.concat([bom, bom, bytes('x = true')]))).toThrow(/BOM/u);
    expect(() => decodeToml(bytes('x = true\ry = true'))).toThrow(/carriage return/u);
  });

  it('preserves valid mixed LF and CRLF owner bytes exactly', () => {
    const original = bytes('# LF owner\n[owner]\r\nkeep = "雪"\r\n# final LF\n');
    for (const kind of ['codex', 'grok'] as const) {
      const candidate = buildClientCandidate(kind, original, 47821);
      const uninstall = buildUninstallCandidate(candidate.bytes, candidate.receipt);
      expect(uninstall.bytes).not.toBeNull();
      expect(Buffer.from(uninstall.bytes!)).toEqual(Buffer.from(original));
    }
  });

  it('ignores source-like text inside unrelated multiline strings and arrays', () => {
    const original = bytes([
      'note = """',
      '[model_providers.pxpipe_local]',
      'name = "not TOML syntax here"',
      '"""',
      'matrix = [',
      '  [1],',
      '  [2],',
      ']',
      '',
      '["owner table"]',
      'keep = true',
      '',
    ].join('\n'));
    const candidate = buildClientCandidate('codex', original, 47821);
    const uninstall = buildUninstallCandidate(candidate.bytes, candidate.receipt);
    expect(Buffer.from(uninstall.bytes!)).toEqual(Buffer.from(original));
    expect(findLegacyFootprints('codex', original)).toEqual([]);
  });

  it('accepts a single-line literal scalar and restores its exact bytes', () => {
    const original = bytes("model = 'owner-model' # literal\n");
    const candidate = buildClientCandidate('codex', original, 47821);
    const uninstall = buildUninstallCandidate(candidate.bytes, candidate.receipt);
    expect(Buffer.from(uninstall.bytes!)).toEqual(Buffer.from(original));
  });

  it.each([
    '"model" = "old"\n',
    'model = ["old"]\n',
    '["model_providers".pxpipe_local]\nname = "x"\n',
    'model_providers.pxpipe_local.name = "x"\n',
    '[[model_providers.pxpipe_local]]\nname = "x"\n',
    'model = """old"""\n',
  ])('rejects an ambiguous managed Codex shape: %s', (source) => {
    expect(() => buildClientCandidate('codex', bytes(source), 47821)).toThrow(
      /managed TOML|ambiguous/u,
    );
  });

  it.each([
    'models_base_url = "https://api.x.ai"\n',
    '"models_base_url" = "https://api.x.ai"\n',
    '[endpoints]\nmodels_base_url = "https://api.x.ai"\n',
    'endpoints.models_base_url = "https://api.x.ai"\n',
    '[other]\nmodels_base_url = "https://api.x.ai"\n',
  ])('refuses every parsed Grok API-key-flow key: %s', (source) => {
    expect(() => buildClientCandidate('grok', bytes(source), 47821)).toThrow(
      /models_base_url/u,
    );
  });

  it('updates a managed port after unrelated edits and preserves original reversal bytes', () => {
    const original = bytes([
      'model = "owner-model" # original',
      '',
      '[other]',
      'keep = 1',
      '',
    ].join('\n'));
    const first = buildClientCandidate('codex', original, 47821);
    const withOwnerEdit = bytes(`${text(first.bytes)}\n# later owner edit\n`);
    const second = buildClientCandidate('codex', withOwnerEdit, 47991, first.receipt);
    expect(text(second.bytes)).toContain('http://127.0.0.1:47991/_pxpipe/codex');
    expect(text(second.bytes)).toContain('# later owner edit');
    expect(
      second.receipt.edits.find((edit) => edit.kind === 'replace' && edit.key === 'model'),
    ).toMatchObject({
      originalRhsBase64: Buffer.from('"owner-model"').toString('base64'),
    });

    const uninstall = buildUninstallCandidate(second.bytes, second.receipt);
    expect(uninstall.bytes).not.toBeNull();
    const restored = text(uninstall.bytes!);
    expect(restored).toContain('model = "owner-model" # original');
    expect(restored).toContain('# later owner edit');
    expect(restored).not.toContain('_pxpipe');
    expect(restored).not.toMatch(/^model_provider\s*=/mu);
  });

  it('accepts relocation of an exact unique managed insertion but rejects managed drift', () => {
    const first = buildClientCandidate('grok', bytes('[models]\n\n[endpoints]\n'), 47821);
    const source = text(first.bytes);
    const line = 'default = "grok-4.5"\n';
    const relocated = bytes(source.replace(line, '').replace('[models]\n', `[models]\n# owner\n${line}`));
    expect(() => verifyReceiptOwnership(relocated, first.receipt)).not.toThrow();

    const drifted = bytes(text(relocated).replace('default = "grok-4.5"', 'default = "owner"'));
    expect(() => verifyReceiptOwnership(drifted, first.receipt)).toThrow(/changed/u);
  });

  it('rejects reordered insertions that rebind an owned separator to owner bytes', () => {
    const candidate = buildClientCandidate('codex', bytes('owner = true\n'), 47821);
    const modelLine = 'model = "gpt-5.6-sol"\n';
    const providerLine = 'model_provider = "pxpipe_local"\n';
    const ownerCommentLine = `#${'x'.repeat(31)}\n`;
    expect(ownerCommentLine.length - 1).toBe(providerLine.length);

    const attacked = bytes(
      text(candidate.bytes)
        .replace(`${modelLine}${providerLine}`, `${providerLine}${modelLine}`)
        .replace(`${modelLine}\n[`, `${modelLine}${ownerCommentLine}[`)
      + '[owner2]\nkeep = true\n',
    );
    const unchanged = Buffer.from(attacked);

    expect(() => verifyReceiptOwnership(attacked, candidate.receipt)).toThrow(
      /order|owner-safe/u,
    );
    expect(Buffer.from(attacked)).toEqual(unchanged);
    expect(() => buildUninstallCandidate(attacked, candidate.receipt)).toThrow(
      /order|owner-safe/u,
    );
    expect(Buffer.from(attacked)).toEqual(unchanged);
  });

  it('fails closed when an owner edit splits a managed prefix separator', () => {
    const first = buildClientCandidate('codex', bytes('# owner'), 47821);
    const ownerEdited = bytes(
      text(first.bytes).replace('\nmodel =', '\n# later owner comment\nmodel ='),
    );
    expect(() => verifyReceiptOwnership(ownerEdited, first.receipt)).toThrow(
      /prefix moved|owner-safe/u,
    );
    expect(() => buildUninstallCandidate(ownerEdited, first.receipt)).toThrow(
      /prefix moved|owner-safe/u,
    );
    expect(text(ownerEdited)).toContain('# later owner comment\n');
  });

  it('allows a created managed block to move behind prepended owner bytes', () => {
    for (const kind of ['codex', 'grok'] as const) {
      const first = buildClientCandidate(kind, null, 47821);
      const ownerPrefix = '# prepended owner comment\n';
      const ownerEdited = bytes(`${ownerPrefix}${text(first.bytes)}`);
      expect(() => verifyReceiptOwnership(ownerEdited, first.receipt)).not.toThrow();
      const uninstall = buildUninstallCandidate(ownerEdited, first.receipt);
      expect(uninstall.bytes).not.toBeNull();
      expect(text(uninstall.bytes!)).toBe(ownerPrefix);
    }
  });

  it('allows an appended managed block to move behind prepended owner bytes', () => {
    const original = bytes('owner = true\n');
    const first = buildClientCandidate('grok', original, 47821);
    const earliestInsertion = first.receipt.edits
      .filter((edit) => edit.kind !== 'replace')
      .sort((left, right) => left.appliedStart - right.appliedStart)[0];
    expect(earliestInsertion?.kind).toBe('insert-table');
    expect(
      Buffer.from(earliestInsertion!.ownedPrefixBase64, 'base64').toString('utf8'),
    ).toBe('\n');

    const ownerPrefix = '# prepended owner comment\n';
    const ownerEdited = bytes(`${ownerPrefix}${text(first.bytes)}`);
    expect(() => verifyReceiptOwnership(ownerEdited, first.receipt)).not.toThrow();

    const reinstall = buildClientCandidate('grok', ownerEdited, 47821, first.receipt);
    expect(Buffer.from(reinstall.bytes)).toEqual(Buffer.from(ownerEdited));
    const uninstall = buildUninstallCandidate(reinstall.bytes, reinstall.receipt);
    expect(uninstall.bytes).not.toBeNull();
    expect(text(uninstall.bytes!)).toBe(`${ownerPrefix}${text(original)}`);
  });

  it('binds insertion ownership to its exact line-ending bytes', () => {
    const candidate = buildClientCandidate('grok', bytes('[models]\n'), 47821);
    const changedLineEndings = bytes(text(candidate.bytes).replace(/\n/gu, '\r\n'));
    expect(() => verifyReceiptOwnership(changedLineEndings, candidate.receipt)).toThrow(
      /separator|line endings/u,
    );
  });

  it('retains an inserted table header when the owner adds trivia inside it', () => {
    const original = bytes('[models]\n');
    const candidate = buildClientCandidate('grok', original, 47821);
    const ownerEdited = bytes(
      text(candidate.bytes).replace('[endpoints]\n', '[endpoints]\n   \n'),
    );
    const uninstall = buildUninstallCandidate(ownerEdited, candidate.receipt);
    expect(text(uninstall.bytes!)).toBe('[models]\n\n[endpoints]\n   \n');
  });

  it('deletes an unchanged created file but retains owner additions', () => {
    const created = buildClientCandidate('grok', null, 47821);
    expect(buildUninstallCandidate(created.bytes, created.receipt).bytes).toBeNull();

    const ownerAdded = bytes(`${text(created.bytes)}\n\n[owner]\nkeep = true\n`);
    const uninstall = buildUninstallCandidate(ownerAdded, created.receipt);
    expect(uninstall.bytes).not.toBeNull();
    expect(text(uninstall.bytes!)).toContain('[owner]\nkeep = true');
    expect(text(uninstall.bytes!)).not.toContain('_pxpipe');
    expect(text(uninstall.bytes!)).not.toContain('grok-4.5');
  });

  it('deletes a still-wholly-managed created file after a clean port update', () => {
    for (const kind of ['codex', 'grok'] as const) {
      const first = buildClientCandidate(kind, null, 47821);
      const updated = buildClientCandidate(kind, first.bytes, 47991, first.receipt);
      expect(updated.receipt.appliedFileSha256).not.toBe(first.receipt.appliedFileSha256);
      expect(buildUninstallCandidate(updated.bytes, updated.receipt).bytes).toBeNull();
    }
  });

  it('does not adopt owner additions into created-file whole-file ownership', () => {
    const first = buildClientCandidate('grok', null, 47821);
    const ownerEdited = bytes(`${text(first.bytes)}\n\n[owner]\nkeep = true\n`);
    const updated = buildClientCandidate('grok', ownerEdited, 47991, first.receipt);
    expect(updated.receipt.appliedFileSha256).toBe(first.receipt.appliedFileSha256);
    const uninstall = buildUninstallCandidate(updated.bytes, updated.receipt);
    expect(uninstall.bytes).not.toBeNull();
    expect(text(uninstall.bytes!)).toContain('[owner]\nkeep = true\n');
  });

  it('recovers whole-file ownership after a temporary owner edit is removed', () => {
    const first = buildClientCandidate('grok', null, 47821);
    const withOwnerEdit = bytes(`${text(first.bytes)}\n\n[owner]\nkeep = true\n`);
    const portUpdate = buildClientCandidate('grok', withOwnerEdit, 47991, first.receipt);
    const cleanAgain = bytes(
      text(portUpdate.bytes).replace(/\n\n\[owner\]\nkeep = true\n$/u, ''),
    );
    const cleanReinstall = buildClientCandidate(
      'grok',
      cleanAgain,
      47991,
      portUpdate.receipt,
    );
    expect(cleanReinstall.receipt.appliedFileSha256).not.toBe(first.receipt.appliedFileSha256);
    expect(buildUninstallCandidate(cleanReinstall.bytes, cleanReinstall.receipt).bytes).toBeNull();
  });

  it.each([
    { name: 'empty', source: Buffer.alloc(0) },
    { name: 'comment without newline', source: Buffer.from('# owner') },
    { name: 'comment with newline', source: Buffer.from('# owner\n') },
    {
      name: 'BOM and CRLF',
      source: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('# owner\r\n', 'utf8'),
      ]),
    },
  ])('round-trips every byte of an existing $name file on uninstall', ({ source }) => {
    for (const kind of ['codex', 'grok'] as const) {
      const candidate = buildClientCandidate(kind, source, 47821);
      const uninstall = buildUninstallCandidate(candidate.bytes, candidate.receipt);
      expect(uninstall.bytes).not.toBeNull();
      expect(Buffer.from(uninstall.bytes!)).toEqual(source);
    }
  });

  it('detects only the four managed legacy footprints, not common model values', () => {
    expect(findLegacyFootprints('codex', bytes('model = "gpt-5.6-sol"\n'))).toEqual([]);
    expect(findLegacyFootprints('codex', bytes('model_provider = "pxpipe_local"\n'))).toContain(
      'codex-model-provider',
    );
    expect(findLegacyFootprints('codex', bytes([
      '[model_providers.other]',
      'base_url = "http://localhost:47821/_pxpipe/codex"',
    ].join('\n')))).toContain('codex-loopback-base');
    expect(findLegacyFootprints('codex', bytes([
      '[model_providers.other]',
      'base_url = "http://user@localhost:47821/_pxpipe/codex"',
    ].join('\n')))).not.toContain('codex-loopback-base');
    expect(findLegacyFootprints('grok', bytes([
      '[endpoints]',
      'cli_chat_proxy_base_url = "http://[::1]:47821/_pxpipe/grok/v1"',
    ].join('\n')))).toContain('grok-loopback-endpoint');
    expect(findLegacyFootprints('codex', bytes([
      '[model_providers.other]',
      'base_url = "http://127.255.42.7:47821/_pxpipe/codex"',
    ].join('\n')))).toContain('codex-loopback-base');
    expect(findLegacyFootprints('grok', bytes([
      '[endpoints]',
      'cli_chat_proxy_base_url = "http://localhost.:47821/_pxpipe/grok/v1"',
    ].join('\n')))).toContain('grok-loopback-endpoint');
    expect(findLegacyFootprints('codex', bytes([
      '[model_providers.other]',
      'base_url = "https://127.0.0.42:47821/_pxpipe/codex"',
    ].join('\n')))).toContain('codex-loopback-base');
    expect(findLegacyFootprints('codex', bytes([
      '[model_providers.other]',
      'base_url = "http://[::ffff:127.0.0.1]:47821/_pxpipe/codex"',
    ].join('\n')))).toContain('codex-loopback-base');
    expect(findLegacyFootprints('grok', bytes([
      '[endpoints]',
      'cli_chat_proxy_base_url = "https://localhost.:47821/_pxpipe/grok/v1"',
    ].join('\n')))).toContain('grok-loopback-endpoint');
    expect(findLegacyFootprints('grok', bytes([
      '[endpoints]',
      'cli_chat_proxy_base_url = "https://[::ffff:127.42.3.9]:47821/_pxpipe/grok/v1"',
    ].join('\n')))).toContain('grok-loopback-endpoint');
  });

  it('rejects a receipt whose existence claim was flipped over owner data', () => {
    for (const kind of ['codex', 'grok'] as const) {
      const candidate = buildClientCandidate(kind, bytes('# OWNER DATA\n'), 47821);
      const flipped = resealReceipt({ ...candidate.receipt, fileExisted: false });
      expect(() => validateClientConfigReceipt(flipped, kind)).toThrow(/nonempty original/u);
      expect(() => buildUninstallCandidate(candidate.bytes, flipped)).toThrow(
        /nonempty original/u,
      );
    }
  });

  it('rejects forged table ownership against the recorded owner-file identity', () => {
    const candidate = buildClientCandidate('grok', bytes('[models]\n'), 47821);
    const forged = resealReceipt({
      ...candidate.receipt,
      edits: [
        ...candidate.receipt.edits,
        {
          kind: 'insert-table',
          table: 'models',
          appliedLineBase64: base64('[models]'),
          appliedStart: 0,
          ownedPrefixBase64: '',
          ownedSuffixBase64: base64('\n'),
        },
      ],
    });
    expect(() => validateClientConfigReceipt(forged, 'grok')).not.toThrow();
    expect(() => buildUninstallCandidate(candidate.bytes, forged)).toThrow(
      /recorded owner identity/u,
    );
  });

  it('strictly validates receipt structure and ownership identities', () => {
    const candidate = buildClientCandidate('grok', null, 47821);
    expect(validateClientConfigReceipt(candidate.receipt, 'grok')).toEqual(candidate.receipt);
    expect(() => validateClientConfigReceipt({ ...candidate.receipt, extra: true })).toThrow(
      /receipt/u,
    );
    expect(() => validateClientConfigReceipt({
      ...candidate.receipt,
      edits: [...candidate.receipt.edits, candidate.receipt.edits[0]],
    })).toThrow(/duplicate/u);

    const movedInsertion = candidate.receipt.edits.map((edit) =>
      edit.kind === 'insert-key'
        ? { ...edit, appliedStart: edit.appliedStart + 1 }
        : edit
    );
    expect(() => validateClientConfigReceipt({
      ...candidate.receipt,
      edits: movedInsertion,
    })).toThrow(/ledger digest/u);

    const unexpectedIdentity = candidate.receipt.edits.map((edit, index) =>
      index === 0 && edit.kind !== 'insert-table'
        ? { ...edit, table: 'owner', key: 'secret' }
        : edit
    );
    expect(() => validateClientConfigReceipt({
      ...candidate.receipt,
      edits: unexpectedIdentity,
    })).toThrow(/unexpected key/u);

    const unexpectedValue = candidate.receipt.edits.map((edit, index) =>
      index === 0 && edit.kind === 'insert-key'
        ? { ...edit, appliedLineBase64: base64('default = "attacker"') }
        : edit
    );
    expect(() => validateClientConfigReceipt({
      ...candidate.receipt,
      edits: unexpectedValue,
    })).toThrow(/unexpected applied value/u);

    const replaced = buildClientCandidate(
      'grok',
      bytes('[models]\ndefault = "owner"\n'),
      47821,
    );
    const invalidOriginal = replaced.receipt.edits.map((edit) =>
      edit.kind === 'replace'
        ? { ...edit, originalRhsBase64: base64('"""unterminated') }
        : edit
    );
    expect(() => validateClientConfigReceipt({
      ...replaced.receipt,
      edits: invalidOriginal,
    })).toThrow(/original RHS/u);
  });

  it('rejects unknown client kinds at the runtime boundary', () => {
    expect(() => buildClientCandidate(
      'other' as unknown as 'codex',
      null,
      47821,
    )).toThrow(/codex or grok/u);
    expect(() => findLegacyFootprints(
      'other' as unknown as 'grok',
      bytes(''),
    )).toThrow(/codex or grok/u);
  });
});
