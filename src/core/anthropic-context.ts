import type {
  ContentBlock,
  MessagesRequest,
  TextBlock,
} from './types.js';

/** Wire shape captured locally from Claude Code 2.1.205 (no upstream model call). */
export const CLAUDE_CODE_2_1_205_SOURCE = 'claude_code_2_1_205_opening_reminder' as const;

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
  readonly source: string;
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
  /** Reserved for Slice 3. Slice 1 deliberately does not move metadata. */
  readonly runtimeMetadata: readonly RuntimeMetadataSegment[];
  readonly uncertain: readonly UncertainContextSegment[];
}

export interface TextSpanReplacement {
  readonly request: MessagesRequest;
  /** Locator of the replacement bytes in the cloned request. */
  readonly locator: TextSpanLocator;
}

const CURRENT_DATE_LINE = /^Today's date is \d{4}-\d{2}-\d{2}\.$/;

function firstOpeningText(req: MessagesRequest): string | undefined {
  const first = req.messages?.[0];
  if (!first || first.role !== 'user' || !Array.isArray(first.content)) return undefined;
  // Captured host context is block zero and the live user carrier is a separate
  // following text block. Requiring both prevents ordinary single-block pastes
  // from becoming privileged merely because they imitate the wrapper.
  const block = first.content[0];
  const live = first.content[1];
  if (!block || block.type !== 'text' || !live || live.type !== 'text') return undefined;
  return block.text;
}

interface ParsedTail {
  projectEnd: number;
}

/**
 * Recognize only the captured sibling tail:
 *   [# userEmail + one line]\n# currentDate\nToday's date is YYYY-MM-DD.
 * followed by the fixed outer advisory/closer. Unknown siblings fail closed.
 *
 * Parsing is anchored from the end, so heading/trailer lookalikes inside the
 * unescaped CLAUDE/AGENTS payload remain part of the project bundle.
 */
function parseCapturedTail(text: string, projectStart: number): ParsedTail | undefined {
  if (!text.endsWith(CLAUDE_USER_CONTEXT_CLOSER)) return undefined;
  const bodyEnd = text.length - CLAUDE_USER_CONTEXT_CLOSER.length;
  const body = text.slice(0, bodyEnd);

  const currentMarker = '\n# currentDate\n';
  const currentAt = body.lastIndexOf(currentMarker);
  if (currentAt < projectStart) return undefined;
  const currentValue = body.slice(currentAt + currentMarker.length);
  if (!CURRENT_DATE_LINE.test(currentValue)) return undefined;

  let projectEnd = currentAt;
  const beforeCurrent = body.slice(projectStart, currentAt);
  const emailMarker = '\n# userEmail\n';
  const emailAtRelative = beforeCurrent.lastIndexOf(emailMarker);
  if (emailAtRelative >= 0) {
    const emailValue = beforeCurrent.slice(emailAtRelative + emailMarker.length);
    // Only a marker whose one-line value is immediately adjacent to currentDate
    // is the captured sibling. Earlier lookalikes remain project payload.
    if (emailValue && !emailValue.includes('\n') && !emailValue.startsWith('#')) {
      projectEnd = projectStart + emailAtRelative;
    }
  }

  // `attachedProject` is an optional 2.1.205 sibling but was not present in the
  // wire capture. Its value is unescaped/multiline, so v1 refuses the shape rather
  // than guessing an authority boundary. This may conservatively reject a payload
  // with the same heading; it never drops or elevates those bytes.
  if (body.slice(projectStart, currentAt).includes('\n# attachedProject\n')) return undefined;

  return { projectEnd };
}

export function partitionAnthropicContext(req: MessagesRequest): AnthropicContextPartition {
  const opening = firstOpeningText(req);
  if (!opening) return { runtimeMetadata: [], uncertain: [] };

  const text = opening;
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
  if (!text.startsWith(projectPrefix)) {
    return {
      openingCarrier,
      runtimeMetadata: [],
      uncertain: [{
        kind: 'uncertain',
        source: 'opening_user_context',
        messageIndex: 0,
        blockIndex: 0,
        reason: 'unsupported_or_missing_claude_md_section',
      }],
    };
  }

  const projectStart = CLAUDE_USER_CONTEXT_OPENER.length;
  const parsedTail = parseCapturedTail(text, projectStart);
  if (!parsedTail || parsedTail.projectEnd <= projectStart + CLAUDE_MD_HEADING.length + CLAUDE_MD_PREAMBLE.length) {
    return {
      openingCarrier,
      runtimeMetadata: [],
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
    runtimeMetadata: [],
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
