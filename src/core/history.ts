/**
 * History-image compression (Variant C).
 *
 * Collapses the largest closed-tool-sequence prefix into one synthetic user message
 * containing 1-N PNG image blocks. The live tail (keepTail turns + any open tool
 * sequence) stays as text. thinking blocks are dropped from the collapsed range —
 * only the most-recent assistant-with-tool_use must round-trip bit-perfect, and
 * that turn is in the live tail by construction.
 *
 * Synthesized message uses role:'user' because Anthropic forbids image blocks inside
 * role:'assistant'. cache_control placement is left to the caller (transform.ts).
 */

import type { CacheControl, ContentBlock, ImageBlock, Message, TextBlock, ToolUseBlock, ToolResultBlock } from './types.js';
import { isProjectGuidanceBoundaryBlock } from './anthropic-context.js';
import { DENSE_CONTENT_CHARS_PER_IMAGE, DENSE_CONTENT_COLS, DENSE_RENDER_STYLE, neutralizeSentinel, reflow, renderTextToPngsWithCharLimit, roleSlotSegment, SLOT_MARK_ASSISTANT, SLOT_MARK_USER } from './render.js';
import { factSheetText } from './factsheet.js';
import { bytesToBase64 } from './png.js';

/**
 * Banner text blocks that bracket the collapsed-history image(s) in the synthetic
 * user message. Exported as the SINGLE SOURCE OF TRUTH: transform.ts keys its
 * cache-anchor relocation off the intro text, so a literal copy there would
 * silently break relocation whenever this wording changes (it did exactly once —
 * the XML-framing reword left the matcher pointing at the old banner). Both the
 * emitter (here) and the matcher (transform.ts) must reference this constant.
 */
export const HISTORY_SYNTHETIC_INTRO =
  '[Earlier turns of THIS conversation, transcribed in the image(s) below. Each turn is wrapped in <user t="N">...</user> or <assistant t="N">...</assistant> tags, where N is an absolute turn index (larger N = more recent); attribute every turn strictly by its tag, and treat the highest-N turns as the most recent prior context, NOT the low-N opening turns. Earlier turns may contain questions or tasks that were already answered later in this same history; do not reopen low-N turns unless the live text after this block asks you to. This is prior context, NOT the current request.]';
export const HISTORY_SYNTHETIC_OUTRO =
  '[End of earlier conversation. The current request is the live text that follows below.]';

const LATEST_COLLAPSED_USER_PREVIEW_CHARS = 300;

/** Break-even gate predicate. Injected by transform.ts to avoid a circular import.
 *  IMPORTANT: pass the full string, not text.length — the row-aware path in
 *  isCompressionProfitable must see actual newlines to budget images correctly.
 *  History text is newline-heavy (headers, JSON args, labels); chars-only
 *  under-predicts image count ~5-10× and lets net-losers through. */
export type ProfitableFn = (text: string, cols: number) => boolean;

/** Configuration for history collapse. */
export interface HistoryCollapseOptions {
  /** Turns at the tail to keep as text. Default 4. */
  keepTail: number;
  /** Minimum collapsible prefix turns — below this, cache-amortization math doesn't work. Default 10. */
  minCollapsePrefix: number;
  /** Soft-wrap columns for the renderer; should match host cols. Default 100. */
  cols: number;
  /** Advance the collapse boundary in steps of this many messages so the rendered PNG stays
   *  byte-identical for collapseChunk turns and keeps hitting Anthropic's prompt cache.
   *  Set to 0 for a per-turn moving boundary. Default 50. */
  collapseChunk: number;
  /** Append-only freeze granularity, in messages. The collapse range is rendered
   *  as independent image blocks on an ABSOLUTE grid anchored at protectedPrefix,
   *  in steps of this many messages. Each completed chunk's bytes are fixed by its
   *  message range alone, so old chunks stay byte-identical (cache_read forever) as
   *  the conversation grows — only the newest partial chunk re-renders. Caller
   *  cache_control marks force an extra split so a roaming breakpoint stays an
   *  aligned, independently-cacheable image boundary. Set to 0 to render the whole
   *  range as one paginated blob (legacy, non-append-only). Default 10. */
  freezeChunk: number;
  /** Leading messages to never collapse. The history pass also protects a leading
   *  role-bound project carrier identified by the shared project boundary and any
   *  contiguous literal system-role attachments that immediately follow it. Default 0. */
  protectedPrefix: number;
  /** Exact project reference vouched for by the native manifest. Boundary-shaped
   *  user text is not trusted when this binding is absent or does not match. */
  protectedProjectRef?: string;
  /** Exact opening host-context carrier bytes vouched for by the partitioner.
   *  Available even when project rendering is disabled or fails its gate. */
  protectedOpeningCarrierText?: string;
  /** Internal fault-injection seam for lossless render-failure tests. */
  renderPages?: typeof renderTextToPngsWithCharLimit;
  /** Reflow the transcript before RENDERING: pack soft-wrapped lines and mark
   *  every hard newline with the ↵ sentinel — same treatment as the static slab.
   *  History text is newline-heavy (role headers, JSON args), so without this
   *  each short line wastes a full render row, inflating image count and shrinking
   *  the savings. Glyph size is unchanged (cols stays the same) so legibility is
   *  identical — it just removes the blank-row waste. `collapsedChars` still
   *  reports the ORIGINAL transcript length. Default true. */
  reflow: boolean;
}

export const HISTORY_DEFAULTS: HistoryCollapseOptions = {
  keepTail: 4,
  minCollapsePrefix: 10,
  cols: 100,
  collapseChunk: 50,
  freezeChunk: 10,
  protectedPrefix: 0,
  reflow: true,
};

/** Per-request telemetry surfaced back to TransformInfo. */
export interface HistoryCollapseInfo {
  /** Number of turns collapsed into the history image. */
  collapsedTurns: number;
  /** Total chars of text that went into the history image. */
  collapsedChars: number;
  /** Number of PNG image blocks emitted for the history (≥1 if collapsed). */
  collapsedImages: number;
  /** Total PNG bytes emitted. */
  collapsedImageBytes: number;
  /** Total pixel area (Σ width×height) — pairs with cache_create tokens for px/token regression. */
  collapsedImagePixels: number;
  /** Raw PNG bytes of each emitted history image, in order. Lets the caller register
   *  them into the dashboard image ring (info.imagePngs) so colored history frames are
   *  visible, not merely counted — every other image path already feeds the ring. */
  collapsedPngs: Uint8Array[];
  /** Per-image pixel dims, parallel to collapsedPngs. The dashboard ring reads
   *  info.imageDims in lockstep with info.imagePngs, so these must be pushed together. */
  collapsedImageDims: { width: number; height: number }[];
  /** Ordinal (0-based, into the emitted history images) of the last byte-stable
   *  history image — the carry-over cache anchor. The relocator pins the cache
   *  breakpoint here so it survives window advances (#11). Undefined when history is
   *  too short to have a fully grid-aligned chunk before collapseLen. */
  carryOverImageOrdinal?: number;
  /** Why we didn't collapse — populated only when no collapse happened. */
  reason?:
    | 'no_history'
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'privileged_role_in_collapse_range'
    | 'context_reminder_in_collapse_range'
    | 'ambiguous_cache_markers_in_collapse_range'
    | 'mid_message_cache_marker'
    | 'cache_marker_mismatch'
    | 'not_profitable'
    | 'render_empty'
    | 'render_error';
  /** Dropped codepoints from the history render, merged into the
   *  transform-wide map by the caller. */
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
}


/**
 * Return the last index ≤ cutoffExclusive at which all tool_use_ids are matched
 * by tool_results in [0..i]. Returns -1 if no closed boundary exists.
 * Robust to interleaved/parallel tool calls via openSet tracking.
 */
export function findClosedPrefixBoundary(
  messages: Message[],
  cutoffExclusive: number,
): number {
  if (cutoffExclusive <= 0) return -1;
  const openSet = new Set<string>();
  let lastClosed = -1;
  const limit = Math.min(cutoffExclusive, messages.length);
  for (let i = 0; i < limit; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) {
      if (openSet.size === 0) lastClosed = i; // plain string — no tool blocks
      continue;
    }
    if (msg.role === 'assistant') {
      for (const blk of msg.content) {
        if (blk && (blk as ToolUseBlock).type === 'tool_use') {
          const id = (blk as ToolUseBlock).id;
          if (typeof id === 'string') openSet.add(id);
        }
      }
    } else if (msg.role === 'user') {
      for (const blk of msg.content) {
        if (blk && (blk as ToolResultBlock).type === 'tool_result') {
          const id = (blk as ToolResultBlock).tool_use_id;
          if (typeof id === 'string') openSet.delete(id);
        }
      }
    }
    if (openSet.size === 0) lastClosed = i;
  }
  return lastClosed;
}

/**
 * Claude Code appends "(file state is current in your context — no need to Read it
 * back)" to Edit/Write tool_results. True when emitted; stale by the time the turn
 * reaches this serializer: everything blocksToText feeds becomes collapsed/imaged
 * HISTORY, the CLI's read-ledger resets on process restart, and the file may have
 * changed in later turns anyway. Models trusting the hint from prior turns were the
 * dominant cause of `File has not been read yet` gate errors (2026-07-03 audit,
 * n=55 classified: 20 had a same-transcript Read invalidated by a restart while
 * this hint said "current"; 34 edited from prior-session context with no Read at
 * all). Rewriting at serialization time also cleans slabs inherited by future
 * continuation sessions. Whitespace-tolerant match: 3 of ~2,125 logged instances
 * wrap mid-hint.
 */
const FRESHNESS_HINT_RE =
  /\(file state is current in your\s+context — no need to Read it back\)/g;
const STALE_FRESHNESS_NOTE =
  '(state as of this PRIOR turn — the file may have changed since; Read it again before editing)';

export function staleFreshnessHints(text: string): string {
  return text.replace(FRESHNESS_HINT_RE, STALE_FRESHNESS_NOTE);
}

/**
 * Linearise content blocks to a single string. Drops thinking blocks (only the
 * most-recent assistant turn needs bit-perfect thinking, and it's in the live tail).
 * Inline images collapse to [image] to avoid double-encoding.
 */
export function blocksToText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const blk of content) {
    if (!blk || typeof blk !== 'object') continue;
    const t = (blk as { type?: string }).type;
    switch (t) {
      case 'text':
        parts.push((blk as TextBlock).text);
        break;
      case 'tool_use': {
        const tu = blk as ToolUseBlock;
        // Compact JSON (no indent) — pretty-printing bloats text ~5× and the renderer is row-aware.
        let argsStr: string;
        try {
          argsStr = JSON.stringify(tu.input);
        } catch {
          argsStr = String(tu.input);
        }
        parts.push(`[tool_use ${tu.name}]\n${argsStr}`);
        break;
      }
      case 'tool_result': {
        const tr = blk as ToolResultBlock;
        const inner = tr.content;
        let innerText: string;
        if (typeof inner === 'string') {
          innerText = inner;
        } else if (Array.isArray(inner)) {
          const subParts: string[] = [];
          for (const sub of inner) {
            if (!sub || typeof sub !== 'object') continue;
            if ((sub as TextBlock).type === 'text') {
              subParts.push((sub as TextBlock).text);
            } else if ((sub as ImageBlock).type === 'image') {
              subParts.push('[image]');
            }
          }
          innerText = subParts.join('\n');
        } else {
          innerText = '';
        }
        const errMark = tr.is_error === true ? ' (error)' : '';
        parts.push(`[tool_result${errMark}]\n${staleFreshnessHints(innerText)}`);
        break;
      }
      case 'image':
        parts.push('[image]');
        break;
      // 'thinking' and any other block type → drop silently.
      default:
        break;
    }
  }
  return parts.join('\n\n');
}

/** Return every caller cache marker carried by a message, including markers on
 * nested tool_result parts. History collapse can preserve one marker per message;
 * multiple markers in one message are ambiguous and make that bucket fail closed. */
export function messageCacheControls(m: Message): CacheControl[] {
  if (!Array.isArray(m.content)) return [];
  const controls: CacheControl[] = [];
  for (const block of m.content) {
    const cc = (block as { cache_control?: CacheControl }).cache_control;
    if (cc !== undefined) controls.push(cc);
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (inner.cache_control !== undefined) controls.push(inner.cache_control);
      }
    }
  }
  return controls;
}

/** Return the one unambiguous caller marker on a message, if present. */
export function messageCacheControl(m: Message): CacheControl | undefined {
  const controls = messageCacheControls(m);
  return controls.length === 1 ? controls[0] : undefined;
}

/** True when every caller marker on the message sits at its final content
 * position: the last top-level block, or the last inner part of a last
 * tool_result. Collapse re-plants a marker at its chunk's END, so a marker
 * anywhere else would silently expand the caller's breakpoint scope across the
 * message's later content — such messages fail the history bucket closed. */
export function messageCacheControlAtEnd(m: Message): boolean {
  if (!Array.isArray(m.content) || m.content.length === 0) return true;
  const last = m.content[m.content.length - 1]!;
  for (const block of m.content) {
    const cc = (block as { cache_control?: CacheControl }).cache_control;
    if (cc !== undefined && block !== last) return false;
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      const innerLast = block.content[block.content.length - 1];
      for (const inner of block.content) {
        if (inner.cache_control !== undefined && (block !== last || inner !== innerLast)) {
          return false;
        }
      }
    }
  }
  return true;
}

function sameCacheControls(
  before: readonly CacheControl[],
  after: readonly CacheControl[],
): boolean {
  const signature = (cc: CacheControl): string => `${cc.type}\u0000${cc.ttl ?? ''}`;
  const a = before.map(signature).sort();
  const b = after.map(signature).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Serialize messages [fromInclusive..upToExclusive) to a text blob with
 *  `<role>…</role>` XML wrappers. Open+close tags bracket each turn so a misread
 *  boundary self-corrects and the model attributes speakers reliably even off a
 *  lossy image — bare `--- role ---` start-dividers let one role bleed into the
 *  next when a divider is missed. */
export function messagesToHistoryText(
  messages: Message[],
  upToExclusive: number,
  fromInclusive = 0,
): string {
  return messagesToHistorySegments(messages, upToExclusive, fromInclusive).text;
}

/** Like {@link messagesToHistoryText} but also returns the parallel slot string for
 *  colorByRole: a width-identical copy where each `<role>` tag is replaced by its
 *  role marker and the body is copied verbatim (slot 0). Role attribution is decided
 *  HERE, where the message role is known — never re-parsed out of flattened text.
 *  A tool_result block sits inside its user message and a tool_use block inside its
 *  assistant message, so each is owned by the turn that carries it. */
export function messagesToHistorySegments(
  messages: Message[],
  upToExclusive: number,
  fromInclusive = 0,
): { text: string; slotText: string } {
  const textOut: string[] = [];
  const slotOut: string[] = [];
  for (let i = fromInclusive; i < upToExclusive; i++) {
    const m = messages[i]!;
    if (m.role === 'system') {
      // collapseHistory detects this before serialization and returns the original
      // request. Keep this lower-level guard too: an exported helper must never
      // silently relabel a privileged role as user when called directly.
      throw new Error('Cannot serialize a system-role message into user-role history');
    }
    const body = blocksToText(m.content);
    if (!body.trim()) continue;
    const isAssistant = m.role === 'assistant';
    const tag = isAssistant ? 'assistant' : 'user';
    const mark = isAssistant ? SLOT_MARK_ASSISTANT : SLOT_MARK_USER;
    // Absolute turn index = message position from conversation start. Gives the model an
    // explicit recency anchor so it can tell turn 1 from turn 60, instead of pattern-matching
    // the most salient turn — primacy was resurrecting the OPENING turn as if it were the live
    // request. MUST stay absolute (never "N ago" or "i/total"): a per-turn value that's stable
    // once the turn closes keeps each frozen chunk byte-identical, so cache_read survives.
    const attr = ` t="${i}"`;
    textOut.push(`<${tag}${attr}>\n${body}\n</${tag}>`);
    slotOut.push(roleSlotSegment(tag, body, mark, attr));
  }
  return { text: textOut.join('\n\n'), slotText: slotOut.join('\n\n') };
}

function compactPreview(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= LATEST_COLLAPSED_USER_PREVIEW_CHARS) return compact;
  return compact.slice(0, LATEST_COLLAPSED_USER_PREVIEW_CHARS).trimEnd() + '...';
}

// User-typed words must never survive ONLY as a truncated preview (#7: the EC demo's
// 577-char task lost its questions and "Reply as:" format at the 300-char preview cap,
// because no later turn restated them). Task-defining text is carried verbatim up to
// this cap; beyond it, head+tail elision keeps both the setup AND the trailing output
// format, which real prompts put at the end.
const LATEST_COLLAPSED_USER_VERBATIM_CHARS = 4000;
const VERBATIM_HEAD_CHARS = 2600;
const VERBATIM_TAIL_CHARS = 1400;

function verbatimTaskText(text: string): string {
  const t = text.trim();
  if (t.length <= LATEST_COLLAPSED_USER_VERBATIM_CHARS) return t;
  const elided = t.length - VERBATIM_HEAD_CHARS - VERBATIM_TAIL_CHARS;
  return (
    t.slice(0, VERBATIM_HEAD_CHARS) +
    `\n[… middle elided (${elided} chars) …]\n` +
    t.slice(t.length - VERBATIM_TAIL_CHARS)
  );
}

function isSystemReminderLike(text: string): boolean {
  return text.trimStart().startsWith('<system-reminder>');
}

function messageContainsSystemReminder(message: Message): boolean {
  if (typeof message.content === 'string') return isSystemReminderLike(message.content);
  return message.content.some(
    (block) => block.type === 'text' && isSystemReminderLike(block.text),
  );
}

/**
 * The user's typed words in a user message: text blocks only, excluding
 * <system-reminder> wrappers and (in the opening project carrier) everything at or
 * before the shared project-guidance boundary — same rule as
 * demoteProtectedHeadText, so pxpipe scaffolding is never mistaken for the task.
 */
function typedUserText(
  content: string | ContentBlock[],
  protectedProjectRef?: string,
  protectedOpeningCarrierText?: string,
): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const boundaryIdx = content.findIndex(
    (b) =>
      b && typeof b === 'object' &&
      (b as { type?: string }).type === 'text' &&
      protectedProjectRef !== undefined &&
      isProjectGuidanceBoundaryBlock(b as ContentBlock, protectedProjectRef),
  );
  const parts: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (boundaryIdx >= 0 && i <= boundaryIdx) continue;
    const blk = content[i];
    if (!blk || typeof blk !== 'object') continue;
    if ((blk as { type?: string }).type !== 'text') continue;
    const text = (blk as TextBlock).text.trim();
    if (!text) continue;
    if (protectedOpeningCarrierText !== undefined && (blk as TextBlock).text === protectedOpeningCarrierText) continue;
    if (text.startsWith('<system-reminder>')) continue;
    parts.push(text);
  }
  return parts.join('\n\n');
}

/**
 * Demote request TEXT in the protected head (project-page anchor) to a marked
 * PRIOR-CONTEXT tombstone. The session's OPENING user turn rides in the SAME message
 * as the project pages (the shared boundary keeps that message
 * from collapsing into [image] placeholders). Protecting it for the cache anchor also
 * passed its request text through as clean native text at the very TOP — ahead of the
 * synthetic history block — where the model reads it as the LIVE request. It never is:
 * the live request is always in the tail (tail = messages.slice(collapseLen),
 * keepTail >= 1), so any text in the protected head is, by construction, stale.
 *
 * Image/tool blocks pass through byte-identical so the cache anchor and any
 * cache_control breakpoint survive; the demotion is a pure function of the message, so
 * the protected prefix stays byte-stable across turns (one-time re-cache on deploy).
 */
function demoteProtectedHeadText(
  head: Message[],
  protectedProjectRef?: string,
  protectedOpeningCarrierText?: string,
): Message[] {
  return head.map((m, idx) => {
    if (m.role !== 'user') return m;
    // Same rule as latestCollapsedUserPointer: the vouched boundary/carrier exist
    // only at absolute index 0. A copied boundary in a later protected-head user
    // message must not shield the text around it from demotion.
    const projectRef = idx === 0 ? protectedProjectRef : undefined;
    const carrierText = idx === 0 ? protectedOpeningCarrierText : undefined;
    const tomb = (preview: string, cc?: CacheControl): TextBlock => {
      const t: TextBlock = {
        type: 'text',
        text:
          `[Opening turn <user t="${idx}"> of this session — PRIOR CONTEXT ONLY, ` +
          `superseded by later turns; NOT the current request and must not be acted ` +
          `on. Preview: "${preview}"]`,
      };
      if (cc !== undefined) {
        (t as TextBlock & { cache_control?: CacheControl }).cache_control = cc;
      }
      return t;
    };
    if (typeof m.content === 'string') {
      const preview = compactPreview(m.content);
      return preview ? { ...m, content: [tomb(preview)] } : m;
    }
    if (!Array.isArray(m.content)) return m;
    // pxpipe's role-bound project pages and their shared boundary are NOT the user's
    // request and must survive byte-identical. The reconstructed host reminder after
    // the boundary is also native host context, so preserve it; only stale user text
    // after that reminder gets demoted. With no boundary, the whole message demotes,
    // exactly as before.
    const boundaryIdx = m.content.findIndex(
      (b) =>
        b && typeof b === 'object' &&
        (b as { type?: string }).type === 'text' &&
        projectRef !== undefined &&
        isProjectGuidanceBoundaryBlock(b as ContentBlock, projectRef),
    );
    const candidateCarrierIdx = boundaryIdx >= 0 ? boundaryIdx + 1 : 0;
    const candidateCarrier = m.content[candidateCarrierIdx];
    const openingCarrierIdx =
      carrierText !== undefined &&
      candidateCarrier?.type === 'text' &&
      candidateCarrier.text === carrierText
        ? candidateCarrierIdx
        : -1;
    let changed = false;
    const out: ContentBlock[] = [];
    for (let i = 0; i < m.content.length; i++) {
      const blk = m.content[i]!;
      if (boundaryIdx >= 0 && i <= boundaryIdx) {
        out.push(blk); // project pages + boundary: role-bound scaffolding, kept verbatim
        continue;
      }
      if (blk && typeof blk === 'object' && (blk as { type?: string }).type === 'text') {
        const originalText = (blk as TextBlock).text;
        if (i === openingCarrierIdx) {
          out.push(blk); // exact partitioner-bound host context stays byte- and marker-exact
          continue;
        }
        if (isSystemReminderLike(originalText)) {
          out.push(blk); // unknown reminder stays native user-role text; it gains no authority
          continue;
        }
        const preview = compactPreview(originalText);
        if (preview) {
          out.push(tomb(preview, (blk as { cache_control?: CacheControl }).cache_control));
          changed = true;
          continue;
        }
      }
      out.push(blk); // images / tool blocks (slab anchor) pass through byte-identical
    }
    return changed ? { ...m, content: out } : m;
  });
}

/**
 * Protect the vouched-for leading project carrier and the captured sequence of
 * literal mid-conversation system attachments that immediately follows it.
 * A marker elsewhere is not authority-bearing and cannot expand the head.
 */
function roleBoundProtectedPrefix(
  messages: Message[],
  requestedPrefix: number,
  protectedProjectRef?: string,
  protectedOpeningCarrierText?: string,
): number {
  const first = messages[0];
  let hasBoundCarrier = false;
  if (
    protectedOpeningCarrierText !== undefined &&
    first?.role === 'user' &&
    Array.isArray(first.content)
  ) {
    const boundaryIdx = protectedProjectRef === undefined
      ? -1
      : first.content.findIndex((block) =>
          isProjectGuidanceBoundaryBlock(block, protectedProjectRef));
    const expectedCarrierIdx = boundaryIdx >= 0 ? boundaryIdx + 1 : 0;
    const carrier = first.content[expectedCarrierIdx];
    hasBoundCarrier = carrier?.type === 'text' && carrier.text === protectedOpeningCarrierText;
  }
  if (!hasBoundCarrier) return requestedPrefix;

  // System attachments extend only the exact opening carrier, never an arbitrary
  // caller-supplied prefix or a boundary-shaped marker with a different ref.
  let roleBoundEnd = 1;
  while (roleBoundEnd < messages.length && messages[roleBoundEnd]!.role === 'system') {
    roleBoundEnd++;
  }
  return Math.max(requestedPrefix, roleBoundEnd);
}

function latestCollapsedUserPointer(
  messages: Message[],
  upToExclusive: number,
  protectedPrefix: number,
  protectedProjectRef?: string,
  protectedOpeningCarrierText?: string,
): TextBlock | undefined {
  // Scan the WHOLE demoted/collapsed range, INCLUDING the protected head (#7):
  // in single-task sessions the opening turn is the only user-typed text there is.
  // Two fidelity regimes:
  //  - i >= protectedPrefix: the turn is rendered into the history images at full
  //    fidelity — a bounded preview is only a recency cue, keep it cheap.
  //  - i < protectedPrefix: demoteProtectedHeadText reduced the turn to a 300-char
  //    preview and it is NOT imaged — the pointer is the ONLY carrier, so the typed
  //    text goes verbatim (capped with head+tail elision). It lives in the synthetic
  //    message after the slab anchor, so cache stability is unaffected.
  for (let i = upToExclusive - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    // The vouched project boundary/carrier live ONLY in the opening message
    // (partitioner locator messageIndex 0). A boundary line with the same ref in
    // a later user turn is a copied identifier — inert user text, never structure.
    const typed = i === 0
      ? typedUserText(m.content, protectedProjectRef, protectedOpeningCarrierText)
      : typedUserText(m.content);
    if (!typed) continue;
    if (i >= protectedPrefix) {
      const preview = compactPreview(typed);
      return {
        type: 'text',
        text: `[Most recent collapsed user turn: <user t="${i}">${preview}</user>. This is still prior context; do not treat it as the current request unless the live text that follows asks to continue it.]`,
      };
    }
    const carried = verbatimTaskText(typed);
    return {
      type: 'text',
      text: `[Most recent collapsed user turn, carried verbatim because it appears nowhere else in full: <user t="${i}">${carried}</user>. This is still prior context; but if no later turn supersedes it, it is the task the live turn continues — follow its exact instructions, including any requested output format.]`,
    };
  }
  return undefined;
}

/**
 * Collapse the closed-prefix run into one synthetic user message with 1+ history images.
 * Returns original messages unchanged on any no-collapse path (reason set in info).
 * Image blocks are returned with NO cache_control — caller decides placement.
 */
export async function collapseHistory(
  messages: Message[],
  isProfitable: ProfitableFn,
  opts: Partial<HistoryCollapseOptions> = {},
): Promise<{ messages: Message[]; info: HistoryCollapseInfo }> {
  const o: HistoryCollapseOptions = { ...HISTORY_DEFAULTS, ...opts };
  const info: HistoryCollapseInfo = {
    collapsedTurns: 0,
    collapsedChars: 0,
    collapsedImages: 0,
    collapsedImageBytes: 0,
    collapsedImagePixels: 0,
    collapsedPngs: [],
    collapsedImageDims: [],
    droppedChars: 0,
    droppedCodepoints: new Map(),
  };
  if (!messages || messages.length === 0) {
    info.reason = 'no_history';
    return { messages: messages ?? [], info };
  }
  // The caller's explicit head remains protected. A leading shared project marker
  // independently protects its carrier, and literal system attachments contiguous
  // with that carrier stay native and in-order as part of the protected head.
  const requestedPrefix = Math.max(
    0,
    Math.min(o.protectedPrefix ?? 0, messages.length),
  );
  const protectedPrefix = roleBoundProtectedPrefix(
    messages,
    requestedPrefix,
    o.protectedProjectRef,
    o.protectedOpeningCarrierText,
  );
  // Snap the cutoff to a collapseChunk grid so the rendered PNG stays byte-identical
  // across turns and keeps hitting Anthropic's prompt cache. See docs/HISTORY_CACHE_MODEL.md.
  // Floor at minCollapsePrefix + protectedPrefix so short histories still collapse.
  const rawCutoff = messages.length - o.keepTail;
  const cutoff =
    o.collapseChunk > 0
      ? Math.min(
          rawCutoff,
          Math.max(
            o.minCollapsePrefix + protectedPrefix,
            Math.floor(rawCutoff / o.collapseChunk) * o.collapseChunk,
          ),
        )
      : rawCutoff;
  const boundary = findClosedPrefixBoundary(messages, cutoff);
  if (boundary < 0) {
    info.reason = 'no_closed_prefix';
    return { messages, info };
  }
  // Need at least minCollapsePrefix turns in [protectedPrefix..boundary] — collapsing
  // 2-3 turns is net cost (cache-amortization math doesn't work at small scale).
  const collapseLen = boundary + 1;
  if (collapseLen - protectedPrefix < o.minCollapsePrefix) {
    info.reason = 'prefix_too_short';
    return { messages, info };
  }
  // A system role outside the contiguous protected head is an unsupported
  // privileged attachment. Fail this collapse closed rather than mapping it to
  // `<user>` in the rendered transcript and changing its API authority.
  if (messages.slice(protectedPrefix, collapseLen).some((message) => message.role === 'system')) {
    info.reason = 'privileged_role_in_collapse_range';
    return { messages, info };
  }
  if (messages.slice(protectedPrefix, collapseLen).some(messageContainsSystemReminder)) {
    info.reason = 'context_reminder_in_collapse_range';
    return { messages, info };
  }
  const collapseRange = messages.slice(protectedPrefix, collapseLen);
  if (collapseRange.some((message) => messageCacheControls(message).length > 1)) {
    info.reason = 'ambiguous_cache_markers_in_collapse_range';
    return { messages, info };
  }
  // A single marker NOT at its message's end cannot be re-planted without
  // expanding the caller's breakpoint across the message's later content
  // (reviewloop slice-2 r2). Position it cannot honor → fail closed.
  if (collapseRange.some((message) => !messageCacheControlAtEnd(message))) {
    info.reason = 'mid_message_cache_marker';
    return { messages, info };
  }
  const sourceCacheControls = collapseRange.flatMap(messageCacheControls);
  // Exclude the role-bound protected head from serialization.
  const text = messagesToHistoryText(messages, collapseLen, protectedPrefix);
  if (!text || text.length === 0) {
    info.reason = 'render_empty';
    return { messages, info };
  }
  // Reflow for RENDERING ONLY: pack short lines + mark hard breaks with ↵ so the
  // newline-heavy transcript fills full rows instead of one line per row. Same
  // glyph size (cols unchanged) → identical legibility, fewer images, more saved.
  // `text` stays original — it backs `collapsedChars` and the cache byte-stability.
  const safeText = neutralizeSentinel(text);
  const renderText = o.reflow ? reflow(safeText) ?? safeText : text;
  if (!isProfitable(renderText, o.cols)) { // pass string, not length — see ProfitableFn
    info.reason = 'not_profitable';
    info.collapsedChars = text.length; // surface what we DIDN'T compress
    return { messages, info };
  }
  // APPEND-ONLY rendering. Render the collapse range [protectedPrefix..collapseLen)
  // as independent image blocks on an ABSOLUTE message grid anchored at
  // protectedPrefix (step = freezeChunk). A completed chunk's bytes are fixed by
  // its message range alone, so old chunks stay byte-identical as the conversation
  // grows (cache_read forever); only the newest partial chunk re-renders.
  //
  // Chunk-end positions = the absolute grid ∪ caller cache_control marks: a marked
  // message forces a split right after it, and that chunk's LAST image carries the
  // caller's marker — so a roaming breakpoint survives as an aligned, independently
  // cacheable image boundary instead of being silently flattened (count conserved,
  // never added). Each chunk is reflowed and rendered on its own, which is what
  // makes the bytes a pure function of the chunk's messages.
  const step = o.freezeChunk > 0 ? o.freezeChunk : collapseLen - protectedPrefix;
  const ends = new Set<number>();
  for (let e = protectedPrefix + step; e < collapseLen; e += step) ends.add(e);
  const markerByEnd = new Map<number, CacheControl>();
  for (let i = protectedPrefix; i < collapseLen; i++) {
    const cc = messageCacheControl(messages[i]!);
    if (cc !== undefined) {
      ends.add(i + 1);
      markerByEnd.set(i + 1, cc);
    }
  }
  ends.add(collapseLen);
  const sortedEnds = [...ends].filter((e) => e > protectedPrefix && e <= collapseLen).sort((a, b) => a - b);

  // Carry-over anchor end: the largest FULLY grid-aligned chunk boundary strictly
  // before collapseLen. That chunk's bytes are frozen across window advances, unlike
  // the newest partial chunk — so it's the stable place to pin the cache breakpoint (#11).
  let carryOverEnd = -1;
  for (let e = protectedPrefix + step; e < collapseLen; e += step) carryOverEnd = e;
  let carryOverOrdinal = -1;

  const imageBlocks: Array<ImageBlock & { cache_control?: CacheControl }> = [];
  let chunkStart = protectedPrefix;
  for (const chunkEnd of sortedEnds) {
    const seg = messagesToHistorySegments(messages, chunkEnd, chunkStart);
    chunkStart = chunkEnd;
    if (!seg.text || seg.text.length === 0) continue;
    // Reflow the text and its parallel slot string in lockstep so role attribution
    // stays codepoint-aligned with the rendered text. The two have identical newline
    // structure (slot bodies are verbatim copies), so minify/reflow mutate them the
    // same way; reflow() only bails on a ↵ collision, which hits both identically.
    let chunkRender = seg.text;
    let chunkSlot = seg.slotText;
    if (o.reflow) {
      // Neutralize pre-existing ↵ first (1:1 swap at identical positions in text+slot, so
      // they stay codepoint-aligned) — otherwise reflow bails and the chunk renders raw,
      // unpacked. This conversation's transcript literally contains ↵, which would defeat
      // packing on exactly the long sessions where collapse matters most.
      const safeText = neutralizeSentinel(seg.text);
      const safeSlot = neutralizeSentinel(seg.slotText);
      const rt = reflow(safeText);
      const rs = reflow(safeSlot);
      if (rt !== null && rs !== null) {
        chunkRender = rt;
        chunkSlot = rs;
      } else {
        chunkRender = safeText;
        chunkSlot = safeSlot;
      }
    }
    // Use the dense readable profile (not full-canvas) to keep code/config legible.
    // colorByRole tints the structural <role> tags so turn boundaries are scannable
    // in the history image; it's token-free (vision cost is by pixel dims, not PNG
    // byte depth) and carries the serialize-time slot string instead of re-parsing.
    let imgs;
    try {
      imgs = await (o.renderPages ?? renderTextToPngsWithCharLimit)(
        chunkRender,
        DENSE_CONTENT_COLS,
        DENSE_CONTENT_CHARS_PER_IMAGE,
        { ...DENSE_RENDER_STYLE, colorByRole: true },
        undefined,
        chunkSlot,
      );
    } catch {
      info.reason = 'render_error';
      info.collapsedImageBytes = 0;
      info.collapsedImagePixels = 0;
      info.collapsedPngs = [];
      info.collapsedImageDims = [];
      info.droppedChars = 0;
      info.droppedCodepoints = new Map();
      return { messages, info };
    }
    const markerCC = markerByEnd.get(chunkEnd);
    for (let k = 0; k < imgs.length; k++) {
      const img = imgs[k]!;
      const block: ImageBlock & { cache_control?: CacheControl } = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: bytesToBase64(img.png),
        },
      };
      // Mark the LAST image of a marked segment — the caller's breakpoint anchor.
      if (markerCC !== undefined && k === imgs.length - 1) block.cache_control = markerCC;
      imageBlocks.push(block);
      info.collapsedImageBytes += img.png.length;
      info.collapsedImagePixels += img.width * img.height;
      info.collapsedPngs.push(img.png);
      info.collapsedImageDims.push({ width: img.width, height: img.height });
      info.droppedChars += img.droppedChars;
      for (const [cp, n] of img.droppedCodepoints) {
        info.droppedCodepoints.set(cp, (info.droppedCodepoints.get(cp) ?? 0) + n);
      }
    }
    // The carry-over chunk's LAST image is the newest byte-stable history image.
    // Record its ordinal so the relocator pins the cache breakpoint here instead of
    // on the still-growing newest chunk, which busts every window advance (#11).
    if (chunkEnd === carryOverEnd) carryOverOrdinal = imageBlocks.length - 1;
  }
  const renderedCacheControls = imageBlocks.flatMap((block) =>
    block.cache_control === undefined ? [] : [block.cache_control]);
  if (!sameCacheControls(sourceCacheControls, renderedCacheControls)) {
    info.reason = 'cache_marker_mismatch';
    info.collapsedImageBytes = 0;
    info.collapsedImagePixels = 0;
    info.collapsedPngs = [];
    info.collapsedImageDims = [];
    info.droppedChars = 0;
    info.droppedCodepoints = new Map();
    return { messages, info };
  }
  if (imageBlocks.length === 0) {
    info.reason = 'render_empty';
    return { messages, info };
  }
  const latestUserPointer = latestCollapsedUserPointer(
    messages,
    collapseLen,
    protectedPrefix,
    o.protectedProjectRef,
    o.protectedOpeningCarrierText,
  );
  const historyFactSheet = factSheetText(text);
  const syntheticContent: ContentBlock[] = [
    { type: 'text', text: HISTORY_SYNTHETIC_INTRO },
    ...imageBlocks,
    ...(latestUserPointer ? [latestUserPointer] : []),
    ...(historyFactSheet ? [{ type: 'text' as const, text: historyFactSheet }] : []),
    { type: 'text', text: HISTORY_SYNTHETIC_OUTRO },
  ];
  const syntheticUser: Message = {
    role: 'user',
    content: syntheticContent,
  };
  // Demote stale request text in the protected head so the session's opening turn
  // can't surface as clean native text ahead of the history image and read as live.
  const head = demoteProtectedHeadText(
    messages.slice(0, protectedPrefix),
    o.protectedProjectRef,
    o.protectedOpeningCarrierText,
  );
  const tail = messages.slice(collapseLen);
  info.collapsedTurns = collapseLen - protectedPrefix;
  info.collapsedChars = text.length;
  info.collapsedImages = imageBlocks.length;
  if (carryOverOrdinal >= 0) info.carryOverImageOrdinal = carryOverOrdinal;
  // [protected role-bound head, history image, live tail].
  return { messages: [...head, syntheticUser, ...tail], info };
}
