import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export type ClientConfigKind = 'codex' | 'grok';

export interface ManagedIdentity {
  readonly table: string;
  readonly key: string;
}

export type ManagedReceiptEdit =
  | (ManagedIdentity & {
      readonly kind: 'replace';
      readonly originalRhsBase64: string;
      readonly appliedRhsBase64: string;
    })
  | (ManagedIdentity & {
      readonly kind: 'insert-key';
      readonly appliedLineBase64: string;
      readonly appliedStart: number;
      readonly ownedPrefixBase64: string;
      readonly ownedSuffixBase64: string;
    })
  | {
      readonly kind: 'insert-table';
      readonly table: string;
      readonly appliedLineBase64: string;
      readonly appliedStart: number;
      readonly ownedPrefixBase64: string;
      readonly ownedSuffixBase64: string;
    };

export interface ClientConfigReceipt {
  readonly schemaVersion: 1;
  readonly client: ClientConfigKind;
  readonly fileExisted: boolean;
  /** Hash of the file bytes before pxpipe first managed this client. */
  readonly originalFileSha256: string;
  /** Hash produced by reversing this ledger before any later owner edits. */
  readonly ownerFileSha256: string;
  readonly appliedFileSha256: string;
  readonly edits: readonly ManagedReceiptEdit[];
  /** Canonical digest binding every field above into one receipt. */
  readonly ledgerSha256: string;
}

export interface ClientConfigCandidate {
  readonly bytes: Uint8Array;
  readonly receipt: ClientConfigReceipt;
  readonly changed: boolean;
}

export interface ClientUninstallCandidate {
  /** null means the complete pxpipe-created file can be deleted. */
  readonly bytes: Uint8Array | null;
  readonly changed: boolean;
}

interface ManagedSpec extends ManagedIdentity {
  readonly value: string | boolean;
}

interface IndexedLine {
  readonly start: number;
  readonly end: number;
  readonly endWithEol: number;
  readonly raw: string;
  readonly eol: string;
  readonly isHeader?: boolean;
  readonly table?: string;
  readonly key?: string;
  readonly rhsStart?: number;
  readonly rhsEnd?: number;
}

interface TomlIndex {
  readonly bom: boolean;
  readonly text: string;
  readonly eol: '\n' | '\r\n';
  readonly finalNewline: boolean;
  readonly parsed: Record<string, unknown>;
  readonly lines: readonly IndexedLine[];
  readonly entries: ReadonlyMap<string, readonly IndexedLine[]>;
  readonly headers: ReadonlyMap<string, readonly IndexedLine[]>;
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
  readonly order: number;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HASH_RE = /^[0-9a-f]{64}$/u;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const EMPTY_SHA256 = sha256(new Uint8Array());

const CODEX_SPECS = (port: number): readonly ManagedSpec[] => [
  { table: '', key: 'model', value: 'gpt-5.6-sol' },
  { table: '', key: 'model_provider', value: 'pxpipe_local' },
  { table: 'model_providers.pxpipe_local', key: 'name', value: 'pxpipe local' },
  {
    table: 'model_providers.pxpipe_local',
    key: 'base_url',
    value: `http://127.0.0.1:${port}/_pxpipe/codex`,
  },
  { table: 'model_providers.pxpipe_local', key: 'wire_api', value: 'responses' },
  {
    table: 'model_providers.pxpipe_local',
    key: 'requires_openai_auth',
    value: true,
  },
  {
    table: 'model_providers.pxpipe_local',
    key: 'supports_websockets',
    value: false,
  },
];

const GROK_SPECS = (port: number): readonly ManagedSpec[] => [
  { table: 'models', key: 'default', value: 'grok-4.5' },
  {
    table: 'endpoints',
    key: 'cli_chat_proxy_base_url',
    value: `http://127.0.0.1:${port}/_pxpipe/grok/v1`,
  },
];

function identityKey(identity: ManagedIdentity): string {
  return `${identity.table}\u0000${identity.key}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function encodeBase64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

type UnsealedClientConfigReceipt = Omit<ClientConfigReceipt, 'ledgerSha256'>;

function canonicalReceiptPayload(receipt: UnsealedClientConfigReceipt): string {
  return JSON.stringify({
    schemaVersion: receipt.schemaVersion,
    client: receipt.client,
    fileExisted: receipt.fileExisted,
    originalFileSha256: receipt.originalFileSha256,
    ownerFileSha256: receipt.ownerFileSha256,
    appliedFileSha256: receipt.appliedFileSha256,
    edits: receipt.edits.map((edit) => {
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
  });
}

function receiptLedgerSha256(receipt: UnsealedClientConfigReceipt): string {
  return sha256(Buffer.from(canonicalReceiptPayload(receipt), 'utf8'));
}

function sealReceipt(receipt: UnsealedClientConfigReceipt): ClientConfigReceipt {
  return { ...receipt, ledgerSha256: receiptLedgerSha256(receipt) };
}

function decodeBase64(value: string, label: string): string {
  if (!BASE64_RE.test(value)) throw new Error(`${label} is not canonical base64`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label} is not canonical base64`);
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function encodeTomlString(value: string): string {
  return JSON.stringify(value);
}

function encodeTomlValue(value: string | boolean): string {
  return typeof value === 'boolean' ? String(value) : encodeTomlString(value);
}

export function decodeToml(bytes: Uint8Array): {
  readonly bom: boolean;
  readonly text: string;
} {
  const input = Buffer.from(bytes);
  const bom = input.subarray(0, 3).equals(UTF8_BOM);
  const body = bom ? input.subarray(3) : input;
  if (body.subarray(0, 3).equals(UTF8_BOM)) {
    throw new Error('client config contains more than one UTF-8 BOM');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new Error('client config is not valid UTF-8');
  }
  if (text.includes('\u0000')) throw new Error('client config contains a NUL byte');
  if (text.replace(/\r\n/gu, '').includes('\r')) {
    throw new Error('client config contains a bare carriage return');
  }
  return { bom, text };
}

function encodeToml(text: string, bom: boolean): Uint8Array {
  const body = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([UTF8_BOM, body]) : body;
}

function scalarToken(rest: string): { start: number; end: number } | undefined {
  let start = 0;
  while (rest[start] === ' ' || rest[start] === '\t') start += 1;
  if (start >= rest.length) return undefined;

  let end: number;
  if (rest[start] === '"') {
    let escaped = false;
    end = -1;
    for (let index = start + 1; index < rest.length; index += 1) {
      const char = rest[index];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        end = index + 1;
        break;
      }
    }
    if (end === -1) return undefined;
  } else if (rest[start] === "'") {
    const closing = rest.indexOf("'", start + 1);
    if (closing === -1) return undefined;
    end = closing + 1;
  } else {
    const match = /^(?:true|false)(?=[\t #]|$)/u.exec(rest.slice(start));
    if (!match) return undefined;
    end = start + match[0].length;
  }

  const suffix = rest.slice(end);
  if (!/^[\t ]*(?:#.*)?$/u.test(suffix)) return undefined;
  return { start, end };
}

function splitLines(text: string): IndexedLine[] {
  const lines: IndexedLine[] = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const endWithEol = newline === -1 ? text.length : newline + 1;
    const crlf = newline !== -1 && text[newline - 1] === '\r';
    const end = newline === -1 ? text.length : crlf ? newline - 1 : newline;
    lines.push({
      start: offset,
      end,
      endWithEol,
      raw: text.slice(offset, end),
      eol: newline === -1 ? '' : crlf ? '\r\n' : '\n',
    });
    offset = endWithEol;
  }
  return lines;
}

type TomlStringMode = 'basic' | 'literal' | 'multiline-basic' | 'multiline-literal';

/**
 * Mark lines whose first byte is at TOML syntax level. The full parser remains
 * authoritative for validity; this scanner only prevents source-like text in
 * multiline strings and arrays from being mistaken for managed identities.
 */
function syntaxLevelLineStarts(lines: readonly IndexedLine[]): ReadonlySet<number> {
  const starts = new Set<number>();
  let stringMode: TomlStringMode | undefined;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (const line of lines) {
    if (stringMode === undefined && squareDepth === 0 && curlyDepth === 0) {
      starts.add(line.start);
    }

    const source = line.raw;
    for (let offset = 0; offset < source.length;) {
      if (stringMode === 'basic') {
        if (source[offset] === '\\') {
          offset += 2;
        } else if (source[offset] === '"') {
          stringMode = undefined;
          offset += 1;
        } else {
          offset += 1;
        }
        continue;
      }
      if (stringMode === 'literal') {
        if (source[offset] === "'") stringMode = undefined;
        offset += 1;
        continue;
      }
      if (stringMode === 'multiline-basic' || stringMode === 'multiline-literal') {
        const quote = stringMode === 'multiline-basic' ? '"' : "'";
        if (stringMode === 'multiline-basic' && source[offset] === '\\') {
          offset += 2;
          continue;
        }
        if (source[offset] !== quote) {
          offset += 1;
          continue;
        }
        let runEnd = offset;
        while (source[runEnd] === quote) runEnd += 1;
        if (runEnd - offset >= 3) stringMode = undefined;
        offset = runEnd;
        continue;
      }

      const char = source[offset];
      if (char === '#') break;
      if (source.startsWith('"""', offset)) {
        stringMode = 'multiline-basic';
        offset += 3;
      } else if (source.startsWith("'''", offset)) {
        stringMode = 'multiline-literal';
        offset += 3;
      } else if (char === '"') {
        stringMode = 'basic';
        offset += 1;
      } else if (char === "'") {
        stringMode = 'literal';
        offset += 1;
      } else {
        if (char === '[') squareDepth += 1;
        else if (char === ']') squareDepth = Math.max(0, squareDepth - 1);
        else if (char === '{') curlyDepth += 1;
        else if (char === '}') curlyDepth = Math.max(0, curlyDepth - 1);
        offset += 1;
      }
    }
  }
  return starts;
}

export function parseAndIndexToml(bytes: Uint8Array): TomlIndex {
  const { bom, text } = decodeToml(bytes);
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`client config is invalid TOML: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('client config root must be a TOML table');
  }

  const sourceLines = splitLines(text);
  const syntaxStarts = syntaxLevelLineStarts(sourceLines);
  const lines: IndexedLine[] = [];
  const entryMap = new Map<string, IndexedLine[]>();
  const headerMap = new Map<string, IndexedLine[]>();
  let currentTable = '';

  for (const source of sourceLines) {
    if (!syntaxStarts.has(source.start)) {
      lines.push(source);
      continue;
    }
    const header = /^[\t ]*\[([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\][\t ]*(?:#.*)?$/u.exec(
      source.raw,
    );
    if (header) {
      currentTable = header[1] ?? '';
      const indexed = { ...source, table: currentTable, isHeader: true };
      lines.push(indexed);
      const candidates = headerMap.get(currentTable) ?? [];
      candidates.push(indexed);
      headerMap.set(currentTable, candidates);
      continue;
    }
    if (/^[\t ]*\[/u.test(source.raw)) {
      currentTable = '\u0000unsupported';
      lines.push({ ...source, isHeader: true });
      continue;
    }

    const assignment = /^([\t ]*)([A-Za-z0-9_-]+)([\t ]*=[\t ]*)(.*)$/u.exec(source.raw);
    if (!assignment) {
      lines.push(source);
      continue;
    }
    const token = scalarToken(assignment[4] ?? '');
    if (!token) {
      lines.push(source);
      continue;
    }
    const prefixLength = (assignment[1]?.length ?? 0)
      + (assignment[2]?.length ?? 0)
      + (assignment[3]?.length ?? 0);
    const indexed: IndexedLine = {
      ...source,
      table: currentTable,
      key: assignment[2],
      rhsStart: source.start + prefixLength + token.start,
      rhsEnd: source.start + prefixLength + token.end,
    };
    lines.push(indexed);
    const key = identityKey({ table: currentTable, key: assignment[2] ?? '' });
    const candidates = entryMap.get(key) ?? [];
    candidates.push(indexed);
    entryMap.set(key, candidates);
  }

  return {
    bom,
    text,
    eol: (sourceLines.find((line) => line.eol !== '')?.eol ?? '\n') as '\n' | '\r\n',
    finalNewline: text.endsWith('\n'),
    parsed: parsed as Record<string, unknown>,
    lines,
    entries: entryMap,
    headers: headerMap,
  };
}

function own(object: unknown, key: string): boolean {
  return !!object
    && typeof object === 'object'
    && !Array.isArray(object)
    && Object.prototype.hasOwnProperty.call(object, key);
}

function tableAt(root: Record<string, unknown>, table: string): unknown {
  if (!table) return root;
  let cursor: unknown = root;
  for (const part of table.split('.')) {
    if (!own(cursor, part)) return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

function semanticValue(index: TomlIndex, identity: ManagedIdentity): {
  readonly present: boolean;
  readonly value?: unknown;
} {
  const table = tableAt(index.parsed, identity.table);
  if (!own(table, identity.key)) return { present: false };
  return { present: true, value: (table as Record<string, unknown>)[identity.key] };
}

function validateManagedShapes(index: TomlIndex, specs: readonly ManagedSpec[]): void {
  const tables = new Set(specs.map((spec) => spec.table).filter(Boolean));
  for (const table of tables) {
    const semantic = tableAt(index.parsed, table);
    if (semantic !== undefined) {
      if (!semantic || typeof semantic !== 'object' || Array.isArray(semantic)) {
        throw new Error(`managed TOML table ${table} has an ambiguous shape`);
      }
      if ((index.headers.get(table) ?? []).length !== 1) {
        throw new Error(`managed TOML table ${table} must use one unquoted table header`);
      }
    }
  }

  for (const spec of specs) {
    const semantic = semanticValue(index, spec);
    const entries = index.entries.get(identityKey(spec)) ?? [];
    if (semantic.present && entries.length !== 1) {
      throw new Error(`managed TOML key ${spec.table || '<root>'}.${spec.key} is ambiguous`);
    }
    if (!semantic.present && entries.length > 0) {
      throw new Error(`managed TOML key ${spec.table || '<root>'}.${spec.key} is invalid`);
    }
    if (semantic.present && typeof semantic.value !== typeof spec.value) {
      throw new Error(`managed TOML key ${spec.table || '<root>'}.${spec.key} has the wrong type`);
    }
  }
}

function walkForKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value as Record<string, unknown>).some((child) => walkForKey(child, key));
}

function managedSpecs(kind: ClientConfigKind, port: number): readonly ManagedSpec[] {
  if (kind !== 'codex' && kind !== 'grok') {
    throw new Error('client config kind must be codex or grok');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer from 1 to 65535');
  }
  if (kind === 'codex') return CODEX_SPECS(port);
  if (kind === 'grok') return GROK_SPECS(port);
  throw new Error('client config kind must be codex or grok');
}

function assertClientKind(kind: ClientConfigKind): void {
  if (kind !== 'codex' && kind !== 'grok') {
    throw new Error('client config kind must be codex or grok');
  }
}

function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  let output = text;
  const originalLength = text.length;
  const ordered = [...edits].sort((left, right) =>
    right.start - left.start || right.order - left.order
  );
  let previousStart = Number.POSITIVE_INFINITY;
  for (const edit of ordered) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > originalLength) {
      throw new Error('invalid client config edit span');
    }
    if (edit.end > previousStart) throw new Error('overlapping client config edits');
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end);
    previousStart = edit.start;
  }
  return output;
}

function sectionEnd(index: TomlIndex, table: string): number {
  if (!table) {
    return index.lines.find((line) => line.isHeader)?.start
      ?? index.text.length;
  }
  const header = index.headers.get(table)?.[0];
  if (!header) return index.text.length;
  return index.lines.find((line) => line.start > header.start && line.isHeader)?.start
    ?? index.text.length;
}

function insertionAt(index: TomlIndex, offset: number, lines: readonly string[]): string {
  if (lines.length === 0) return '';
  const joined = lines.join(index.eol);
  if (offset < index.text.length) return `${joined}${index.eol}`;
  if (index.text.length === 0) return joined;
  if (index.finalNewline) return `${joined}${index.eol}`;
  return `${index.eol}${joined}`;
}

function appendTableBlocks(
  index: TomlIndex,
  groups: readonly { table: string; lines: readonly string[] }[],
  followsRootInsertion: boolean,
): string {
  if (groups.length === 0) return '';
  const blocks = groups.map(({ table, lines }) =>
    [`[${table}]`, ...lines].join(index.eol)
  ).join(`${index.eol}${index.eol}`);
  if (index.text.length === 0) {
    return followsRootInsertion ? `${index.eol}${index.eol}${blocks}` : blocks;
  }
  const prefix = index.finalNewline ? index.eol : `${index.eol}${index.eol}`;
  const suffix = index.finalNewline ? index.eol : '';
  return `${prefix}${blocks}${suffix}`;
}

function validateReceiptEdit(edit: unknown, client: ClientConfigKind): ManagedReceiptEdit {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
    throw new Error(`${client} receipt edit is invalid`);
  }
  const value = edit as Record<string, unknown>;
  if (value.kind === 'insert-table') {
    if (
      Object.keys(value).sort().join(',')
        !== 'appliedLineBase64,appliedStart,kind,ownedPrefixBase64,ownedSuffixBase64,table'
      || typeof value.table !== 'string'
      || typeof value.appliedLineBase64 !== 'string'
      || !Number.isSafeInteger(value.appliedStart)
      || (value.appliedStart as number) < 0
      || typeof value.ownedPrefixBase64 !== 'string'
      || typeof value.ownedSuffixBase64 !== 'string'
    ) throw new Error(`${client} table receipt is invalid`);
    decodeBase64(value.appliedLineBase64, `${client} table receipt`);
    decodeBase64(value.ownedPrefixBase64, `${client} table prefix`);
    decodeBase64(value.ownedSuffixBase64, `${client} table suffix`);
    return value as unknown as ManagedReceiptEdit;
  }
  const common = typeof value.table === 'string' && typeof value.key === 'string';
  if (!common) throw new Error(`${client} key receipt is invalid`);
  if (value.kind === 'replace') {
    if (
      Object.keys(value).sort().join(',')
        !== 'appliedRhsBase64,key,kind,originalRhsBase64,table'
      || typeof value.originalRhsBase64 !== 'string'
      || typeof value.appliedRhsBase64 !== 'string'
    ) throw new Error(`${client} replacement receipt is invalid`);
    decodeBase64(value.originalRhsBase64, `${client} original RHS`);
    decodeBase64(value.appliedRhsBase64, `${client} applied RHS`);
    return value as unknown as ManagedReceiptEdit;
  }
  if (value.kind === 'insert-key') {
    if (
      Object.keys(value).sort().join(',')
        !== 'appliedLineBase64,appliedStart,key,kind,ownedPrefixBase64,ownedSuffixBase64,table'
      || typeof value.appliedLineBase64 !== 'string'
      || !Number.isSafeInteger(value.appliedStart)
      || (value.appliedStart as number) < 0
      || typeof value.ownedPrefixBase64 !== 'string'
      || typeof value.ownedSuffixBase64 !== 'string'
    ) throw new Error(`${client} insertion receipt is invalid`);
    decodeBase64(value.appliedLineBase64, `${client} inserted line`);
    decodeBase64(value.ownedPrefixBase64, `${client} insertion prefix`);
    decodeBase64(value.ownedSuffixBase64, `${client} insertion suffix`);
    return value as unknown as ManagedReceiptEdit;
  }
  throw new Error(`${client} receipt edit kind is invalid`);
}

function validAppliedRhs(
  client: ClientConfigKind,
  identity: ManagedIdentity,
  rhs: string,
): boolean {
  const key = identityKey(identity);
  const fixed = new Map<string, string>([
    [identityKey({ table: '', key: 'model' }), '"gpt-5.6-sol"'],
    [identityKey({ table: '', key: 'model_provider' }), '"pxpipe_local"'],
    [identityKey({ table: 'model_providers.pxpipe_local', key: 'name' }), '"pxpipe local"'],
    [identityKey({ table: 'model_providers.pxpipe_local', key: 'wire_api' }), '"responses"'],
    [identityKey({ table: 'model_providers.pxpipe_local', key: 'requires_openai_auth' }), 'true'],
    [identityKey({ table: 'model_providers.pxpipe_local', key: 'supports_websockets' }), 'false'],
    [identityKey({ table: 'models', key: 'default' }), '"grok-4.5"'],
  ]);
  const exact = fixed.get(key);
  if (exact !== undefined) return rhs === exact;

  const suffix = client === 'codex' ? '/_pxpipe/codex' : '/_pxpipe/grok/v1';
  const urlKey = client === 'codex'
    ? identityKey({ table: 'model_providers.pxpipe_local', key: 'base_url' })
    : identityKey({ table: 'endpoints', key: 'cli_chat_proxy_base_url' });
  if (key !== urlKey) return false;
  const match = /^"http:\/\/127\.0\.0\.1:([1-9]\d{0,4})(\/_pxpipe\/(?:codex|grok\/v1))"$/u.exec(rhs);
  if (!match || match[2] !== suffix) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validateOriginalRhs(rhs: string, expected: string | boolean): void {
  if (/\r|\n/u.test(rhs) || rhs.startsWith('"""') || rhs.startsWith("'''")) {
    throw new Error('client config receipt original RHS is not a single-line scalar');
  }
  const token = scalarToken(rhs);
  if (!token || token.start !== 0 || token.end !== rhs.length) {
    throw new Error('client config receipt original RHS is not an exact scalar token');
  }
  let parsed: unknown;
  try {
    parsed = parse(`value = ${rhs}`);
  } catch {
    throw new Error('client config receipt original RHS is invalid TOML');
  }
  const value = (parsed as Record<string, unknown>).value;
  if (typeof value !== typeof expected) {
    throw new Error('client config receipt original RHS has the wrong type');
  }
}

function separatorStyle(value: string, maxUnits: number): '' | '\n' | '\r\n' {
  if (value === '') return '';
  const style = value.startsWith('\r\n') ? '\r\n' : '\n';
  if (value !== style.repeat(value.length / style.length)) {
    throw new Error('client config receipt separator is invalid');
  }
  const units = value.length / style.length;
  if (!Number.isInteger(units) || units < 1 || units > maxUnits) {
    throw new Error('client config receipt separator is invalid');
  }
  return style;
}

function validateReceiptContract(receipt: ClientConfigReceipt): void {
  const specs = managedSpecs(receipt.client, 47821);
  const expectedKeys = new Map(specs.map((spec) => [identityKey(spec), spec]));
  const actualKeys = new Map<string, Exclude<ManagedReceiptEdit, { kind: 'insert-table' }>>();
  const tableEdits = new Map<string, Extract<ManagedReceiptEdit, { kind: 'insert-table' }>>();

  for (const edit of receipt.edits) {
    if (edit.kind === 'insert-table') {
      const allowedTables = new Set(specs.map((spec) => spec.table).filter(Boolean));
      if (!allowedTables.has(edit.table)) {
        throw new Error(`client config receipt owns an unexpected table ${edit.table}`);
      }
      if (decodeBase64(edit.appliedLineBase64, 'inserted table') !== `[${edit.table}]`) {
        throw new Error(`client config receipt table ${edit.table} has unexpected bytes`);
      }
      separatorStyle(
        decodeBase64(edit.ownedPrefixBase64, 'inserted table prefix'),
        2,
      );
      separatorStyle(
        decodeBase64(edit.ownedSuffixBase64, 'inserted table suffix'),
        1,
      );
      tableEdits.set(edit.table, edit);
      continue;
    }

    const spec = expectedKeys.get(identityKey(edit));
    if (!spec) {
      throw new Error(`client config receipt owns an unexpected key ${edit.table}.${edit.key}`);
    }
    const appliedRhs = edit.kind === 'replace'
      ? decodeBase64(edit.appliedRhsBase64, 'applied RHS')
      : (() => {
          const line = decodeBase64(edit.appliedLineBase64, 'inserted line');
          const prefix = `${edit.key} = `;
          if (!line.startsWith(prefix)) {
            throw new Error(`client config receipt insertion ${edit.key} has unexpected bytes`);
          }
          return line.slice(prefix.length);
        })();
    if (!validAppliedRhs(receipt.client, edit, appliedRhs)) {
      throw new Error(`client config receipt key ${edit.key} has an unexpected applied value`);
    }
    if (edit.kind === 'replace') {
      validateOriginalRhs(
        decodeBase64(edit.originalRhsBase64, 'original RHS'),
        spec.value,
      );
    } else {
      separatorStyle(
        decodeBase64(edit.ownedPrefixBase64, 'inserted key prefix'),
        1,
      );
      separatorStyle(
        decodeBase64(edit.ownedSuffixBase64, 'inserted key suffix'),
        1,
      );
    }
    actualKeys.set(identityKey(edit), edit);
  }

  if (actualKeys.size !== expectedKeys.size) {
    throw new Error('client config receipt does not own the complete fixed key set');
  }
  for (const key of expectedKeys.keys()) {
    if (!actualKeys.has(key)) {
      throw new Error('client config receipt does not own the complete fixed key set');
    }
  }
  for (const table of tableEdits.keys()) {
    for (const spec of specs.filter((candidate) => candidate.table === table)) {
      if (actualKeys.get(identityKey(spec))?.kind !== 'insert-key') {
        throw new Error(`client config receipt table ${table} claims an owner key`);
      }
    }
  }
  if (!receipt.fileExisted) {
    if (receipt.originalFileSha256 !== EMPTY_SHA256) {
      throw new Error('created client config receipt has a nonempty original file identity');
    }
    if ([...actualKeys.values()].some((edit) => edit.kind !== 'insert-key')) {
      throw new Error('created client config receipt contains a replacement');
    }
    const requiredTables = new Set(specs.map((spec) => spec.table).filter(Boolean));
    if (
      tableEdits.size !== requiredTables.size
      || [...requiredTables].some((table) => !tableEdits.has(table))
    ) throw new Error('created client config receipt lacks an inserted table');
  }
}

export function validateClientConfigReceipt(
  input: unknown,
  expectedClient?: ClientConfigKind,
): ClientConfigReceipt {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('client config receipt is invalid');
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(',')
      !== 'appliedFileSha256,client,edits,fileExisted,ledgerSha256,originalFileSha256,ownerFileSha256,schemaVersion'
    || value.schemaVersion !== 1
    || (value.client !== 'codex' && value.client !== 'grok')
    || typeof value.fileExisted !== 'boolean'
    || typeof value.originalFileSha256 !== 'string'
    || !HASH_RE.test(value.originalFileSha256)
    || typeof value.ownerFileSha256 !== 'string'
    || !HASH_RE.test(value.ownerFileSha256)
    || typeof value.appliedFileSha256 !== 'string'
    || !HASH_RE.test(value.appliedFileSha256)
    || typeof value.ledgerSha256 !== 'string'
    || !HASH_RE.test(value.ledgerSha256)
    || !Array.isArray(value.edits)
  ) throw new Error('client config receipt is invalid');
  if (expectedClient && value.client !== expectedClient) {
    throw new Error(`expected ${expectedClient} client config receipt`);
  }
  const edits = value.edits.map((edit) => validateReceiptEdit(edit, value.client as ClientConfigKind));
  const identities = new Set<string>();
  for (const edit of edits) {
    const identity = edit.kind === 'insert-table'
      ? `table:${edit.table}`
      : `key:${identityKey(edit)}`;
    if (identities.has(identity)) throw new Error('client config receipt has duplicate ownership');
    identities.add(identity);
  }
  const unsealed: UnsealedClientConfigReceipt = {
    schemaVersion: 1,
    client: value.client as ClientConfigKind,
    fileExisted: value.fileExisted as boolean,
    originalFileSha256: value.originalFileSha256 as string,
    ownerFileSha256: value.ownerFileSha256 as string,
    appliedFileSha256: value.appliedFileSha256 as string,
    edits,
  };
  const receipt: ClientConfigReceipt = {
    ...unsealed,
    ledgerSha256: value.ledgerSha256 as string,
  };
  validateReceiptContract(receipt);
  if (receiptLedgerSha256(unsealed) !== value.ledgerSha256) {
    throw new Error('client config receipt ledger digest is invalid');
  }
  return receipt;
}

function verifyReceipt(index: TomlIndex, receipt: ClientConfigReceipt): void {
  const ownedSpans: Array<{ start: number; end: number }> = [];
  const insertedSpans: Array<{
    readonly appliedStart: number;
    readonly appliedEnd: number;
    readonly currentStart: number;
    readonly currentEnd: number;
    readonly prefix: string;
    readonly label: string;
  }> = [];
  for (const edit of receipt.edits) {
    if (edit.kind === 'insert-table') {
      const headers = index.headers.get(edit.table) ?? [];
      if (headers.length !== 1 || encodeBase64(headers[0]?.raw ?? '') !== edit.appliedLineBase64) {
        throw new Error(`managed table ${edit.table} drifted or became ambiguous`);
      }
      const header = headers[0]!;
      const prefix = decodeBase64(edit.ownedPrefixBase64, 'managed table prefix');
      const suffix = decodeBase64(edit.ownedSuffixBase64, 'managed table suffix');
      if (
        index.text.slice(header.start - prefix.length, header.start) !== prefix
        || index.text.slice(header.end, header.end + suffix.length) !== suffix
      ) throw new Error(`managed table ${edit.table} separator drifted`);
      const ownedStart = header.start - prefix.length;
      insertedSpans.push({
        appliedStart: edit.appliedStart,
        appliedEnd: edit.appliedStart + prefix.length + header.raw.length + suffix.length,
        currentStart: ownedStart,
        currentEnd: header.end + suffix.length,
        prefix,
        label: `managed table ${edit.table}`,
      });
      ownedSpans.push({ start: ownedStart, end: header.end + suffix.length });
      continue;
    }
    const entries = index.entries.get(identityKey(edit)) ?? [];
    if (entries.length !== 1) {
      throw new Error(`managed key ${edit.table || '<root>'}.${edit.key} drifted or became ambiguous`);
    }
    const entry = entries[0]!;
    if (edit.kind === 'replace') {
      const rhs = index.text.slice(entry.rhsStart, entry.rhsEnd);
      if (encodeBase64(rhs) !== edit.appliedRhsBase64) {
        throw new Error(`managed key ${edit.table || '<root>'}.${edit.key} was changed`);
      }
    } else {
      if (encodeBase64(entry.raw) !== edit.appliedLineBase64) {
        throw new Error(`managed insertion ${edit.table || '<root>'}.${edit.key} was changed`);
      }
      const prefix = decodeBase64(edit.ownedPrefixBase64, 'managed insertion prefix');
      const suffix = decodeBase64(edit.ownedSuffixBase64, 'managed insertion suffix');
      if (
        index.text.slice(entry.start - prefix.length, entry.start) !== prefix
        || index.text.slice(entry.end, entry.end + suffix.length) !== suffix
      ) throw new Error(`managed insertion ${edit.table || '<root>'}.${edit.key} separator drifted`);
      const ownedStart = entry.start - prefix.length;
      insertedSpans.push({
        appliedStart: edit.appliedStart,
        appliedEnd: edit.appliedStart + prefix.length + entry.raw.length + suffix.length,
        currentStart: ownedStart,
        currentEnd: entry.end + suffix.length,
        prefix,
        label: `managed insertion ${edit.table || '<root>'}.${edit.key}`,
      });
      ownedSpans.push({ start: ownedStart, end: entry.end + suffix.length });
    }
  }
  const appliedOrder = [...insertedSpans].sort((left, right) =>
    left.appliedStart - right.appliedStart
  );
  // Applied offsets bind spatial provenance: managed spans may be translated
  // around owner bytes, but may not trade places. A prefix can move only with
  // every earlier managed insertion, so changed intervening bytes cannot be
  // mistaken for the recorded separator and removed on uninstall.
  for (let indexInOrder = 1; indexInOrder < appliedOrder.length; indexInOrder += 1) {
    const previous = appliedOrder[indexInOrder - 1]!;
    const span = appliedOrder[indexInOrder]!;
    if (span.appliedStart < previous.appliedEnd) {
      throw new Error('managed receipt applied spans overlap');
    }
    if (span.currentStart < previous.currentEnd) {
      throw new Error(`${span.label} moved before its recorded order`);
    }
  }
  const anchor = appliedOrder[0];
  const anchorTranslation = anchor === undefined
    ? 0
    : anchor.currentStart - anchor.appliedStart;
  // A prefixed first span has no earlier managed anchor. Permit its uniform
  // translation only when the bytes after the apparent prepend still hash as
  // the complete recorded owner file; this distinguishes a whole-file prepend
  // from owner bytes inserted inside (and impersonating) the managed prefix.
  const anchorMovedByWholeFilePrepend = anchor !== undefined
    && anchorTranslation > 0
    && sha256(encodeToml(
      index.text.slice(anchorTranslation, anchor.currentStart),
      index.bom,
    )) === receipt.ownerFileSha256;
  for (let indexInOrder = 0; indexInOrder < appliedOrder.length; indexInOrder += 1) {
    const span = appliedOrder[indexInOrder]!;
    if (!span.prefix || span.currentStart === span.appliedStart) continue;
    const translation = span.currentStart - span.appliedStart;
    const anchoredTranslation = anchor !== undefined
      && (anchor.prefix === '' || anchorMovedByWholeFilePrepend)
      && appliedOrder.slice(0, indexInOrder + 1).every(
        (intervening) => intervening.currentStart - intervening.appliedStart === translation,
      );
    if (!anchoredTranslation) {
      throw new Error(`${span.label} prefix moved and cannot be proven owner-safe`);
    }
  }
  ownedSpans.sort((left, right) => left.start - right.start);
  for (let indexInSpans = 1; indexInSpans < ownedSpans.length; indexInSpans += 1) {
    if (ownedSpans[indexInSpans]!.start < ownedSpans[indexInSpans - 1]!.end) {
      throw new Error('managed receipt spans overlap');
    }
  }
}

export function verifyReceiptOwnership(
  current: Uint8Array,
  receiptInput: unknown,
): ClientConfigReceipt {
  const receipt = validateClientConfigReceipt(receiptInput);
  const index = parseAndIndexToml(current);
  verifyReceipt(index, receipt);
  return receipt;
}

export function buildClientCandidate(
  kind: ClientConfigKind,
  current: Uint8Array | null,
  port: number,
  priorReceiptInput?: unknown,
): ClientConfigCandidate {
  const specs = managedSpecs(kind, port);
  const originalBytes = current ?? new Uint8Array();
  const index = parseAndIndexToml(originalBytes);
  if (kind === 'grok' && walkForKey(index.parsed, 'models_base_url')) {
    throw new Error('Grok models_base_url selects an API-key flow and must be removed by the owner');
  }
  validateManagedShapes(index, specs);

  const prior = priorReceiptInput === undefined
    ? undefined
    : validateClientConfigReceipt(priorReceiptInput, kind);
  if (prior) verifyReceipt(index, prior);
  const ownerBaselineBytes = prior
    ? buildUninstallCandidate(originalBytes, prior).bytes ?? new Uint8Array()
    : originalBytes;

  const priorByIdentity = new Map<string, ManagedReceiptEdit>();
  for (const edit of prior?.edits ?? []) {
    if (edit.kind !== 'insert-table') priorByIdentity.set(identityKey(edit), edit);
  }
  const edits: TextEdit[] = [];
  const missingByTable = new Map<string, ManagedSpec[]>();
  let order = 0;

  for (const spec of specs) {
    const entry = index.entries.get(identityKey(spec))?.[0];
    if (!entry) {
      const values = missingByTable.get(spec.table) ?? [];
      values.push(spec);
      missingByTable.set(spec.table, values);
      continue;
    }
    const desired = encodeTomlValue(spec.value);
    if (index.text.slice(entry.rhsStart, entry.rhsEnd) !== desired) {
      edits.push({
        start: entry.rhsStart!,
        end: entry.rhsEnd!,
        replacement: desired,
        order: order++,
      });
    }
  }

  const newTables = new Set<string>();
  const newTablePrefixes = new Map<string, string>();
  const newKeyPrefixes = new Map<string, string>();
  const newKeySuffixes = new Map<string, string>();
  const appendGroups: Array<{ table: string; lines: string[] }> = [];
  for (const [table, missing] of missingByTable) {
    const lines = missing.map((spec) => `${spec.key} = ${encodeTomlValue(spec.value)}`);
    if (!table || index.headers.has(table)) {
      const offset = sectionEnd(index, table);
      const first = missing[0];
      if (
        first
        && offset === index.text.length
        && index.text.length > 0
        && !index.finalNewline
      ) {
        newKeyPrefixes.set(identityKey(first), index.eol);
      }
      missing.forEach((spec, indexInGroup) => {
        const hasOwnedEol = indexInGroup < missing.length - 1
          || offset < index.text.length
          || index.finalNewline;
        newKeySuffixes.set(identityKey(spec), hasOwnedEol ? index.eol : '');
      });
      edits.push({
        start: offset,
        end: offset,
        replacement: insertionAt(index, offset, lines),
        order: order++,
      });
    } else {
      newTables.add(table);
      appendGroups.push({ table, lines });
    }
  }
  if (appendGroups.length > 0) {
    appendGroups.forEach(({ table }, indexInAppend) => {
      if (indexInAppend > 0) {
        newTablePrefixes.set(table, index.eol);
      } else if (index.text.length === 0) {
        newTablePrefixes.set(table, missingByTable.has('') ? `${index.eol}${index.eol}` : '');
      } else {
        newTablePrefixes.set(table, index.finalNewline ? index.eol : `${index.eol}${index.eol}`);
      }
      const tableKeys = missingByTable.get(table) ?? [];
      tableKeys.forEach((spec, indexInGroup) => {
        const hasOwnedEol = indexInGroup < tableKeys.length - 1
          || indexInAppend < appendGroups.length - 1
          || index.finalNewline;
        newKeySuffixes.set(identityKey(spec), hasOwnedEol ? index.eol : '');
      });
    });
    edits.push({
      start: index.text.length,
      end: index.text.length,
      replacement: appendTableBlocks(index, appendGroups, missingByTable.has('')),
      order: order++,
    });
  }

  const finalText = applyTextEdits(index.text, edits);
  const finalBytes = encodeToml(finalText, index.bom);
  const finalIndex = parseAndIndexToml(finalBytes);
  validateManagedShapes(finalIndex, specs);

  const receiptEdits: ManagedReceiptEdit[] = [];
  for (const spec of specs) {
    const finalEntry = finalIndex.entries.get(identityKey(spec))?.[0];
    if (!finalEntry) throw new Error(`failed to insert managed key ${spec.key}`);
    const priorEdit = priorByIdentity.get(identityKey(spec));
    if (priorEdit?.kind === 'replace') {
      receiptEdits.push({
        table: spec.table,
        key: spec.key,
        kind: 'replace',
        originalRhsBase64: priorEdit.originalRhsBase64,
        appliedRhsBase64: encodeBase64(finalIndex.text.slice(finalEntry.rhsStart, finalEntry.rhsEnd)),
      });
    } else if (priorEdit?.kind === 'insert-key') {
      const ownedPrefix = decodeBase64(
        priorEdit.ownedPrefixBase64,
        'managed insertion prefix',
      );
      receiptEdits.push({
        table: spec.table,
        key: spec.key,
        kind: 'insert-key',
        appliedLineBase64: encodeBase64(finalEntry.raw),
        appliedStart: finalEntry.start - ownedPrefix.length,
        ownedPrefixBase64: priorEdit.ownedPrefixBase64,
        ownedSuffixBase64: priorEdit.ownedSuffixBase64,
      });
    } else {
      const originalEntry = index.entries.get(identityKey(spec))?.[0];
      if (originalEntry) {
        receiptEdits.push({
          table: spec.table,
          key: spec.key,
          kind: 'replace',
          originalRhsBase64: encodeBase64(
            index.text.slice(originalEntry.rhsStart, originalEntry.rhsEnd),
          ),
          appliedRhsBase64: encodeBase64(
            finalIndex.text.slice(finalEntry.rhsStart, finalEntry.rhsEnd),
          ),
        });
      } else {
        const ownedPrefix = newKeyPrefixes.get(identityKey(spec)) ?? '';
        receiptEdits.push({
          table: spec.table,
          key: spec.key,
          kind: 'insert-key',
          appliedLineBase64: encodeBase64(finalEntry.raw),
          appliedStart: finalEntry.start - ownedPrefix.length,
          ownedPrefixBase64: encodeBase64(ownedPrefix),
          ownedSuffixBase64: encodeBase64(newKeySuffixes.get(identityKey(spec)) ?? ''),
        });
      }
    }
  }

  const priorTables = new Map(
    (prior?.edits ?? [])
      .filter((edit): edit is Extract<ManagedReceiptEdit, { kind: 'insert-table' }> =>
        edit.kind === 'insert-table'
      )
      .map((edit) => [edit.table, edit]),
  );
  for (const table of new Set([...priorTables.keys(), ...newTables])) {
    const header = finalIndex.headers.get(table)?.[0];
    if (!header) throw new Error(`failed to retain managed table ${table}`);
    const priorTable = priorTables.get(table);
    const ownedPrefixBase64 = priorTable?.ownedPrefixBase64
      ?? encodeBase64(newTablePrefixes.get(table) ?? '');
    const ownedPrefix = decodeBase64(ownedPrefixBase64, 'managed table prefix');
    receiptEdits.push({
      kind: 'insert-table',
      table,
      appliedLineBase64: encodeBase64(header.raw),
      appliedStart: header.start - ownedPrefix.length,
      ownedPrefixBase64,
      ownedSuffixBase64: priorTable?.ownedSuffixBase64
        ?? encodeBase64(header.eol),
    });
  }

  const fileExisted = prior?.fileExisted ?? current !== null;
  const wholeCreatedFileIsManaged = !fileExisted && ownerBaselineBytes.length === 0;
  const receipt = sealReceipt({
    schemaVersion: 1,
    client: kind,
    fileExisted,
    originalFileSha256: prior?.originalFileSha256 ?? sha256(originalBytes),
    ownerFileSha256: sha256(ownerBaselineBytes),
    appliedFileSha256: fileExisted || wholeCreatedFileIsManaged
      ? sha256(finalBytes)
      : prior?.appliedFileSha256 ?? sha256(finalBytes),
    edits: receiptEdits,
  });
  return {
    bytes: finalBytes,
    receipt,
    changed: !Buffer.from(finalBytes).equals(Buffer.from(originalBytes)),
  };
}

function ownedLineSpan(
  line: IndexedLine,
  ownership: { readonly ownedPrefixBase64: string; readonly ownedSuffixBase64: string },
): { readonly start: number; readonly end: number } {
  const prefix = decodeBase64(ownership.ownedPrefixBase64, 'owned line prefix');
  const suffix = decodeBase64(ownership.ownedSuffixBase64, 'owned line suffix');
  return { start: line.start - prefix.length, end: line.end + suffix.length };
}

export function buildUninstallCandidate(
  current: Uint8Array,
  receiptInput: unknown,
): ClientUninstallCandidate {
  const receipt = validateClientConfigReceipt(receiptInput);
  const index = parseAndIndexToml(current);
  verifyReceipt(index, receipt);

  const edits: TextEdit[] = [];
  const insertedKeySpans = new Map<string, { readonly start: number; readonly end: number }>();
  let order = 0;
  for (const edit of receipt.edits) {
    if (edit.kind === 'insert-table') continue;
    const entry = index.entries.get(identityKey(edit))?.[0];
    if (!entry) throw new Error('managed receipt entry disappeared');
    if (edit.kind === 'replace') {
      edits.push({
        start: entry.rhsStart!,
        end: entry.rhsEnd!,
        replacement: decodeBase64(edit.originalRhsBase64, 'original RHS'),
        order: order++,
      });
    } else {
      const span = ownedLineSpan(entry, edit);
      insertedKeySpans.set(identityKey(edit), span);
      edits.push({ ...span, replacement: '', order: order++ });
    }
  }

  const tableEdits = receipt.edits.filter(
    (edit): edit is Extract<ManagedReceiptEdit, { kind: 'insert-table' }> =>
      edit.kind === 'insert-table',
  );
  const tableByName = new Map(tableEdits.map((edit) => [edit.table, edit]));
  const orderedTables = [...tableEdits].sort((left, right) => {
    const leftStart = index.headers.get(left.table)?.[0]?.start ?? -1;
    const rightStart = index.headers.get(right.table)?.[0]?.start ?? -1;
    return rightStart - leftStart;
  });
  for (const tableEdit of orderedTables) {
    const header = index.headers.get(tableEdit.table)?.[0];
    if (!header) continue;
    const headerSpan = ownedLineSpan(header, tableEdit);
    const nextHeader = index.lines.find((line) => line.start > header.start && line.isHeader);
    let bodyEnd = nextHeader?.start ?? index.text.length;
    if (nextHeader?.table) {
      const nextOwned = tableByName.get(nextHeader.table);
      if (nextOwned) {
        bodyEnd -= decodeBase64(nextOwned.ownedPrefixBase64, 'next table prefix').length;
      }
    }

    const childSpans = receipt.edits
      .filter((edit): edit is Extract<ManagedReceiptEdit, { kind: 'insert-key' }> =>
        edit.kind === 'insert-key' && edit.table === tableEdit.table
      )
      .map((edit) => insertedKeySpans.get(identityKey(edit)))
      .filter((span): span is { readonly start: number; readonly end: number } =>
        span !== undefined
      )
      .sort((left, right) => left.start - right.start);

    let cursor = headerSpan.end;
    let hasOwnerBytes = cursor > bodyEnd;
    for (const span of childSpans) {
      if (span.start < cursor || span.end > bodyEnd) {
        hasOwnerBytes = true;
        break;
      }
      if (span.start > cursor) {
        hasOwnerBytes = true;
        break;
      }
      cursor = span.end;
    }
    if (cursor !== bodyEnd) hasOwnerBytes = true;
    if (!hasOwnerBytes) {
      edits.push({ ...headerSpan, replacement: '', order: order++ });
    }
  }

  const text = applyTextEdits(index.text, edits);
  const bytes = encodeToml(text, index.bom);
  parseAndIndexToml(bytes);
  if (
    sha256(current) === receipt.appliedFileSha256
    && sha256(bytes) !== receipt.ownerFileSha256
  ) {
    throw new Error('client config receipt reversal does not match its recorded owner identity');
  }
  if (!receipt.fileExisted && bytes.length === 0) {
    return { bytes: null, changed: true };
  }
  return {
    bytes,
    changed: !Buffer.from(bytes).equals(Buffer.from(current)),
  };
}

function isLoopbackHostname(host: string): boolean {
  if (
    host === 'localhost'
    || host === 'localhost.'
    || host === '[::1]'
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/u.test(host)
  ) return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/u.exec(host);
  if (!mapped) return false;
  const highWord = Number.parseInt(mapped[1]!, 16);
  return (highWord >>> 8) === 127;
}

function isManagedLoopbackUrl(value: unknown, suffix: string): boolean {
  if (typeof value !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    && isLoopbackHostname(host)
    && parsed.username === ''
    && parsed.password === ''
    && parsed.search === ''
    && parsed.hash === ''
    && parsed.pathname.replace(/\/$/u, '') === suffix;
}

export function findLegacyFootprints(
  kind: ClientConfigKind,
  bytes: Uint8Array,
): readonly string[] {
  assertClientKind(kind);
  const index = parseAndIndexToml(bytes);
  const found: string[] = [];
  if (kind === 'codex') {
    if (index.parsed.model_provider === 'pxpipe_local') found.push('codex-model-provider');
    const providers = index.parsed.model_providers;
    if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
      if (own(providers, 'pxpipe_local')) found.push('codex-provider-table');
      for (const provider of Object.values(providers)) {
        if (
          provider
          && typeof provider === 'object'
          && !Array.isArray(provider)
          && isManagedLoopbackUrl(
            (provider as Record<string, unknown>).base_url,
            '/_pxpipe/codex',
          )
        ) {
          found.push('codex-loopback-base');
          break;
        }
      }
    }
  } else {
    const endpoints = index.parsed.endpoints;
    if (
      endpoints
      && typeof endpoints === 'object'
      && !Array.isArray(endpoints)
      && isManagedLoopbackUrl(
        (endpoints as Record<string, unknown>).cli_chat_proxy_base_url,
        '/_pxpipe/grok/v1',
      )
    ) found.push('grok-loopback-endpoint');
  }
  return found;
}
