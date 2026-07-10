import type {
  ContentBlock,
  MessagesRequest,
  TextBlock,
} from './types.js';

/** Wire shape captured locally from Claude Code 2.1.205 (no upstream model call). */
export const CLAUDE_CODE_2_1_205_SOURCE = 'claude_code_2_1_205_opening_reminder' as const;
export const CLAUDE_CODE_2_1_205_RUNTIME_SOURCE =
  'claude_code_2_1_205_opening_runtime_tail' as const;

export const CLAUDE_USER_CONTEXT_OPENER =
  '<system-reminder>\n' +
  "As you answer the user's questions, you can use the following context:\n";

export const CLAUDE_MD_HEADING = '# claudeMd\n';

export const CLAUDE_MD_PREAMBLE =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. ' +
  'IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.\n\n';

export const CLAUDE_USER_CONTEXT_ADVISORY =
  '      IMPORTANT: this context may or may not be relevant to your tasks. ' +
  'You should not respond to this context unless it is highly relevant to your task.';

export const CLAUDE_USER_CONTEXT_CLOSER =
  `\n\n${CLAUDE_USER_CONTEXT_ADVISORY}\n</system-reminder>\n\n`;

/** Source evidence for the sanitized fixtures committed with the parser. */
export const CLAUDE_CODE_2_1_205_BINARY_SHA256 =
  '33E28624C5AE84F2BD7D2D8761E5D2E77997BA965CB11B6448DE6B6E2C566F9C';

/** Shared binding marker for the role-bound project pages introduced in Slice 2. */
export const PROJECT_GUIDANCE_BOUNDARY_PREFIX = '[End of rendered project guidance ref=';
export const PROJECT_GUIDANCE_BOUNDARY_SUFFIX = ']';

export function makeProjectGuidanceBoundary(ref: string): string {
  return `${PROJECT_GUIDANCE_BOUNDARY_PREFIX}${ref}${PROJECT_GUIDANCE_BOUNDARY_SUFFIX}`;
}

export function projectGuidanceBoundaryRef(text: string): string | undefined {
  if (!text.startsWith(PROJECT_GUIDANCE_BOUNDARY_PREFIX) || !text.endsWith(PROJECT_GUIDANCE_BOUNDARY_SUFFIX)) {
    return undefined;
  }
  const ref = text.slice(PROJECT_GUIDANCE_BOUNDARY_PREFIX.length, -PROJECT_GUIDANCE_BOUNDARY_SUFFIX.length);
  return /^[a-z0-9_-]{4,128}$/i.test(ref) ? ref : undefined;
}

export function isProjectGuidanceBoundaryBlock(
  block: ContentBlock | undefined,
  expectedRef?: string,
): block is TextBlock {
  if (!block || block.type !== 'text') return false;
  const ref = projectGuidanceBoundaryRef(block.text);
  return ref !== undefined && (expectedRef === undefined || ref === expectedRef);
}

export interface TextSpanLocator {
  readonly messageIndex: number;
  readonly blockIndex: number;
  readonly start: number;
  readonly end: number;
}

export interface ProjectGuidanceSegment {
  readonly kind: 'project_guidance';
  readonly source: typeof CLAUDE_CODE_2_1_205_SOURCE;
  readonly locator: TextSpanLocator;
  /** Complete `# claudeMd` bundle, including Claude Code's fixed preamble. */
  readonly text: string;
}

export interface OpeningContextCarrier {
  readonly kind: 'opening_context_carrier';
  readonly source: typeof CLAUDE_CODE_2_1_205_SOURCE;
  /** Full block-zero span. Slice 2 uses this even when its contents fail closed. */
  readonly locator: TextSpanLocator;
  readonly text: string;
}

export interface RuntimeMetadataSegment {
  readonly kind: 'runtime_metadata';
  readonly source: typeof CLAUDE_CODE_2_1_205_RUNTIME_SOURCE;
  readonly shape: 'opening_runtime_tail_v1';
  readonly locator: TextSpanLocator;
  /** One contiguous removal unit so optional sibling fields cannot move partially. */
  readonly text: string;
  /** Exact child identities retained without flattening the captured sibling fields. */
  readonly fields: readonly RuntimeMetadataField[];
}

export interface RuntimeMetadataField {
  readonly name: 'userEmail' | 'currentDate';
  readonly locator: TextSpanLocator;
  readonly text: string;
}

export interface UncertainContextSegment {
  readonly kind: 'uncertain';
  readonly source: 'opening_user_context';
  readonly messageIndex: 0;
  readonly blockIndex: 0;
  readonly reason: string;
}

export interface AnthropicContextPartition {
  /** Exact captured carrier location, exposed independently of project recognition. */
  readonly openingCarrier?: OpeningContextCarrier;
  readonly projectGuidance?: ProjectGuidanceSegment;
  /** Exact data-only sibling tails eligible for the separately vouched runtime bucket. */
  readonly runtimeMetadata: readonly RuntimeMetadataSegment[];
  readonly uncertain: readonly UncertainContextSegment[];
}

export interface TextSpanReplacement {
  readonly request: MessagesRequest;
  /** Locator of the replacement bytes in the cloned request. */
  readonly locator: TextSpanLocator;
}

const CURRENT_DATE_LINE = /^Today's date is (\d{4}-\d{2}-\d{2})\.$/;

function firstOpeningBlock(req: MessagesRequest): TextBlock | undefined {
  const first = req.messages?.[0];
  if (!first || first.role !== 'user' || !Array.isArray(first.content)) return undefined;
  // Captured host context is block zero and the live user carrier is a separate
  // following text block. Requiring both prevents ordinary single-block pastes
  // from becoming privileged merely because they imitate the wrapper.
  const block = first.content[0];
  const live = first.content[1];
  if (!block || block.type !== 'text' || !live || live.type !== 'text') return undefined;
  return block;
}

interface ParsedTail {
  projectEnd: number;
  runtimeStart: number;
  runtimeEnd: number;
  fields: readonly {
    name: RuntimeMetadataField['name'];
    start: number;
    end: number;
  }[];
}

/**
 * Recognize only the captured sibling tail:
 *   [# userEmail + one line]\n# currentDate\nToday's date is YYYY-MM-DD.
 * followed by the fixed outer advisory/closer. Unknown siblings fail closed.
 *
 * Parsing is anchored from the end, so heading/trailer lookalikes inside the
 * unescaped CLAUDE/AGENTS payload remain part of the project bundle.
 */
function isExactCapturedEmail(value: string): boolean {
  const prefix = "The user's email address is ";
  if (!value.startsWith(prefix) || !value.endsWith('.') || value.length > prefix.length + 321) {
    return false;
  }
  const address = value.slice(prefix.length, -1);
  if (!address || /[\s<>#]/.test(address)) return false;
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) return false;
  const domain = address.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

function isExactCapturedDate(value: string): boolean {
  const match = CURRENT_DATE_LINE.exec(value);
  if (!match) return false;
  const iso = match[1]!;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === iso;
}

function parseCapturedTail(text: string, projectStart: number): ParsedTail | undefined {
  if (!text.endsWith(CLAUDE_USER_CONTEXT_CLOSER)) return undefined;
  const bodyEnd = text.length - CLAUDE_USER_CONTEXT_CLOSER.length;
  const body = text.slice(0, bodyEnd);

  const currentMarker = '\n# currentDate\n';
  const currentAt = body.lastIndexOf(currentMarker);
  if (currentAt < projectStart) return undefined;
  const currentValue = body.slice(currentAt + currentMarker.length);
  if (!isExactCapturedDate(currentValue)) return undefined;

  let runtimeStart = currentAt;
  const fields: Array<{ name: RuntimeMetadataField['name']; start: number; end: number }> = [{
    name: 'currentDate',
    start: currentAt,
    end: bodyEnd,
  }];
  const beforeCurrent = body.slice(projectStart, currentAt);
  const emailMarker = '\n# userEmail\n';
  const emailAtRelative = beforeCurrent.lastIndexOf(emailMarker);
  if (emailAtRelative >= 0) {
    const emailValue = beforeCurrent.slice(emailAtRelative + emailMarker.length);
    if (!emailValue.includes('\n')) {
      // A one-line marker immediately adjacent to currentDate is unambiguously a
      // sibling candidate. It must match the captured sentence byte shape; a
      // simplified/bare value fails the whole tail closed rather than moving only
      // currentDate and silently changing the unsupported sibling's role.
      if (!isExactCapturedEmail(emailValue)) return undefined;
      const emailAt = projectStart + emailAtRelative;
      const beforeEmail = body.slice(projectStart, emailAt);
      const priorEmailAt = beforeEmail.lastIndexOf(emailMarker);
      if (
        priorEmailAt >= 0 &&
        isExactCapturedEmail(beforeEmail.slice(priorEmailAt + emailMarker.length))
      ) return undefined;
      runtimeStart = emailAt;
      fields.unshift({ name: 'userEmail', start: emailAt, end: currentAt });
    } else {
      // An earlier payload lookalike is harmless. A valid captured email sentence
      // followed by extra lines is instead a malformed adjacent sibling and makes
      // the runtime tail ambiguous.
      const firstLine = emailValue.slice(0, emailValue.indexOf('\n'));
      if (isExactCapturedEmail(firstLine)) return undefined;
    }
  }

  const priorCurrentAt = beforeCurrent.lastIndexOf(currentMarker);
  if (
    priorCurrentAt >= 0 &&
    isExactCapturedDate(beforeCurrent.slice(priorCurrentAt + currentMarker.length))
  ) return undefined;

  // Captured sibling keys use lowerCamelCase. Any UNRECOGNIZED lowerCamelCase H1
  // anywhere before the exact runtime suffix may be a new host sibling — and its
  // unescaped multiline value can hide behind a later payload-style heading
  // (reviewloop slice-3 r1), so checking only the last H1 is evadable. Refuse the
  // entire tail/project partition rather than image unknown host data as
  // governance. This subsumes the uncaptured optional `attachedProject` sibling
  // and may conservatively reject a payload that uses such a heading; it never
  // drops or elevates those bytes. The recognized keys stay payload-eligible
  // because their exact-valid duplicates are refused separately above.
  // The structural `# claudeMd` heading sits at position 0 of this slice with no
  // preceding newline in-slice, so the \n-anchored pattern skips it by design.
  const projectCandidate = body.slice(projectStart, runtimeStart);
  const h1Pattern = /\n# ([^\n]*)/g;
  let h1Match: RegExpExecArray | null;
  while ((h1Match = h1Pattern.exec(projectCandidate)) !== null) {
    const heading = h1Match[1]!;
    if (
      /^[a-z][A-Za-z0-9]*$/.test(heading) &&
      heading !== 'userEmail' &&
      heading !== 'currentDate'
    ) return undefined;
  }

  return {
    projectEnd: runtimeStart,
    runtimeStart,
    runtimeEnd: bodyEnd,
    fields,
  };
}

function runtimeSegment(text: string, parsed: ParsedTail): RuntimeMetadataSegment {
  const locator: TextSpanLocator = {
    messageIndex: 0,
    blockIndex: 0,
    start: parsed.runtimeStart,
    end: parsed.runtimeEnd,
  };
  return {
    kind: 'runtime_metadata',
    source: CLAUDE_CODE_2_1_205_RUNTIME_SOURCE,
    shape: 'opening_runtime_tail_v1',
    locator,
    text: text.slice(locator.start, locator.end),
    fields: parsed.fields.map((field) => ({
      name: field.name,
      locator: {
        messageIndex: 0,
        blockIndex: 0,
        start: field.start,
        end: field.end,
      },
      text: text.slice(field.start, field.end),
    })),
  };
}

export function partitionAnthropicContext(req: MessagesRequest): AnthropicContextPartition {
  const openingBlock = firstOpeningBlock(req);
  if (!openingBlock) return { runtimeMetadata: [], uncertain: [] };

  const text = openingBlock.text;
  const projectPrefix = CLAUDE_USER_CONTEXT_OPENER + CLAUDE_MD_HEADING + CLAUDE_MD_PREAMBLE;
  if (!text.startsWith(CLAUDE_USER_CONTEXT_OPENER)) {
    return { runtimeMetadata: [], uncertain: [] };
  }
  const openingCarrier: OpeningContextCarrier = {
    kind: 'opening_context_carrier',
    source: CLAUDE_CODE_2_1_205_SOURCE,
    locator: {
      messageIndex: 0,
      blockIndex: 0,
      start: 0,
      end: text.length,
    },
    text,
  };
  const projectStart = CLAUDE_USER_CONTEXT_OPENER.length;
  const parsedTail = parseCapturedTail(text, projectStart);
  const recognizedProjectShape = parsedTail !== undefined &&
    text.startsWith(projectPrefix) &&
    parsedTail.projectEnd > projectStart + CLAUDE_MD_HEADING.length + CLAUDE_MD_PREAMBLE.length;
  const recognizedNoGuidanceShape = parsedTail?.projectEnd === projectStart;
  const plainUnmarkedCarrier =
    openingBlock.cache_control === undefined &&
    Object.keys(openingBlock).every((key) => key === 'type' || key === 'text');
  const runtimeMetadata = parsedTail &&
      plainUnmarkedCarrier &&
      (recognizedProjectShape || recognizedNoGuidanceShape)
    ? [runtimeSegment(text, parsedTail)]
    : [];
  if (!text.startsWith(projectPrefix)) {
    return {
      openingCarrier,
      runtimeMetadata,
      uncertain: [{
        kind: 'uncertain',
        source: 'opening_user_context',
        messageIndex: 0,
        blockIndex: 0,
        reason: 'unsupported_or_missing_claude_md_section',
      }],
    };
  }

  if (!recognizedProjectShape || !parsedTail) {
    return {
      openingCarrier,
      runtimeMetadata,
      uncertain: [{
        kind: 'uncertain',
        source: 'opening_user_context',
        messageIndex: 0,
        blockIndex: 0,
        reason: 'unsupported_or_malformed_claude_context_tail',
      }],
    };
  }

  const locator: TextSpanLocator = {
    messageIndex: 0,
    blockIndex: 0,
    start: projectStart,
    end: parsedTail.projectEnd,
  };
  return {
    openingCarrier,
    projectGuidance: {
      kind: 'project_guidance',
      source: CLAUDE_CODE_2_1_205_SOURCE,
      locator,
      text: text.slice(locator.start, locator.end),
    },
    runtimeMetadata,
    uncertain: [],
  };
}

export function readTextSpan(req: MessagesRequest, locator: TextSpanLocator): string | undefined {
  const message = req.messages?.[locator.messageIndex];
  if (!message || !Array.isArray(message.content)) return undefined;
  const block = message.content[locator.blockIndex];
  if (!block || block.type !== 'text') return undefined;
  if (locator.start < 0 || locator.end < locator.start || locator.end > block.text.length) return undefined;
  return block.text.slice(locator.start, locator.end);
}

/** Clone only the request/message/content/text-block path containing a verified span. */
export function replaceTextSpan(
  req: MessagesRequest,
  locator: TextSpanLocator,
  expected: string,
  replacement: string,
): TextSpanReplacement | undefined {
  if (readTextSpan(req, locator) !== expected) return undefined;
  const message = req.messages[locator.messageIndex]!;
  if (!Array.isArray(message.content)) return undefined;
  const block = message.content[locator.blockIndex] as TextBlock;
  const nextBlock: TextBlock = {
    ...block,
    text: block.text.slice(0, locator.start) + replacement + block.text.slice(locator.end),
  };
  const nextContent = message.content.slice();
  nextContent[locator.blockIndex] = nextBlock;
  const nextMessages = req.messages.slice();
  nextMessages[locator.messageIndex] = { ...message, content: nextContent };
  return {
    request: { ...req, messages: nextMessages },
    locator: {
      ...locator,
      end: locator.start + replacement.length,
    },
  };
}
