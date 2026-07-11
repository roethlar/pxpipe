/**
 * Pure, exact-position Anthropic image splices.
 *
 * These helpers do not render, price, probe, or perform I/O. They clone only the
 * request path they change and return the descriptor required by compareNoHijack.
 * Every unsupported or uncertain input returns the original request object.
 */

import {
  CLAUDE_CODE_2_1_205_SOURCE,
  type ProjectGuidanceSegment,
} from './anthropic-context.js';
import type { AnthropicChangedSpanLocation } from './measurement.js';
import type { ExactSpanImageReplacement } from './no-hijack.js';
import type {
  CacheControl,
  ContentBlock,
  ImageBlock,
  Message,
  MessagesRequest,
  TextBlock,
  ToolResultBlock,
} from './types.js';

type JsonRecord = Record<string, unknown>;

export type AnthropicExactFailureReason =
  | 'wrong_source'
  | 'unsupported_shape'
  | 'error_result'
  | 'empty_images'
  | 'ambiguous_indices';

export type { AnthropicChangedSpanLocation } from './measurement.js';

export interface AnthropicExactReplacementSuccess {
  readonly ok: true;
  readonly request: MessagesRequest;
  readonly descriptor: ExactSpanImageReplacement;
  readonly changedSpan: AnthropicChangedSpanLocation;
}

export interface AnthropicExactReplacementFailure {
  readonly ok: false;
  /** Exact caller object: failures never return a partial clone. */
  readonly request: MessagesRequest;
  readonly reason: AnthropicExactFailureReason;
}

export type AnthropicExactReplacementResult =
  | AnthropicExactReplacementSuccess
  | AnthropicExactReplacementFailure;

export interface ReplaceAnthropicUserTextSpanInput {
  readonly request: MessagesRequest;
  /** Accepted parser output; arbitrary user text is not eligible. */
  readonly source: ProjectGuidanceSegment;
  readonly images: readonly ImageBlock[];
  readonly id: string;
}

export type AnthropicToolResultTextSource =
  | {
      readonly kind: 'tool_result_string';
      readonly messageIndex: number;
      readonly blockIndex: number;
      /** Must equal the complete successful tool_result string. */
      readonly expectedText: string;
    }
  | {
      readonly kind: 'tool_result_text_part';
      readonly messageIndex: number;
      readonly blockIndex: number;
      readonly partIndex: number;
      /** Must equal the complete selected text part. */
      readonly expectedText: string;
    };

export interface ReplaceAnthropicToolResultTextInput {
  readonly request: MessagesRequest;
  readonly source: AnthropicToolResultTextSource;
  readonly images: readonly ImageBlock[];
  readonly id: string;
}

export type AnthropicExactImageOperation =
  | {
      readonly kind: 'user_text_span';
      readonly source: ProjectGuidanceSegment;
      readonly images: readonly ImageBlock[];
      readonly id: string;
    }
  | {
      readonly kind: 'tool_result_text';
      readonly source: AnthropicToolResultTextSource;
      readonly images: readonly ImageBlock[];
      readonly id: string;
    };

export interface ApplyAnthropicExactImageReplacementsInput {
  readonly request: MessagesRequest;
  /**
   * Every operation is located against the same original request. The helper
   * computes all final candidate indices after earlier splices expand arrays.
   */
  readonly operations: readonly AnthropicExactImageOperation[];
}

export interface AnthropicExactBatchSuccess {
  readonly ok: true;
  readonly request: MessagesRequest;
  /** Safe normalization order: nested replacements in one tool_result run last-to-first. */
  readonly descriptors: readonly ExactSpanImageReplacement[];
  /** Positional peers of `descriptors`. */
  readonly changedSpans: readonly AnthropicChangedSpanLocation[];
}

export type AnthropicExactBatchResult =
  | AnthropicExactBatchSuccess
  | AnthropicExactReplacementFailure;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, allowed: readonly string[]): boolean {
  const accepted = new Set(allowed);
  return Object.keys(value).every((key) => accepted.has(key));
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isCacheControl(value: unknown): value is CacheControl {
  if (!isRecord(value) || !hasOnlyKeys(value, ['type', 'ttl'])) return false;
  return value.type === 'ephemeral' &&
    (value.ttl === undefined || value.ttl === '5m' || value.ttl === '1h');
}

function hasSupportedCacheControl(value: JsonRecord): boolean {
  return value.cache_control === undefined || isCacheControl(value.cache_control);
}

function isSupportedTextBlock(value: unknown): value is TextBlock {
  return isRecord(value) &&
    value.type === 'text' &&
    typeof value.text === 'string' &&
    hasOnlyKeys(value, ['type', 'text', 'cache_control']) &&
    hasSupportedCacheControl(value);
}

const IMAGE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

function isUnmarkedImageBlock(value: unknown): value is ImageBlock {
  if (
    !isRecord(value) ||
    value.type !== 'image' ||
    !hasOnlyKeys(value, ['type', 'source']) ||
    !isRecord(value.source) ||
    !hasOnlyKeys(value.source, ['type', 'media_type', 'data'])
  ) {
    return false;
  }
  return value.source.type === 'base64' &&
    typeof value.source.media_type === 'string' &&
    IMAGE_MEDIA_TYPES.has(value.source.media_type) &&
    typeof value.source.data === 'string' &&
    value.source.data.length > 0;
}

function cloneImage(value: ImageBlock): ImageBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: value.source.media_type,
      data: value.source.data,
    },
  };
}

function cloneCacheControl(value: CacheControl): CacheControl {
  return value.ttl === undefined
    ? { type: 'ephemeral' }
    : { type: 'ephemeral', ttl: value.ttl };
}

function replacementParts(
  sourceText: string,
  start: number,
  end: number,
  images: readonly ImageBlock[],
  marker: CacheControl | undefined,
): Array<TextBlock | ImageBlock> {
  const parts: Array<TextBlock | ImageBlock> = [];
  const prefix = sourceText.slice(0, start);
  const suffix = sourceText.slice(end);
  if (prefix) parts.push({ type: 'text', text: prefix });
  parts.push(...images.map(cloneImage));
  if (suffix) parts.push({ type: 'text', text: suffix });
  if (marker) {
    const last = parts[parts.length - 1]!;
    parts[parts.length - 1] = {
      ...last,
      cache_control: cloneCacheControl(marker),
    };
  }
  return parts;
}

function validateImages(
  request: MessagesRequest,
  images: readonly ImageBlock[],
): AnthropicExactReplacementFailure | undefined {
  if (!Array.isArray(images) || images.length === 0) {
    return { ok: false, request, reason: 'empty_images' };
  }
  if (!images.every(isUnmarkedImageBlock)) {
    return { ok: false, request, reason: 'unsupported_shape' };
  }
  return undefined;
}

function validateId(
  request: MessagesRequest,
  id: string,
): AnthropicExactReplacementFailure | undefined {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, request, reason: 'unsupported_shape' };
  }
  return undefined;
}

function messageAt(
  request: MessagesRequest,
  messageIndex: number,
): Message | undefined {
  return Array.isArray(request.messages) ? request.messages[messageIndex] : undefined;
}

function cloneWithMessageContent(
  request: MessagesRequest,
  messageIndex: number,
  content: ContentBlock[],
): MessagesRequest {
  const messages = request.messages.slice();
  messages[messageIndex] = {
    ...messages[messageIndex]!,
    content,
  };
  return { ...request, messages };
}

function projectSourceIsSupported(source: ProjectGuidanceSegment): boolean {
  if (
    !isRecord(source) ||
    source.kind !== 'project_guidance' ||
    source.source !== CLAUDE_CODE_2_1_205_SOURCE ||
    typeof source.text !== 'string' ||
    source.text.length === 0 ||
    !isRecord(source.locator)
  ) {
    return false;
  }
  const { messageIndex, blockIndex, start, end } = source.locator;
  return isIndex(messageIndex) &&
    isIndex(blockIndex) &&
    isIndex(start) &&
    isIndex(end) &&
    end > start;
}

/**
 * Replace one accepted project-guidance substring in its original user text block.
 * Exact prefix/suffix bytes remain adjacent to the images; a caller marker moves
 * only to the final replacement part, preserving its original boundary.
 */
export function replaceAnthropicUserTextSpanWithImages(
  input: ReplaceAnthropicUserTextSpanInput,
): AnthropicExactReplacementResult {
  const { request, source, images, id } = input;
  const invalidImages = validateImages(request, images);
  if (invalidImages) return invalidImages;
  const invalidId = validateId(request, id);
  if (invalidId) return invalidId;
  if (!projectSourceIsSupported(source)) {
    const locator = isRecord(source) && isRecord(source.locator)
      ? source.locator
      : undefined;
    const indicesValid = locator !== undefined &&
      isIndex(locator.messageIndex) &&
      isIndex(locator.blockIndex) &&
      isIndex(locator.start) &&
      isIndex(locator.end);
    return {
      ok: false,
      request,
      reason: indicesValid ? 'wrong_source' : 'ambiguous_indices',
    };
  }

  const { messageIndex, blockIndex, start, end } = source.locator;
  const message = messageAt(request, messageIndex);
  if (!message || !Array.isArray(message.content) || message.content[blockIndex] === undefined) {
    return { ok: false, request, reason: 'ambiguous_indices' };
  }
  if (message.role !== 'user') {
    return { ok: false, request, reason: 'unsupported_shape' };
  }
  const block = message.content[blockIndex];
  if (!isSupportedTextBlock(block)) {
    return { ok: false, request, reason: 'unsupported_shape' };
  }
  if (
    end > block.text.length ||
    block.text.slice(start, end) !== source.text
  ) {
    return { ok: false, request, reason: 'wrong_source' };
  }

  const parts = replacementParts(
    block.text,
    start,
    end,
    images,
    block.cache_control,
  );
  const content = message.content.slice();
  content.splice(blockIndex, 1, ...parts);
  const candidate = cloneWithMessageContent(request, messageIndex, content);
  return {
    ok: true,
    request: candidate,
    descriptor: {
      id,
      provider: 'anthropic',
      target: {
        kind: 'message_text_block',
        messageIndex,
        originalBlockIndex: blockIndex,
        candidateStartIndex: blockIndex,
      },
      start,
      end,
      expectedText: source.text,
      imageCount: images.length,
    },
    changedSpan: {
      messageIndex,
      blockIndex,
    },
  };
}

function isSupportedToolResultBlock(value: unknown): value is ToolResultBlock {
  return isRecord(value) &&
    value.type === 'tool_result' &&
    typeof value.tool_use_id === 'string' &&
    value.tool_use_id.length > 0 &&
    hasOnlyKeys(value, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control']) &&
    (value.is_error === undefined || typeof value.is_error === 'boolean') &&
    hasSupportedCacheControl(value);
}

/**
 * Replace one complete successful tool_result string, or one complete exact text
 * part, inside its original tool_result container.
 */
export function replaceAnthropicToolResultTextWithImages(
  input: ReplaceAnthropicToolResultTextInput,
): AnthropicExactReplacementResult {
  const { request, source, images, id } = input;
  const invalidImages = validateImages(request, images);
  if (invalidImages) return invalidImages;
  const invalidId = validateId(request, id);
  if (invalidId) return invalidId;
  if (
    !isRecord(source) ||
    (source.kind !== 'tool_result_string' && source.kind !== 'tool_result_text_part') ||
    !isIndex(source.messageIndex) ||
    !isIndex(source.blockIndex) ||
    typeof source.expectedText !== 'string' ||
    source.expectedText.length === 0
  ) {
    return { ok: false, request, reason: 'ambiguous_indices' };
  }
  if (
    source.kind === 'tool_result_text_part' &&
    !isIndex(source.partIndex)
  ) {
    return { ok: false, request, reason: 'ambiguous_indices' };
  }

  const { messageIndex, blockIndex } = source;
  const message = messageAt(request, messageIndex);
  if (!message || !Array.isArray(message.content) || message.content[blockIndex] === undefined) {
    return { ok: false, request, reason: 'ambiguous_indices' };
  }
  if (message.role !== 'user') {
    return { ok: false, request, reason: 'unsupported_shape' };
  }
  const block = message.content[blockIndex];
  if (!isSupportedToolResultBlock(block)) {
    return { ok: false, request, reason: 'unsupported_shape' };
  }
  if (block.is_error === true) {
    return { ok: false, request, reason: 'error_result' };
  }

  let nextToolContent: Array<TextBlock | ImageBlock>;
  let descriptorTarget: ExactSpanImageReplacement['target'];
  let changedSpan: AnthropicChangedSpanLocation;
  if (source.kind === 'tool_result_string') {
    if (typeof block.content !== 'string') {
      return { ok: false, request, reason: 'unsupported_shape' };
    }
    if (block.content !== source.expectedText) {
      return { ok: false, request, reason: 'wrong_source' };
    }
    nextToolContent = replacementParts(
      block.content,
      0,
      block.content.length,
      images,
      undefined,
    );
    descriptorTarget = {
      kind: 'tool_result_string',
      messageIndex,
      originalBlockIndex: blockIndex,
      candidateBlockIndex: blockIndex,
      candidateStartIndex: 0,
    };
    changedSpan = {
      messageIndex,
      blockIndex,
    };
  } else {
    if (!Array.isArray(block.content) || block.content[source.partIndex] === undefined) {
      return { ok: false, request, reason: 'ambiguous_indices' };
    }
    const part = block.content[source.partIndex];
    if (!isSupportedTextBlock(part)) {
      return { ok: false, request, reason: 'unsupported_shape' };
    }
    if (part.text !== source.expectedText) {
      return { ok: false, request, reason: 'wrong_source' };
    }
    const parts = replacementParts(
      part.text,
      0,
      part.text.length,
      images,
      part.cache_control,
    );
    nextToolContent = block.content.slice();
    nextToolContent.splice(source.partIndex, 1, ...parts);
    descriptorTarget = {
      kind: 'tool_result_text_part',
      messageIndex,
      originalBlockIndex: blockIndex,
      originalPartIndex: source.partIndex,
      candidateBlockIndex: blockIndex,
      candidateStartIndex: source.partIndex,
    };
    changedSpan = {
      messageIndex,
      blockIndex,
      toolResultPartIndex: source.partIndex,
    };
  }

  const nextBlock: ToolResultBlock = {
    ...block,
    content: nextToolContent,
  };
  const content = message.content.slice();
  content[blockIndex] = nextBlock;
  const candidate = cloneWithMessageContent(request, messageIndex, content);
  return {
    ok: true,
    request: candidate,
    descriptor: {
      id,
      provider: 'anthropic',
      target: descriptorTarget,
      start: 0,
      end: source.expectedText.length,
      expectedText: source.expectedText,
      imageCount: images.length,
    },
    changedSpan,
  };
}

interface PreparedBase {
  readonly operationIndex: number;
  readonly descriptor: ExactSpanImageReplacement;
  readonly changedSpan: AnthropicChangedSpanLocation;
}

type PreparedReplacement =
  | (PreparedBase & {
      readonly kind: 'message_text_block';
      readonly messageIndex: number;
      readonly blockIndex: number;
      readonly parts: readonly ContentBlock[];
    })
  | (PreparedBase & {
      readonly kind: 'tool_result_string';
      readonly messageIndex: number;
      readonly blockIndex: number;
      readonly parts: readonly (TextBlock | ImageBlock)[];
    })
  | (PreparedBase & {
      readonly kind: 'tool_result_text_part';
      readonly messageIndex: number;
      readonly blockIndex: number;
      readonly partIndex: number;
      readonly parts: readonly (TextBlock | ImageBlock)[];
    });

interface OuterReplacementGroup {
  readonly messageIndex: number;
  readonly blockIndex: number;
  message?: Extract<PreparedReplacement, { kind: 'message_text_block' }>;
  toolString?: Extract<PreparedReplacement, { kind: 'tool_result_string' }>;
  readonly toolParts: Map<number, Extract<PreparedReplacement, { kind: 'tool_result_text_part' }>>;
}

function prepareBatchOperation(
  request: MessagesRequest,
  operation: AnthropicExactImageOperation,
  operationIndex: number,
): PreparedReplacement | AnthropicExactReplacementFailure {
  if (operation.kind === 'user_text_span') {
    const result = replaceAnthropicUserTextSpanWithImages({
      request,
      source: operation.source,
      images: operation.images,
      id: operation.id,
    });
    if (!result.ok) return result;
    const { messageIndex, blockIndex, start, end } = operation.source.locator;
    const originalMessage = messageAt(request, messageIndex)!;
    const originalBlock = (originalMessage.content as ContentBlock[])[blockIndex] as TextBlock;
    return {
      kind: 'message_text_block',
      operationIndex,
      messageIndex,
      blockIndex,
      parts: replacementParts(
        originalBlock.text,
        start,
        end,
        operation.images,
        originalBlock.cache_control,
      ),
      descriptor: result.descriptor,
      changedSpan: result.changedSpan,
    };
  }

  const result = replaceAnthropicToolResultTextWithImages({
    request,
    source: operation.source,
    images: operation.images,
    id: operation.id,
  });
  if (!result.ok) return result;
  const { messageIndex, blockIndex } = operation.source;
  const originalMessage = messageAt(request, messageIndex)!;
  const originalBlock = (originalMessage.content as ContentBlock[])[blockIndex] as ToolResultBlock;
  if (operation.source.kind === 'tool_result_string') {
    return {
      kind: 'tool_result_string',
      operationIndex,
      messageIndex,
      blockIndex,
      parts: replacementParts(
        originalBlock.content as string,
        0,
        operation.source.expectedText.length,
        operation.images,
        undefined,
      ),
      descriptor: result.descriptor,
      changedSpan: result.changedSpan,
    };
  }
  const originalPart = (originalBlock.content as Array<TextBlock | ImageBlock>)[operation.source.partIndex] as TextBlock;
  return {
    kind: 'tool_result_text_part',
    operationIndex,
    messageIndex,
    blockIndex,
    partIndex: operation.source.partIndex,
    parts: replacementParts(
      originalPart.text,
      0,
      originalPart.text.length,
      operation.images,
      originalPart.cache_control,
    ),
    descriptor: result.descriptor,
    changedSpan: result.changedSpan,
  };
}

function rebasedDescriptor(
  prepared: PreparedReplacement,
  candidateBlockIndex: number,
  candidateStartIndex: number,
): ExactSpanImageReplacement {
  const target = prepared.descriptor.target;
  if (target.kind === 'message_text_block') {
    return {
      ...prepared.descriptor,
      target: {
        ...target,
        candidateStartIndex,
      },
    };
  }
  return {
    ...prepared.descriptor,
    target: {
      ...target,
      candidateBlockIndex,
      candidateStartIndex,
    },
  };
}

/**
 * Apply every exact splice atomically against one original request.
 *
 * Building from the original arrays in provider order keeps original indices
 * stable while deriving final candidate indices after every earlier expansion.
 * Duplicate/overlapping targets fail wholly native.
 */
export function applyAnthropicExactImageReplacements(
  input: ApplyAnthropicExactImageReplacementsInput,
): AnthropicExactBatchResult {
  const { request, operations } = input;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { ok: false, request, reason: 'unsupported_shape' };
  }

  const ids = new Set<string>();
  const groups = new Map<string, OuterReplacementGroup>();
  const prepared: PreparedReplacement[] = [];
  for (let operationIndex = 0; operationIndex < operations.length; operationIndex++) {
    const operation = operations[operationIndex]!;
    if (ids.has(operation.id)) {
      return { ok: false, request, reason: 'ambiguous_indices' };
    }
    ids.add(operation.id);
    const item = prepareBatchOperation(request, operation, operationIndex);
    if ('ok' in item) return item;
    prepared.push(item);

    const key = `${item.messageIndex}:${item.blockIndex}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        messageIndex: item.messageIndex,
        blockIndex: item.blockIndex,
        toolParts: new Map(),
      };
      groups.set(key, group);
    }
    if (item.kind === 'message_text_block') {
      if (group.message || group.toolString || group.toolParts.size > 0) {
        return { ok: false, request, reason: 'ambiguous_indices' };
      }
      group.message = item;
    } else if (item.kind === 'tool_result_string') {
      if (group.message || group.toolString || group.toolParts.size > 0) {
        return { ok: false, request, reason: 'ambiguous_indices' };
      }
      group.toolString = item;
    } else {
      if (group.message || group.toolString || group.toolParts.has(item.partIndex)) {
        return { ok: false, request, reason: 'ambiguous_indices' };
      }
      group.toolParts.set(item.partIndex, item);
    }
  }

  const descriptors = new Array<ExactSpanImageReplacement>(operations.length);
  const changedSpans = new Array<AnthropicChangedSpanLocation>(operations.length);
  const groupsByMessage = new Map<number, Map<number, OuterReplacementGroup>>();
  for (const group of groups.values()) {
    let blocks = groupsByMessage.get(group.messageIndex);
    if (!blocks) {
      blocks = new Map();
      groupsByMessage.set(group.messageIndex, blocks);
    }
    blocks.set(group.blockIndex, group);
  }

  const messages = request.messages.slice();
  for (const [messageIndex, blockGroups] of groupsByMessage) {
    const originalMessage = request.messages[messageIndex]!;
    const originalContent = originalMessage.content as ContentBlock[];
    const candidateContent: ContentBlock[] = [];
    for (let blockIndex = 0; blockIndex < originalContent.length; blockIndex++) {
      const originalBlock = originalContent[blockIndex]!;
      const group = blockGroups.get(blockIndex);
      if (!group) {
        candidateContent.push(originalBlock);
        continue;
      }
      const candidateBlockIndex = candidateContent.length;
      if (group.message) {
        const item = group.message;
        candidateContent.push(...item.parts);
        descriptors[item.operationIndex] = rebasedDescriptor(
          item,
          candidateBlockIndex,
          candidateBlockIndex,
        );
        changedSpans[item.operationIndex] = item.changedSpan;
        continue;
      }
      if (group.toolString) {
        const item = group.toolString;
        candidateContent.push({
          ...(originalBlock as ToolResultBlock),
          content: item.parts.slice(),
        });
        descriptors[item.operationIndex] = rebasedDescriptor(item, candidateBlockIndex, 0);
        changedSpans[item.operationIndex] = item.changedSpan;
        continue;
      }

      const toolResult = originalBlock as ToolResultBlock;
      const originalParts = toolResult.content as Array<TextBlock | ImageBlock>;
      const candidateParts: Array<TextBlock | ImageBlock> = [];
      for (let partIndex = 0; partIndex < originalParts.length; partIndex++) {
        const item = group.toolParts.get(partIndex);
        if (!item) {
          candidateParts.push(originalParts[partIndex]!);
          continue;
        }
        const candidateStartIndex = candidateParts.length;
        candidateParts.push(...item.parts);
        descriptors[item.operationIndex] = rebasedDescriptor(
          item,
          candidateBlockIndex,
          candidateStartIndex,
        );
        changedSpans[item.operationIndex] = item.changedSpan;
      }
      candidateContent.push({
        ...toolResult,
        content: candidateParts,
      });
    }
    messages[messageIndex] = {
      ...originalMessage,
      content: candidateContent,
    };
  }

  const normalizationOrder = prepared.slice().sort((a, b) => {
    const aTarget = descriptors[a.operationIndex]!.target;
    const bTarget = descriptors[b.operationIndex]!.target;
    if (
      aTarget.kind !== 'message_text_block' &&
      bTarget.kind !== 'message_text_block' &&
      aTarget.messageIndex === bTarget.messageIndex &&
      aTarget.candidateBlockIndex === bTarget.candidateBlockIndex
    ) {
      return bTarget.candidateStartIndex - aTarget.candidateStartIndex;
    }
    return a.operationIndex - b.operationIndex;
  });
  return {
    ok: true,
    request: { ...request, messages },
    descriptors: normalizationOrder.map((item) => descriptors[item.operationIndex]!),
    changedSpans: normalizationOrder.map((item) => changedSpans[item.operationIndex]!),
  };
}
