/**
 * Pure body-shaping utilities for the uncompressed count_tokens counterfactual.
 * No fetch, auth, or Node APIs — hosts supply their own transport.
 */

export interface CountTokensBodies {
  /** Full original body, filtered to count_tokens-accepted fields. */
  readonly fullBody: Uint8Array | null;
  /** Original body truncated at the latest cache_control marker; null when none exists. */
  readonly cacheablePrefixBody: Uint8Array | null;
}

export type CallerCacheControlTier = 'none' | '5m' | '1h' | 'conservative_1h';

/** Exact source container whose text is a candidate for in-place replacement. */
export interface AnthropicChangedSpanLocation {
  readonly messageIndex: number;
  readonly blockIndex: number;
  /** Required only when the changed text is one part of an array-valued tool_result. */
  readonly toolResultPartIndex?: number;
}

/** Stable, JSON-safe address of the globally governing caller cache marker. */
export type CallerCacheControlPointer =
  | { readonly kind: 'tool'; readonly toolIndex: number }
  | { readonly kind: 'system'; readonly systemIndex: number }
  | { readonly kind: 'message'; readonly messageIndex: number }
  | {
      readonly kind: 'message_block';
      readonly messageIndex: number;
      readonly blockIndex: number;
    }
  | {
      readonly kind: 'tool_result_part';
      readonly messageIndex: number;
      readonly blockIndex: number;
      readonly toolResultPartIndex: number;
    };

export type ChangedSpanCacheCoverage =
  | { readonly kind: 'cold' }
  | {
      readonly kind: 'covered';
      readonly marker: CallerCacheControlPointer;
      /** Caller value without normalization. Omitted and malformed TTLs remain unknown. */
      readonly rawTtl: unknown;
    }
  | {
      readonly kind: 'unknown';
      readonly reason: 'invalid_body' | 'invalid_location' | 'ambiguous_location';
    };

/** Fields accepted by /v1/messages/count_tokens. Any other field returns 400 "Unknown parameter". */
const COUNT_TOKENS_FIELDS = new Set([
  'model',
  'messages',
  'system',
  'tools',
  'tool_choice',
  'thinking',
  'mcp_servers',
]);

type BytesLike = Uint8Array | ArrayBuffer | ArrayBufferView;

function toUint8Array(bytes: BytesLike): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function buildCountTokensBodies(bytes: BytesLike): CountTokensBodies {
  const b = toUint8Array(bytes);
  return {
    fullBody: buildBaselineCountTokensBody(b),
    cacheablePrefixBody: buildCacheablePrefixCountTokensBody(b),
  };
}

export function buildBaselineCountTokensBody(bytes: BytesLike): Uint8Array | null {
  const b = toUint8Array(bytes);
  try {
    const obj = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) {
      if (COUNT_TOKENS_FIELDS.has(k)) out[k] = obj[k];
    }
    if (typeof out.model !== 'string' || !Array.isArray(out.messages)) return null;
    return new TextEncoder().encode(JSON.stringify(out));
  } catch {
    return null;
  }
}

/** True when an object carries a cache_control key (presence only; value ignored). */
function hasCacheControl(x: unknown): boolean {
  return (
    typeof x === 'object'
    && x !== null
    && (x as { cache_control?: unknown }).cache_control != null
  );
}

function cacheControlTier(x: unknown): Exclude<CallerCacheControlTier, 'none'> | null {
  if (!hasCacheControl(x)) return null;
  const cacheControl = (x as { cache_control?: unknown }).cache_control;
  if (!cacheControl || typeof cacheControl !== 'object') return 'conservative_1h';
  const ttl = (cacheControl as { ttl?: unknown }).ttl;
  if (ttl === '5m') return '5m';
  if (ttl === '1h') return '1h';
  return 'conservative_1h';
}

interface CacheMarkerEntry {
  readonly kind: 'marker';
  readonly pointer: CallerCacheControlPointer;
  readonly rawTtl: unknown;
  readonly tier: Exclude<CallerCacheControlTier, 'none'>;
}

interface CacheSpanEntry {
  readonly kind: 'span';
  readonly key: string;
}

type CacheOrderEntry = CacheMarkerEntry | CacheSpanEntry;

function rawCacheControlTtl(x: unknown): unknown {
  if (!hasCacheControl(x)) return undefined;
  const cacheControl = (x as { cache_control?: unknown }).cache_control;
  return cacheControl && typeof cacheControl === 'object'
    ? (cacheControl as { ttl?: unknown }).ttl
    : undefined;
}

function changedSpanKey(location: AnthropicChangedSpanLocation): string {
  return location.toolResultPartIndex === undefined
    ? `m:${location.messageIndex}:b:${location.blockIndex}`
    : `m:${location.messageIndex}:b:${location.blockIndex}:p:${location.toolResultPartIndex}`;
}

function pushMarker(
  entries: CacheOrderEntry[],
  value: unknown,
  pointer: CallerCacheControlPointer,
): void {
  const tier = cacheControlTier(value);
  if (!tier) return;
  entries.push({
    kind: 'marker',
    pointer,
    rawTtl: rawCacheControlTtl(value),
    tier,
  });
}

/**
 * Flatten caller-owned cache locations in Anthropic cache order. A marker is
 * placed after the source it terminates, so a marker on a changed block/part
 * covers that source. Tool-result parts precede their outer block marker.
 */
function callerCacheOrder(obj: Record<string, unknown>): CacheOrderEntry[] {
  const entries: CacheOrderEntry[] = [];

  const tools = obj.tools;
  if (Array.isArray(tools)) {
    for (let toolIndex = 0; toolIndex < tools.length; toolIndex++) {
      pushMarker(entries, tools[toolIndex], { kind: 'tool', toolIndex });
    }
  }

  const system = obj.system;
  if (Array.isArray(system)) {
    for (let systemIndex = 0; systemIndex < system.length; systemIndex++) {
      pushMarker(entries, system[systemIndex], { kind: 'system', systemIndex });
    }
  }

  const messages = obj.messages;
  if (!Array.isArray(messages)) return entries;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex];
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      // Preserve the prefix builder's compatibility path for string-content
      // messages carrying a marker on the message object itself.
      pushMarker(entries, message, { kind: 'message', messageIndex });
      continue;
    }

    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      const block = content[blockIndex];
      if (!block || typeof block !== 'object') continue;
      const type = (block as { type?: unknown }).type;
      const blockContent = (block as { content?: unknown }).content;
      if (type === 'tool_result' && Array.isArray(blockContent)) {
        for (
          let toolResultPartIndex = 0;
          toolResultPartIndex < blockContent.length;
          toolResultPartIndex++
        ) {
          const part = blockContent[toolResultPartIndex];
          if (
            part
            && typeof part === 'object'
            && (part as { type?: unknown }).type === 'text'
            && typeof (part as { text?: unknown }).text === 'string'
          ) {
            entries.push({
              kind: 'span',
              key: changedSpanKey({ messageIndex, blockIndex, toolResultPartIndex }),
            });
          }
          pushMarker(entries, part, {
            kind: 'tool_result_part',
            messageIndex,
            blockIndex,
            toolResultPartIndex,
          });
        }
      } else if (
        (type === 'text' && typeof (block as { text?: unknown }).text === 'string')
        || (type === 'tool_result' && typeof blockContent === 'string')
      ) {
        entries.push({ kind: 'span', key: changedSpanKey({ messageIndex, blockIndex }) });
      }
      pushMarker(entries, block, { kind: 'message_block', messageIndex, blockIndex });
    }
  }
  return entries;
}

function lastCacheMarker(entries: readonly CacheOrderEntry[]): CacheMarkerEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind === 'marker') return entry;
  }
  return undefined;
}

function isAmbiguousChangedLocation(
  obj: Record<string, unknown>,
  location: AnthropicChangedSpanLocation,
): boolean {
  if (location.toolResultPartIndex !== undefined) return false;
  const messages = obj.messages;
  if (!Array.isArray(messages)) return false;
  const message = messages[location.messageIndex];
  if (!message || typeof message !== 'object') return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  const block = content[location.blockIndex];
  return Boolean(
    block
    && typeof block === 'object'
    && (block as { type?: unknown }).type === 'tool_result'
    && Array.isArray((block as { content?: unknown }).content),
  );
}

/**
 * Classify changed Anthropic source spans against the exact last caller-owned
 * cache marker. Results are parallel to `locations`; invalid structural
 * addresses fail unknown rather than guessing at a neighboring block.
 */
export function resolveChangedSpanCacheCoverage(
  bytes: BytesLike,
  locations: readonly AnthropicChangedSpanLocation[],
): ChangedSpanCacheCoverage[] {
  const b = toUint8Array(bytes);
  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b)) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { messages?: unknown }).messages)) {
      return locations.map(() => ({ kind: 'unknown', reason: 'invalid_body' }));
    }
    obj = parsed as Record<string, unknown>;
  } catch {
    return locations.map(() => ({ kind: 'unknown', reason: 'invalid_body' }));
  }

  const entries = callerCacheOrder(obj);
  const spanIndexes = new Map<string, number[]>();
  let governingIndex = -1;
  let governing: CacheMarkerEntry | undefined;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.kind === 'span') {
      const indexes = spanIndexes.get(entry.key) ?? [];
      indexes.push(index);
      spanIndexes.set(entry.key, indexes);
    } else {
      governingIndex = index;
      governing = entry;
    }
  }

  return locations.map((location): ChangedSpanCacheCoverage => {
    if (
      !location
      || !Number.isInteger(location.messageIndex)
      || !Number.isInteger(location.blockIndex)
      || location.messageIndex < 0
      || location.blockIndex < 0
      || (
        location.toolResultPartIndex !== undefined
        && (!Number.isInteger(location.toolResultPartIndex) || location.toolResultPartIndex < 0)
      )
    ) {
      return { kind: 'unknown', reason: 'invalid_location' };
    }
    if (isAmbiguousChangedLocation(obj, location)) {
      return { kind: 'unknown', reason: 'ambiguous_location' };
    }
    const indexes = spanIndexes.get(changedSpanKey(location));
    if (!indexes || indexes.length === 0) {
      return { kind: 'unknown', reason: 'invalid_location' };
    }
    if (indexes.length !== 1) {
      return { kind: 'unknown', reason: 'ambiguous_location' };
    }
    if (!governing) return { kind: 'cold' };
    return indexes[0]! <= governingIndex
      ? { kind: 'covered', marker: governing.pointer, rawTtl: governing.rawTtl }
      : { kind: 'cold' };
  });
}

/**
 * Resolve the caller-owned breakpoint used by the cacheable-prefix probe.
 * Search order intentionally matches buildCacheablePrefixCountTokensBody.
 * Missing or unfamiliar TTLs are conservatively one-hour; no marker is exact.
 */
export function readCallerCacheControlTier(bytes: BytesLike): CallerCacheControlTier {
  const b = toUint8Array(bytes);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  } catch {
    return 'none';
  }

  return lastCacheMarker(callerCacheOrder(obj))?.tier ?? 'none';
}

/** Return tool_use ids with no matching tool_result. count_tokens rejects orphans;
 *  truncating at a cache_control marker commonly creates them (result is in the dropped tail). */
function findOrphanToolUseIds(messages: unknown[]): string[] {
  const uses: string[] = [];
  const results = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (!blk || typeof blk !== 'object') continue;
      const t = (blk as { type?: unknown }).type;
      if (t === 'tool_use') {
        const id = (blk as { id?: unknown }).id;
        if (typeof id === 'string') uses.push(id);
      } else if (t === 'tool_result') {
        const id = (blk as { tool_use_id?: unknown }).tool_use_id;
        if (typeof id === 'string') results.add(id);
      }
    }
  }
  return uses.filter((id) => !results.has(id));
}

/** Append minimal synthetic tool_results for orphan tool_use ids so count_tokens won't reject the body.
 *  Adds only a handful of tokens; keeps estimate within ~1% of truth. */
function appendSyntheticToolResults(
  truncated: Record<string, unknown>,
): Record<string, unknown> {
  const messages = truncated.messages;
  if (!Array.isArray(messages)) return truncated;
  const orphanIds = findOrphanToolUseIds(messages);
  if (orphanIds.length === 0) return truncated;
  const syntheticUserMsg = {
    role: 'user',
    content: orphanIds.map((id) => ({
      type: 'tool_result',
      tool_use_id: id,
      content: 'ok',
    })),
  };
  return { ...truncated, messages: [...messages, syntheticUserMsg] };
}

/** Top-level controls accepted by count_tokens that affect construction or
 * cache identity of the prompt prefix. Omitting them can price caller-cached
 * tokens as cold while underpricing the rebuilt candidate prefix. */
function cacheRelevantTopLevelControls(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['tool_choice', 'thinking', 'mcp_servers'] as const) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function truncateAtCallerMarker(
  obj: Record<string, unknown>,
  marker: CallerCacheControlPointer,
): Record<string, unknown> | null {
  const model = obj.model;
  const tools = obj.tools;
  const system = obj.system;
  const messages = obj.messages;
  const controls = cacheRelevantTopLevelControls(obj);

  if (marker.kind === 'tool') {
    if (!Array.isArray(tools) || marker.toolIndex >= tools.length) return null;
    return {
      model,
      ...controls,
      tools: tools.slice(0, marker.toolIndex + 1),
      messages: [{ role: 'user', content: 'x' }],
    };
  }

  if (marker.kind === 'system') {
    if (!Array.isArray(system) || marker.systemIndex >= system.length) return null;
    return {
      model,
      ...controls,
      ...(tools !== undefined ? { tools } : {}),
      system: system.slice(0, marker.systemIndex + 1),
      messages: [{ role: 'user', content: 'x' }],
    };
  }

  if (!Array.isArray(messages) || marker.messageIndex >= messages.length) return null;
  if (marker.kind === 'message') {
    const truncated: Record<string, unknown> = {
      model,
      ...controls,
      messages: messages.slice(0, marker.messageIndex + 1),
    };
    if (system !== undefined) truncated.system = system;
    if (tools !== undefined) truncated.tools = tools;
    return truncated;
  }

  const message = messages[marker.messageIndex];
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || marker.blockIndex >= content.length) return null;
  let truncatedBlock = content[marker.blockIndex];
  if (marker.kind === 'tool_result_part') {
    if (!truncatedBlock || typeof truncatedBlock !== 'object') return null;
    const parts = (truncatedBlock as { content?: unknown }).content;
    if (!Array.isArray(parts) || marker.toolResultPartIndex >= parts.length) return null;
    truncatedBlock = {
      ...truncatedBlock,
      content: parts.slice(0, marker.toolResultPartIndex + 1),
    };
  }
  const truncatedMessage = {
    ...message,
    content: content.slice(0, marker.blockIndex).concat([truncatedBlock]),
  };
  const truncated: Record<string, unknown> = {
    model,
    ...controls,
    messages: messages.slice(0, marker.messageIndex).concat([truncatedMessage]),
  };
  if (system !== undefined) truncated.system = system;
  if (tools !== undefined) truncated.tools = tools;
  return truncated;
}


/** Build a body containing only the longest cacheable prefix (everything up to and including the last
 *  cache_control marker). count_tokens on this body gives cacheable_prefix_tokens.
 *  Walk order (latest-first in cache order): messages → system → tools.
 *  Returns null when no markers exist (cacheable_prefix_tokens = 0). */
export function buildCacheablePrefixCountTokensBody(bytes: BytesLike): Uint8Array | null {
  const b = toUint8Array(bytes);
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(new TextDecoder().decode(b)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.model !== 'string') return null;

  const marker = lastCacheMarker(callerCacheOrder(obj));
  if (!marker) return null;
  let truncated = truncateAtCallerMarker(obj, marker.pointer);
  if (!truncated) return null;
  truncated = appendSyntheticToolResults(truncated);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(truncated)) {
    if (COUNT_TOKENS_FIELDS.has(k)) out[k] = truncated[k];
  }
  return new TextEncoder().encode(JSON.stringify(out));
}

/** Count cache_control markers anywhere in an Anthropic Messages body. */
export function countCacheControlMarkers(bytes: BytesLike): number {
  const b = toUint8Array(bytes);
  try {
    return countCacheControlValue(JSON.parse(new TextDecoder().decode(b)));
  } catch {
    return 0;
  }
}

function countCacheControlValue(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  let n = hasCacheControl(value) ? 1 : 0;
  if (Array.isArray(value)) {
    for (const item of value) n += countCacheControlValue(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      n += countCacheControlValue(item);
    }
  }
  return n;
}
