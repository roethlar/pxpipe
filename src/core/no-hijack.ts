/**
 * Provider-neutral inventory and comparison for model-visible request text.
 *
 * This module is deliberately runtime-agnostic: it uses no Node APIs, performs no
 * I/O, and treats requests as already-parsed JSON values.  It does not decide
 * whether an image is economical.  Admission can use the result as the structural
 * precondition before doing any provider measurement.
 */

export type NoHijackProvider = 'anthropic' | 'openai-chat' | 'openai-responses';

export type VisibleTextPin =
  | 'host_context'
  | 'project_guidance'
  | 'system'
  | 'developer'
  | 'tool_definition'
  | 'conversation';

export type VisibleTextContainer =
  | 'system'
  | 'instructions'
  | 'tool_definition'
  | 'message_content'
  | 'message_metadata'
  | 'tool_use'
  | 'tool_result'
  | 'function_call'
  | 'function_output'
  | 'unknown';

/** One caller-authored text atom at its provider-visible structural location. */
export interface VisibleTextEntry {
  readonly identity: string;
  readonly provider: NoHijackProvider;
  readonly role: string;
  readonly messageIndex: number | null;
  readonly container: VisibleTextContainer;
  readonly path: string;
  /** Absolute provider-visible text order. No separator is implied between entries. */
  readonly order: number;
  readonly text: string;
  /** Every model-visible caller atom is pinned; tags explain why it is sensitive. */
  readonly pins: readonly VisibleTextPin[];
}

export interface AddedTextChange {
  readonly kind: 'added';
  readonly entry: VisibleTextEntry;
}

export interface RemovedTextChange {
  readonly kind: 'removed';
  readonly entry: VisibleTextEntry;
}

export interface MovedTextChange {
  readonly kind: 'moved';
  readonly before: VisibleTextEntry;
  readonly after: VisibleTextEntry;
}

export interface ModifiedTextChange {
  readonly kind: 'modified';
  readonly before: VisibleTextEntry;
  readonly after: VisibleTextEntry;
}

export type ForbiddenProseCategory =
  | 'trust'
  | 'authority'
  | 'priority'
  | 'authenticity'
  | 'source_assertion'
  | 'obey_follow_directive';

export interface ForbiddenProseFinding {
  readonly category: ForbiddenProseCategory;
  readonly match: string;
  readonly entry: VisibleTextEntry;
}

export type AnthropicSpanTarget =
  | {
      readonly kind: 'message_text_block';
      readonly messageIndex: number;
      readonly originalBlockIndex: number;
      /** First replacement part in the candidate message content array. */
      readonly candidateStartIndex: number;
    }
  | {
      readonly kind: 'tool_result_string';
      readonly messageIndex: number;
      readonly originalBlockIndex: number;
      /** Tool-result block index after any earlier candidate insertions. */
      readonly candidateBlockIndex: number;
      /** First replacement part in candidate tool_result.content. */
      readonly candidateStartIndex: number;
    }
  | {
      readonly kind: 'tool_result_text_part';
      readonly messageIndex: number;
      readonly originalBlockIndex: number;
      readonly originalPartIndex: number;
      /** Tool-result block index after any earlier candidate insertions. */
      readonly candidateBlockIndex: number;
      /** First replacement part in candidate tool_result.content. */
      readonly candidateStartIndex: number;
    };

/**
 * The sole text-changing exception understood by this module.  The descriptor is
 * explicit so an admission builder cannot accidentally bless a role/message move.
 * The source span disappears into one or more image blocks; its exact prefix and
 * suffix, when non-empty, must remain immediately adjacent around those images.
 */
export interface ExactSpanImageReplacement {
  readonly id: string;
  readonly provider: 'anthropic';
  readonly target: AnthropicSpanTarget;
  readonly start: number;
  readonly end: number;
  readonly expectedText: string;
  readonly imageCount: number;
}

export interface ImageReplacementResult {
  readonly id: string;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface NoHijackComparison {
  readonly ok: boolean;
  readonly original: readonly VisibleTextEntry[];
  readonly candidate: readonly VisibleTextEntry[];
  /** Changes remaining after valid exact-span image replacements are normalized. */
  readonly added: readonly AddedTextChange[];
  readonly removed: readonly RemovedTextChange[];
  readonly moved: readonly MovedTextChange[];
  readonly modified: readonly ModifiedTextChange[];
  readonly forbiddenProse: readonly ForbiddenProseFinding[];
  readonly replacements: readonly ImageReplacementResult[];
  readonly violations: readonly string[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) out[key] = cloneJson(child);
  return out;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!isRecord(value)) return value;
  const out: JsonRecord = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalValue(value[key]);
  return out;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function rolePins(role: string): VisibleTextPin[] {
  if (role === 'system' || role === 'instructions') return ['system'];
  if (role === 'developer') return ['developer'];
  return ['conversation'];
}

function uniquePins(pins: readonly VisibleTextPin[]): VisibleTextPin[] {
  return [...new Set(pins)];
}

interface InventoryBuilder {
  readonly provider: NoHijackProvider;
  readonly entries: VisibleTextEntry[];
  add(args: {
    role: string;
    messageIndex: number | null;
    container: VisibleTextContainer;
    path: string;
    text: string;
    pins: readonly VisibleTextPin[];
  }): void;
}

function makeBuilder(provider: NoHijackProvider): InventoryBuilder {
  const entries: VisibleTextEntry[] = [];
  return {
    provider,
    entries,
    add(args): void {
      const order = entries.length;
      const pins = uniquePins(args.pins);
      const location = [provider, args.role, args.messageIndex ?? '-', args.container, args.path].join('|');
      entries.push({
        identity: `${location}|${order}`,
        provider,
        role: args.role,
        messageIndex: args.messageIndex,
        container: args.container,
        path: args.path,
        order,
        text: args.text,
        pins,
      });
    },
  };
}

function anthropicTextPins(role: string, messageIndex: number, text: string): VisibleTextPin[] {
  const pins = rolePins(role);
  if (
    role === 'user' &&
    messageIndex === 0 &&
    (text.includes('<system-reminder>') || text.includes('# userEmail') || text.includes('# currentDate'))
  ) {
    pins.push('host_context');
  }
  if (role === 'user' && messageIndex === 0 && text.includes('# claudeMd')) {
    pins.push('project_guidance');
  }
  return uniquePins(pins);
}

const GENERIC_TEXT_KEYS = new Set([
  'text',
  'content',
  'output',
  'arguments',
  'description',
  'instructions',
  'refusal',
  'summary',
  'thinking',
]);

function collectGenericText(
  builder: InventoryBuilder,
  value: unknown,
  args: {
    role: string;
    messageIndex: number | null;
    container: VisibleTextContainer;
    path: string;
    pins: readonly VisibleTextPin[];
  },
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectGenericText(builder, child, {
      ...args,
      path: `${args.path}[${index}]`,
    }));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const path = `${args.path}.${key}`;
    if (typeof child === 'string' && GENERIC_TEXT_KEYS.has(key)) {
      builder.add({ ...args, path, text: child });
    } else if (Array.isArray(child) || isRecord(child)) {
      collectGenericText(builder, child, { ...args, path });
    }
  }
}

function inventoryAnthropic(request: unknown, builder: InventoryBuilder): void {
  if (!isRecord(request)) return;
  const system = request.system;
  if (typeof system === 'string') {
    builder.add({
      role: 'system', messageIndex: null, container: 'system', path: '$.system',
      text: system, pins: ['system'],
    });
  } else if (Array.isArray(system)) {
    system.forEach((block, index) => {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        builder.add({
          role: 'system', messageIndex: null, container: 'system',
          path: `$.system[${index}].text`, text: block.text, pins: ['system'],
        });
      }
    });
  }

  if (Array.isArray(request.tools)) {
    request.tools.forEach((tool, index) => builder.add({
      role: 'tool', messageIndex: null, container: 'tool_definition',
      path: `$.tools[${index}]`, text: canonicalJson(tool), pins: ['tool_definition'],
    }));
  }

  if (!Array.isArray(request.messages)) return;
  request.messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return;
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const content = message.content;
    if (typeof content === 'string') {
      builder.add({
        role, messageIndex, container: 'message_content',
        path: `$.messages[${messageIndex}].content`, text: content,
        pins: anthropicTextPins(role, messageIndex, content),
      });
      return;
    }
    if (!Array.isArray(content)) return;
    content.forEach((block, blockIndex) => {
      if (!isRecord(block)) return;
      const base = `$.messages[${messageIndex}].content[${blockIndex}]`;
      if (block.type === 'text' && typeof block.text === 'string') {
        builder.add({
          role, messageIndex, container: 'message_content', path: `${base}.text`,
          text: block.text, pins: anthropicTextPins(role, messageIndex, block.text),
        });
        return;
      }
      if (block.type === 'tool_result') {
        if (typeof block.content === 'string') {
          builder.add({
            role, messageIndex, container: 'tool_result', path: `${base}.content`,
            text: block.content, pins: ['conversation'],
          });
        } else if (Array.isArray(block.content)) {
          block.content.forEach((part, partIndex) => {
            if (isRecord(part) && part.type === 'text' && typeof part.text === 'string') {
              builder.add({
                role, messageIndex, container: 'tool_result',
                path: `${base}.content[${partIndex}].text`, text: part.text,
                pins: ['conversation'],
              });
            }
          });
        }
        return;
      }
      if (block.type === 'tool_use') {
        builder.add({
          role, messageIndex, container: 'tool_use', path: base,
          text: canonicalJson(block), pins: ['conversation'],
        });
        return;
      }
      collectGenericText(builder, block, {
        role, messageIndex, container: 'unknown', path: base, pins: rolePins(role),
      });
    });
  });
}

function inventoryOpenAIContent(
  builder: InventoryBuilder,
  content: unknown,
  role: string,
  messageIndex: number,
  basePath: string,
  defaultContainer: VisibleTextContainer = 'message_content',
): void {
  const pins = rolePins(role);
  if (typeof content === 'string') {
    builder.add({ role, messageIndex, container: defaultContainer, path: basePath, text: content, pins });
    return;
  }
  if (!Array.isArray(content)) return;
  content.forEach((part, partIndex) => {
    if (!isRecord(part)) return;
    const path = `${basePath}[${partIndex}]`;
    if (
      (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') &&
      typeof part.text === 'string'
    ) {
      builder.add({
        role, messageIndex, container: defaultContainer, path: `${path}.text`,
        text: part.text, pins,
      });
      return;
    }
    collectGenericText(builder, part, {
      role, messageIndex, container: defaultContainer, path, pins,
    });
  });
}

function inventoryOpenAIChat(request: unknown, builder: InventoryBuilder): void {
  if (!isRecord(request)) return;
  const tools = Array.isArray(request.tools)
    ? request.tools
    : Array.isArray(request.functions) ? request.functions : [];
  tools.forEach((tool, index) => builder.add({
    role: 'tool', messageIndex: null, container: 'tool_definition',
    path: Array.isArray(request.tools) ? `$.tools[${index}]` : `$.functions[${index}]`,
    text: canonicalJson(tool), pins: ['tool_definition'],
  }));
  if (!Array.isArray(request.messages)) return;
  request.messages.forEach((message, messageIndex) => {
    if (!isRecord(message)) return;
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    inventoryOpenAIContent(
      builder,
      message.content,
      role,
      messageIndex,
      `$.messages[${messageIndex}].content`,
      role === 'tool' ? 'tool_result' : 'message_content',
    );
    if (typeof message.name === 'string') {
      builder.add({
        role, messageIndex, container: 'message_metadata',
        path: `$.messages[${messageIndex}].name`, text: message.name, pins: rolePins(role),
      });
    }
    if (Array.isArray(message.tool_calls)) {
      message.tool_calls.forEach((call, callIndex) => builder.add({
        role, messageIndex, container: 'function_call',
        path: `$.messages[${messageIndex}].tool_calls[${callIndex}]`,
        text: canonicalJson(call), pins: ['conversation'],
      }));
    }
  });
}

function inventoryOpenAIResponses(request: unknown, builder: InventoryBuilder): void {
  if (!isRecord(request)) return;
  if (typeof request.instructions === 'string') {
    builder.add({
      role: 'instructions', messageIndex: null, container: 'instructions',
      path: '$.instructions', text: request.instructions, pins: ['system', 'developer'],
    });
  }
  if (Array.isArray(request.tools)) {
    request.tools.forEach((tool, index) => builder.add({
      role: 'tool', messageIndex: null, container: 'tool_definition',
      path: `$.tools[${index}]`, text: canonicalJson(tool), pins: ['tool_definition'],
    }));
  }
  if (typeof request.input === 'string') {
    builder.add({
      role: 'user', messageIndex: 0, container: 'message_content',
      path: '$.input', text: request.input, pins: ['conversation'],
    });
    return;
  }
  if (!Array.isArray(request.input)) return;
  request.input.forEach((item, messageIndex) => {
    if (!isRecord(item)) return;
    const role = typeof item.role === 'string' ? item.role : 'unknown';
    if (typeof item.role === 'string') {
      inventoryOpenAIContent(
        builder, item.content, role, messageIndex,
        `$.input[${messageIndex}].content`,
      );
      return;
    }
    if (item.type === 'function_call') {
      builder.add({
        role: 'assistant', messageIndex, container: 'function_call',
        path: `$.input[${messageIndex}]`, text: canonicalJson(item), pins: ['conversation'],
      });
      return;
    }
    if (item.type === 'function_call_output') {
      if (typeof item.output === 'string') {
        builder.add({
          role: 'tool', messageIndex, container: 'function_output',
          path: `$.input[${messageIndex}].output`, text: item.output, pins: ['conversation'],
        });
      } else {
        inventoryOpenAIContent(
          builder, item.output, 'tool', messageIndex,
          `$.input[${messageIndex}].output`, 'function_output',
        );
      }
      return;
    }
    collectGenericText(builder, item, {
      role, messageIndex, container: 'unknown', path: `$.input[${messageIndex}]`,
      pins: ['conversation'],
    });
  });
}

/** Inventory caller-authored, model-visible text without inventing separators. */
export function inventoryModelVisibleText(
  provider: NoHijackProvider,
  request: unknown,
): VisibleTextEntry[] {
  const builder = makeBuilder(provider);
  if (provider === 'anthropic') inventoryAnthropic(request, builder);
  else if (provider === 'openai-chat') inventoryOpenAIChat(request, builder);
  else inventoryOpenAIResponses(request, builder);
  return builder.entries;
}

function locationKey(entry: VisibleTextEntry): string {
  return [
    entry.provider,
    entry.role,
    entry.messageIndex ?? '-',
    entry.container,
    entry.path,
  ].join('|');
}

function diffInventories(
  original: readonly VisibleTextEntry[],
  candidate: readonly VisibleTextEntry[],
): {
  added: AddedTextChange[];
  removed: RemovedTextChange[];
  moved: MovedTextChange[];
  modified: ModifiedTextChange[];
} {
  const matchedOriginal = new Set<VisibleTextEntry>();
  const matchedCandidate = new Set<VisibleTextEntry>();
  const moved: MovedTextChange[] = [];
  const modified: ModifiedTextChange[] = [];

  // Preserve exact location+text matches first. A shifted absolute order is still
  // a move because provider-visible text was inserted ahead of the caller atom.
  for (const before of original) {
    const after = candidate.find((entry) =>
      !matchedCandidate.has(entry) &&
      locationKey(entry) === locationKey(before) &&
      entry.text === before.text);
    if (!after) continue;
    matchedOriginal.add(before);
    matchedCandidate.add(after);
    if (before.order !== after.order) moved.push({ kind: 'moved', before, after });
  }

  // Exact caller text at a different location is movement, even when its former
  // location now contains proxy prose (which will remain added/modified below).
  for (const before of original) {
    if (matchedOriginal.has(before)) continue;
    const after = candidate.find((entry) =>
      !matchedCandidate.has(entry) && entry.text === before.text);
    if (after) {
      matchedOriginal.add(before);
      matchedCandidate.add(after);
      moved.push({ kind: 'moved', before, after });
    }
  }

  // Remaining same-location pairs changed their model-visible text in place.
  for (const before of original) {
    if (matchedOriginal.has(before)) continue;
    const after = candidate.find((entry) =>
      !matchedCandidate.has(entry) && locationKey(entry) === locationKey(before));
    if (!after) continue;
    matchedOriginal.add(before);
    matchedCandidate.add(after);
    modified.push({ kind: 'modified', before, after });
  }

  const removed = original
    .filter((entry) => !matchedOriginal.has(entry))
    .map((entry): RemovedTextChange => ({ kind: 'removed', entry }));
  const added = candidate
    .filter((entry) => !matchedCandidate.has(entry))
    .map((entry): AddedTextChange => ({ kind: 'added', entry }));
  return { added, removed, moved, modified };
}

const FORBIDDEN_PATTERNS: readonly {
  category: ForbiddenProseCategory;
  pattern: RegExp;
}[] = [
  { category: 'trust', pattern: /\b(?:trust|trusted|untrusted|trustworthy)\b/i },
  { category: 'authority', pattern: /\b(?:authority|authoritative|privileged)\b/i },
  { category: 'priority', pattern: /\bpriority\b|\bsame\s+priority\b|\boverride(?:s|d)?\b/i },
  { category: 'authenticity', pattern: /\b(?:authentic|authenticity|verified|vouched)\b/i },
  {
    category: 'source_assertion',
    pattern: /\b(?:source|meaning|position)\s*:|injected by pxpipe|not by the (?:end )?user|supplied through|relocated by pxpipe|copied from this request|data,\s*not instructions/i,
  },
  {
    category: 'obey_follow_directive',
    pattern: /\b(?:obey|follow|adhere)\b|\bmust\b[^.\n]{0,120}\b(?:obey|follow|act)\b|\btreat\b[^.\n]{0,160}\b(?:instruction|priority|authoritative|authority)\b|\banswer that request\b/i,
  },
];

/** Scan only entries known to be proxy-added or proxy-modified, never caller text. */
function forbiddenFindings(
  added: readonly AddedTextChange[],
  modified: readonly ModifiedTextChange[],
): ForbiddenProseFinding[] {
  const entries = [
    ...added.map((change) => change.entry),
    ...modified.map((change) => change.after),
  ];
  const out: ForbiddenProseFinding[] = [];
  for (const entry of entries) {
    for (const { category, pattern } of FORBIDDEN_PATTERNS) {
      const match = pattern.exec(entry.text);
      if (match) out.push({ category, match: match[0]!, entry });
    }
  }
  return out;
}

function requestMessages(request: unknown): unknown[] | undefined {
  return isRecord(request) && Array.isArray(request.messages) ? request.messages : undefined;
}

function messageAt(request: unknown, index: number): JsonRecord | undefined {
  const message = requestMessages(request)?.[index];
  return isRecord(message) ? message : undefined;
}

function contentArray(message: JsonRecord | undefined): unknown[] | undefined {
  return message && Array.isArray(message.content) ? message.content : undefined;
}

function onlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((key) => set.has(key));
}

function isImagePart(value: unknown): value is JsonRecord {
  if (!isRecord(value) || value.type !== 'image' || !isRecord(value.source)) return false;
  return value.source.type === 'base64' &&
    typeof value.source.media_type === 'string' &&
    typeof value.source.data === 'string' &&
    onlyKeys(value, ['type', 'source', 'cache_control']);
}

function markerOf(value: unknown): unknown {
  return isRecord(value) ? value.cache_control : undefined;
}

function validateReplacementParts(
  parts: readonly unknown[],
  candidateStart: number,
  prefix: string,
  suffix: string,
  imageCount: number,
  originalMarker: unknown,
): { ok: true; deleteCount: number } | { ok: false; reason: string } {
  if (!Number.isInteger(candidateStart) || candidateStart < 0) {
    return { ok: false, reason: 'candidate start is invalid' };
  }
  if (!Number.isInteger(imageCount) || imageCount <= 0) {
    return { ok: false, reason: 'imageCount must be positive' };
  }
  const expectedCount = (prefix ? 1 : 0) + imageCount + (suffix ? 1 : 0);
  const sequence = parts.slice(candidateStart, candidateStart + expectedCount);
  if (sequence.length !== expectedCount) return { ok: false, reason: 'replacement sequence is incomplete' };
  let cursor = 0;
  if (prefix) {
    const part = sequence[cursor++];
    if (!isRecord(part) || part.type !== 'text' || part.text !== prefix ||
      !onlyKeys(part, ['type', 'text', 'cache_control'])) {
      return { ok: false, reason: 'exact source prefix is not adjacent before the images' };
    }
  }
  for (let index = 0; index < imageCount; index++) {
    if (!isImagePart(sequence[cursor++])) {
      return { ok: false, reason: 'replacement contains a non-image block' };
    }
  }
  if (suffix) {
    const part = sequence[cursor++];
    if (!isRecord(part) || part.type !== 'text' || part.text !== suffix ||
      !onlyKeys(part, ['type', 'text', 'cache_control'])) {
      return { ok: false, reason: 'exact source suffix is not adjacent after the images' };
    }
  }
  for (let index = 0; index < sequence.length; index++) {
    const marker = markerOf(sequence[index]);
    const isLast = index === sequence.length - 1;
    if (originalMarker === undefined && marker !== undefined) {
      return { ok: false, reason: 'replacement added cache_control ownership' };
    }
    if (originalMarker !== undefined) {
      if (isLast && !jsonEqual(marker, originalMarker)) {
        return { ok: false, reason: 'replacement did not preserve cache_control on its final part' };
      }
      if (!isLast && marker !== undefined) {
        return { ok: false, reason: 'replacement moved cache_control before the source-span end' };
      }
    }
  }
  return { ok: true, deleteCount: expectedCount };
}

type NormalizationPatch =
  | {
      kind: 'message';
      messageIndex: number;
      candidateStart: number;
      deleteCount: number;
      replacement: unknown;
    }
  | {
      kind: 'tool_string';
      messageIndex: number;
      candidateBlockIndex: number;
      replacement: string;
    }
  | {
      kind: 'tool_part';
      messageIndex: number;
      candidateBlockIndex: number;
      candidateStart: number;
      deleteCount: number;
      replacement: unknown;
    };

function objectWithout(value: JsonRecord, key: string): JsonRecord {
  const out: JsonRecord = {};
  for (const [name, child] of Object.entries(value)) if (name !== key) out[name] = child;
  return out;
}

function prepareReplacement(
  original: unknown,
  candidate: unknown,
  descriptor: ExactSpanImageReplacement,
): { result: ImageReplacementResult; patch?: NormalizationPatch } {
  if (descriptor.provider !== 'anthropic') {
    return { result: { id: descriptor.id, accepted: false, reason: 'only Anthropic exact-span replacements are supported' } };
  }
  const target = descriptor.target;
  const originalMessage = messageAt(original, target.messageIndex);
  const candidateMessage = messageAt(candidate, target.messageIndex);
  if (!originalMessage || !candidateMessage || originalMessage.role !== candidateMessage.role) {
    return { result: { id: descriptor.id, accepted: false, reason: 'replacement crossed or lost its original message role' } };
  }
  const originalBlocks = contentArray(originalMessage);
  const candidateBlocks = contentArray(candidateMessage);
  if (!originalBlocks || !candidateBlocks) {
    return { result: { id: descriptor.id, accepted: false, reason: 'replacement container is not an array' } };
  }

  let sourceText: string | undefined;
  let marker: unknown;
  let originalValue: unknown;
  if (target.kind === 'message_text_block') {
    const block = originalBlocks[target.originalBlockIndex];
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string' ||
      !onlyKeys(block, ['type', 'text', 'cache_control'])) {
      return { result: { id: descriptor.id, accepted: false, reason: 'original message text block is unsupported' } };
    }
    sourceText = block.text;
    marker = block.cache_control;
    originalValue = block;
  } else {
    const originalBlock = originalBlocks[target.originalBlockIndex];
    const candidateBlock = candidateBlocks[target.candidateBlockIndex];
    if (!isRecord(originalBlock) || originalBlock.type !== 'tool_result' ||
      !isRecord(candidateBlock) || candidateBlock.type !== 'tool_result' ||
      !jsonEqual(objectWithout(originalBlock, 'content'), objectWithout(candidateBlock, 'content'))) {
      return { result: { id: descriptor.id, accepted: false, reason: 'tool_result moved or changed outside its content' } };
    }
    if (target.kind === 'tool_result_string') {
      if (typeof originalBlock.content !== 'string' || !Array.isArray(candidateBlock.content)) {
        return { result: { id: descriptor.id, accepted: false, reason: 'tool_result string replacement shape is invalid' } };
      }
      sourceText = originalBlock.content;
      originalValue = originalBlock.content;
    } else {
      if (!Array.isArray(originalBlock.content) || !Array.isArray(candidateBlock.content)) {
        return { result: { id: descriptor.id, accepted: false, reason: 'tool_result part replacement shape is invalid' } };
      }
      const part = originalBlock.content[target.originalPartIndex];
      if (!isRecord(part) || part.type !== 'text' || typeof part.text !== 'string' ||
        !onlyKeys(part, ['type', 'text', 'cache_control'])) {
        return { result: { id: descriptor.id, accepted: false, reason: 'original tool_result text part is unsupported' } };
      }
      sourceText = part.text;
      marker = part.cache_control;
      originalValue = part;
    }
  }

  if (
    descriptor.start < 0 ||
    descriptor.end < descriptor.start ||
    descriptor.end > sourceText.length ||
    sourceText.slice(descriptor.start, descriptor.end) !== descriptor.expectedText
  ) {
    return { result: { id: descriptor.id, accepted: false, reason: 'descriptor does not bind the exact original source span' } };
  }
  const prefix = sourceText.slice(0, descriptor.start);
  const suffix = sourceText.slice(descriptor.end);
  const parts = target.kind === 'message_text_block'
    ? candidateBlocks
    : (candidateBlocks[target.candidateBlockIndex] as JsonRecord).content as unknown[];
  const checked = validateReplacementParts(
    parts,
    target.candidateStartIndex,
    prefix,
    suffix,
    descriptor.imageCount,
    marker,
  );
  if (!checked.ok) {
    return { result: { id: descriptor.id, accepted: false, reason: checked.reason } };
  }

  if (target.kind === 'message_text_block') {
    return {
      result: { id: descriptor.id, accepted: true },
      patch: {
        kind: 'message', messageIndex: target.messageIndex,
        candidateStart: target.candidateStartIndex, deleteCount: checked.deleteCount,
        replacement: originalValue,
      },
    };
  }
  if (target.kind === 'tool_result_string') {
    return {
      result: { id: descriptor.id, accepted: true },
      patch: {
        kind: 'tool_string', messageIndex: target.messageIndex,
        candidateBlockIndex: target.candidateBlockIndex,
        replacement: originalValue as string,
      },
    };
  }
  return {
    result: { id: descriptor.id, accepted: true },
    patch: {
      kind: 'tool_part', messageIndex: target.messageIndex,
      candidateBlockIndex: target.candidateBlockIndex,
      candidateStart: target.candidateStartIndex, deleteCount: checked.deleteCount,
      replacement: originalValue,
    },
  };
}

function applyPatches(candidate: unknown, patches: readonly NormalizationPatch[]): unknown {
  const normalized = cloneJson(candidate);
  const nested = patches.filter((patch) => patch.kind !== 'message');
  for (const patch of nested) {
    const message = messageAt(normalized, patch.messageIndex);
    const blocks = contentArray(message);
    const block = blocks?.[patch.candidateBlockIndex];
    if (!isRecord(block)) continue;
    if (patch.kind === 'tool_string') {
      block.content = patch.replacement;
    } else if (Array.isArray(block.content)) {
      block.content.splice(
        patch.candidateStart,
        patch.deleteCount,
        cloneJson(patch.replacement),
      );
    }
  }
  const messagePatches = patches
    .filter((patch): patch is Extract<NormalizationPatch, { kind: 'message' }> => patch.kind === 'message')
    .sort((a, b) => b.messageIndex - a.messageIndex || b.candidateStart - a.candidateStart);
  for (const patch of messagePatches) {
    const blocks = contentArray(messageAt(normalized, patch.messageIndex));
    blocks?.splice(patch.candidateStart, patch.deleteCount, cloneJson(patch.replacement));
  }
  return normalized;
}

/**
 * Compare a candidate with the caller request.  `ok` means the candidate is text-
 * and structure-identical after undoing only the explicitly described, validated
 * in-place image replacements.
 */
export function compareNoHijack(
  provider: NoHijackProvider,
  originalRequest: unknown,
  candidateRequest: unknown,
  replacements: readonly ExactSpanImageReplacement[] = [],
): NoHijackComparison {
  const violations: string[] = [];
  const prepared = replacements.map((replacement) => {
    if (replacement.provider !== provider) {
      return {
        result: {
          id: replacement.id,
          accepted: false,
          reason: `descriptor provider ${replacement.provider} does not match ${provider}`,
        } satisfies ImageReplacementResult,
      };
    }
    return prepareReplacement(originalRequest, candidateRequest, replacement);
  });
  const replacementResults = prepared.map((item) => item.result);
  for (const result of replacementResults) {
    if (!result.accepted) violations.push(`replacement ${result.id}: ${result.reason ?? 'rejected'}`);
  }
  const normalizedCandidate = applyPatches(
    candidateRequest,
    prepared.flatMap((item) => item.patch ? [item.patch] : []),
  );
  // Images and non-text blocks are model-visible too. After undoing only the
  // accepted descriptors, the entire candidate must be the caller request; this
  // rejects image-only synthetic messages that a text-only diff could not see.
  if (!jsonEqual(originalRequest, normalizedCandidate)) {
    violations.push('candidate differs outside the authorized exact-span image replacements');
  }

  const original = inventoryModelVisibleText(provider, originalRequest);
  const candidate = inventoryModelVisibleText(provider, normalizedCandidate);
  const diff = diffInventories(original, candidate);
  const forbiddenProse = forbiddenFindings(diff.added, diff.modified);
  const hasChanges = diff.added.length > 0 || diff.removed.length > 0 ||
    diff.moved.length > 0 || diff.modified.length > 0;
  return {
    ok: !hasChanges && forbiddenProse.length === 0 && violations.length === 0 &&
      replacementResults.every((result) => result.accepted),
    original,
    candidate,
    ...diff,
    forbiddenProse,
    replacements: replacementResults,
    violations,
  };
}
