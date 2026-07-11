/**
 * Provenance-safe Anthropic request transformer. Native system content and tools
 * remain in their API roles; independently gated project guidance, tool results,
 * and closed history prefixes may be rendered as PNG pages.
 */

import type {
  ContentBlock,
  ImageBlock,
  Message,
  MessagesRequest,
  TextBlock,
  ToolDef,
  ToolResultBlock,
  ToolUseBlock,
} from './types.js';
import {
  renderTextToPngsMultiCol,
  reflow,
  maxFittingCols,
  shrinkColsToContent,
  MAX_HEIGHT_PX,
  NL_SENTINEL,
  neutralizeSentinel,
  PAD_X,
  PAD_Y,
  CELL_W,
  CELL_H,
  READABLE_CHARS_PER_IMAGE,
  DENSE_CONTENT_CHARS_PER_IMAGE,
  DENSE_CONTENT_COLS,
  DENSE_RENDER_STYLE,
  ANTHROPIC_SLAB_COLS,
  renderTextToPngsExact,
  renderTextToPngsWithCharLimit,
} from './render.js';
import { factSheetText } from './factsheet.js';
import { bytesToBase64 } from './png.js';
import { collapseHistory, HISTORY_SYNTHETIC_INTRO } from './history.js';
import {
  CLAUDE_USER_CONTEXT_CLOSER,
  isProjectGuidanceBoundaryBlock,
  makeProjectGuidanceBoundary,
  partitionAnthropicContext,
  readTextSpan,
  replaceTextSpan,
  type AnthropicContextPartition,
  type RuntimeMetadataSegment,
} from './anthropic-context.js';
import type { GptHistoryOptions } from './openai-history.js';
import { CACHE_CREATE_RATE, CACHE_READ_RATE } from './baseline.js';
import { schemaHasStructure, stripSchemaDescriptions } from './schema-strip.js';
import {
  applyAnthropicExactImageReplacements,
  type AnthropicChangedSpanLocation,
  type AnthropicExactImageOperation,
} from './anthropic-exact.js';
import type { ExactSpanImageReplacement } from './no-hijack.js';

/** Per-block descriptor passed to `TransformOptions.keepSharp`. */
export interface KeepSharpBlock {
  /** Which live-region path is asking: `reminder`, `tool_result`, or `tool_result_part`. */
  readonly kind: 'reminder' | 'tool_result' | 'tool_result_part';
  /** The block's text exactly as the caller produced it (pre-render, pre-compaction). */
  readonly text: string;
  /** `tool_use_id` of the owning tool_result, when applicable. */
  readonly toolUseId?: string;
}

/** A block pxpipe rendered to image(s), returned in `TransformInfo.recoverable`
 *  when the caller sets `emitRecoverable`. Lets a stateful harness restore
 *  byte-exact content if the model needs the imaged region verbatim. */
export interface RecoverableBlock {
  /** `rec_` + 8 hex SHA-256 over kind + toolUseId + original text. */
  readonly id: string;
  readonly kind: 'reminder' | 'tool_result' | 'tool_result_part';
  readonly toolUseId?: string;
  /** Original text before compaction/reflow/paging — the bytes to restore. */
  readonly text: string;
  readonly imageCount: number;
}

export interface TransformOptions {
  /** Master switch — false makes this a no-op pass-through. */
  compress?: boolean;
  /** Compress recognized Claude Code project guidance in its captured user-context role. */
  compressProjectGuidance?: boolean;
  /** Legacy source-compatible control. Shipped safe transforms keep tool
   *  definitions native; this option cannot reactivate cross-role imaging. */
  compressTools?: boolean;
  /** Legacy compatibility option; current Anthropic orchestration does not
   *  image generic reminders. */
  compressReminders?: boolean;
  /** Compress large tool_result text content across all user messages. */
  compressToolResults?: boolean;
  /** Don't compress if total compressible chars below this. */
  minCompressChars?: number;
  /** Legacy compatibility threshold; unused by current Anthropic orchestration. */
  minReminderChars?: number;
  /** Per-block threshold for compressToolResults (chars). */
  minToolResultChars?: number;
  /** Soft-wrap column count. */
  cols?: number;
  /** Hard upper bound on images per tool_result; source text truncated with a paging
   *  marker above this to stay under Anthropic's 100-image/request cap. Default 10. */
  maxImagesPerToolResult?: number;
  /** Pack N text columns side-by-side per image. Default 1. Auto-clamped to stay
   *  under 2000 px wide. OCR ordering risk at N≥2: model must read col 1 top-to-bottom
   *  before col 2. */
  multiCol?: number;
  /** Chars-per-token assumption for `isCompressionProfitable()`. Default 4. */
  charsPerToken?: number;
  /** Multi-turn amortization horizon for the history-collapse gate. N≥2 evaluates as
   *  if N future turns share the prefix (worst-case-warm-image vs best-case-warm-text).
   *  Default 1 (per-turn cold gate). See docs/HISTORY_CACHE_MODEL.md. */
  historyAmortizationHorizon?: number;
  /** Tokens the un-rewritten path would have cache-hit on. Adds a one-time burn
   *  penalty `priorWarmTokens × (CC − CR)` to the image side so the gate accounts
   *  for invalidating a warm text cache. Default 0 (cold-start). ≤0 clamped to 0. */
  priorWarmTokens?: number;
  /** Symmetric counterpart: tokens the image path would have cache-hit on. Adds the
   *  same burn formula to the TEXT side, preventing the gate from flipping out of
   *  image mode when the image prefix is already warm. Default 0. ≤0 clamped to 0. */
  priorWarmImageTokens?: number;
  /** Legacy source-compatible GPT control. Shipped OpenAI transforms ignore it
   *  and keep all history byte-exact native. */
  collapseHistory?: boolean;
  /** Legacy GPT history tuning; ignored by shipped OpenAI transforms. */
  gptHistory?: Partial<GptHistoryOptions>;
  /** Re-pack image-bound text into a ↵-delimited stream to fill `cols` (~29%→75-80%
   *  glyph-fill). ON by default (98.95% char accuracy at L1 OCR eval, +1pp vs baseline).
   *  Hard newlines become visible ↵ glyphs — tell the model via system prompt. */
  reflow?: boolean;
  /** Caller fidelity hint: return `true` for a block that must stay as text (IDs,
   *  hashes, file paths — content where mis-OCR would be silent and wrong). Only
   *  consulted on per-block live-region paths (reminders, tool_results). A throwing
   *  or non-boolean return is treated as `false`. */
  keepSharp?: (block: KeepSharpBlock) => boolean;
  /** When true, populate `TransformInfo.recoverable` with original text + provenance
   *  for every block rendered to images. Off by default (entries inflate `info`;
   *  only a stateful harness can use them). */
  emitRecoverable?: boolean;
}

const DEFAULTS: Required<TransformOptions> = {
  compress: true,
  compressProjectGuidance: true,
  compressTools: false,
  compressReminders: false,
  compressToolResults: true,
  minCompressChars: 2000,
  // Below ~6k chars, per-image cost dominates savings (break-even territory).
  minReminderChars: 6000,
  minToolResultChars: 6000,
  // system field rejects images (400 system.N.type: Input should be 'text') —
  // images always go into the first user message.
  // 312 cols × 5 px + 8 px pad = 1568 px (Anthropic no-resize edge).
  cols: ANTHROPIC_SLAB_COLS,
  maxImagesPerToolResult: 10,
  charsPerToken: 4,
  historyAmortizationHorizon: 1,
  priorWarmTokens: 0,
  priorWarmImageTokens: 0,
  // Multi-col off: single-col slab already holds ~50k chars; extra OCR risk not worth it.
  multiCol: 1,
  reflow: true,
  keepSharp: () => false,
  emitRecoverable: false,
  // GPT-only knobs; the Anthropic transform ignores them but Required<> needs them.
  collapseHistory: true,
  gptHistory: {},
};

// --- per-block break-even check ---
//
// Image token cost is computed from pixel area (Anthropic formula: w×h/750,
// empirically accurate to ~5% on dense PNGs). Constants bias CONSERVATIVE:
// CHARS_PER_TOKEN=4 under-estimates text savings; multi-col cost is linearly
// scaled from single-col + 10% margin. Mispredictions leave money on the
// table; they never generate net-loss images.

/** English ~4 chars per token average (conservative for code/JSON content). */
const CHARS_PER_TOKEN = 4;

/** Conservative cpt for dense project-governance text (historical observed 1.91). */
export const SLAB_CHARS_PER_TOKEN = 2.0;

/** Empirical cpt for the history-collapse path (same Opus 4.7 telemetry as SLAB_CHARS_PER_TOKEN).
 *  History is even denser (tool_use JSON dominates), so 2.0 is doubly conservative. */
export const HISTORY_CHARS_PER_TOKEN = 2.0;
export const MAX_ANTHROPIC_IMAGES = 100;

// These tool stubs retain the host's live read-before-write precondition when
// their longer documentation moves into an experimental image reference.
const READ_FIRST_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

/** Chars-per-token for the `pxpipe export` *reporting* estimate (factsheet & savings %).
 *  Less conservative than the gate's CHARS_PER_TOKEN=4: reporting wants an accurate
 *  figure (~3.7 for source/prose text), not a safe-side under-estimate. Single source
 *  of truth — src/core/export.ts imports this rather than redefining it. */
export const REPORT_CHARS_PER_TOKEN = 3.7;

/** Anthropic image-billing formula: `tokens ≈ width × height / 750`.
 *  https://docs.anthropic.com/en/docs/build-with-claude/vision#image-tokens
 *  Accurate to ~5% on dense glyph PNGs (N=14 empirical calibration). The renderer
 *  sizes height to content, so per-block images cost far less than full-canvas.
 *  Exported so the export pipeline can reuse the same constant rather than hardcoding. */
export const ANTHROPIC_PIXELS_PER_TOKEN = 750;
/** Conservative 10% upward bias on Anthropic image token estimates — keeps the gate
 *  on the safe (pass-through) side when the true cost is near the break-even point.
 *  Exported so the export pipeline reuses the same value. */
export const IMAGE_COST_SAFETY_MARGIN = 1.10;

/** Width in px of a single-col PNG. Must stay in sync with `renderChunkToPng` (render.ts). */
function singleColWidthPx(cols: number): number {
  return 2 * PAD_X + cols * CELL_W;
}

/** Width in px of a multi-col PNG. Mirrors `multiColWidth()` in render.ts. */
function multiColWidthPx(cols: number, numCols: number): number {
  const n = Math.max(1, numCols | 0);
  if (n === 1) return singleColWidthPx(cols);
  const GUTTER_CELLS = 4; // must match render.ts (not exported)
  return 2 * PAD_X + n * cols * CELL_W + (n - 1) * GUTTER_CELLS * CELL_W;
}

/** Exact image-token cost for `visualRows` at given column/multi-col geometry.
 *  Mirrors the renderer's height math so the gate matches Anthropic billing.
 *  Last image is partial-height; each image cost ∝ pixel area. */
function imageTokensForRows(
  visualRows: number,
  cols: number,
  numCols: number = 1,
  imageCountCap?: number,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): number {
  if (!Number.isFinite(visualRows) || visualRows <= 0) return 0;
  const n = Math.max(1, numCols | 0);
  const widthPx = multiColWidthPx(cols, n);
  const hardLinesPerImg = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));
  const readableLinesPerCol = Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols)));
  const linesPerImg = Math.min(hardLinesPerImg, readableLinesPerCol);
  const rowsPerImage = linesPerImg; // pixel rows per image (height)
  const linesPerImage = linesPerImg * n; // wrapped-text lines per image (n cols side-by-side)
  let imagesNeeded = Math.ceil(visualRows / linesPerImage);
  if (imageCountCap !== undefined && imageCountCap > 0) {
    imagesNeeded = Math.min(imagesNeeded, imageCountCap);
  }
  const fullImages = Math.max(0, imagesNeeded - 1);
  const linesInLast = visualRows - fullImages * linesPerImage;
  // Column-major layout: pixel rows = min(linesInLast, rowsPerImage).
  const rowsInLast = Math.min(Math.max(1, linesInLast), rowsPerImage);
  const fullImageHeight = 2 * PAD_Y + rowsPerImage * CELL_H;
  const lastImageHeight = 2 * PAD_Y + rowsInLast * CELL_H;
  const totalPixels = fullImages * widthPx * fullImageHeight + widthPx * lastImageHeight;
  return Math.ceil((totalPixels / ANTHROPIC_PIXELS_PER_TOKEN) * IMAGE_COST_SAFETY_MARGIN);
}

/** Exact image-token cost for `text`. Uses `countVisualRows` and optionally
 *  `shrinkColsToContent` (default true) so narrow blocks aren't priced at full
 *  canvas width. Pass `shrinkWidth=false` for the system slab (fills full `cols`). */
function imageTokensCost(
  text: string,
  cols: number,
  numCols: number = 1,
  imageCountCap?: number,
  shrinkWidth: boolean = true,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): number {
  const effectiveCols = shrinkWidth ? shrinkColsToContent(text, cols) : cols;
  const rows = countVisualRows(text, effectiveCols);
  return imageTokensForRows(rows, effectiveCols, numCols, imageCountCap, maxCharsPerImage);
}

/** Gate geometry for the single-col dense path (tool_result, reminder, history).
 *  Dense single-col uses DENSE_CONTENT_COLS/DENSE_CONTENT_CHARS_PER_IMAGE;
 *  multi-col uses configured `cols` at READABLE budget. Slab uses its own path. */
function denseGateGeometry(cols: number, numCols: number): { cols: number; maxChars: number } {
  return Math.max(1, numCols | 0) > 1
    ? { cols, maxChars: READABLE_CHARS_PER_IMAGE }
    : { cols: DENSE_CONTENT_COLS, maxChars: DENSE_CONTENT_CHARS_PER_IMAGE };
}

/** Visual rows per image: `floor((MAX_HEIGHT_PX − 2·PAD_Y) / CELL_H)`. Derived
 *  from render.ts constants so break-even math auto-tracks cell geometry changes. */
export const LINES_PER_IMAGE = Math.max(1, Math.floor((MAX_HEIGHT_PX - 2 * PAD_Y) / CELL_H));

export function maxCharsPerImage(cols: number): number {
  return Math.min(cols * LINES_PER_IMAGE, READABLE_CHARS_PER_IMAGE);
}

/** Lossless pre-render whitespace compactor (each `\n` costs ≥1 visual row):
 *  1. Strip trailing whitespace per line (preserves leading indent).
 *  2. Collapse 3+ consecutive newlines to 2. Typically saves 10-25% rows on
 *     markdown/tool-doc slabs, enough to flip borderline gates to profitable. */
export function compactSlabWhitespace(text: string): string {
  if (!text) return text;
  // Single-pass trailing whitespace strip (avoids materializing a split array on ~160 KB slabs).
  let trimmed = '';
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10 /* \n */) {
      let end = i;
      while (end > lineStart) {
        const c = text.charCodeAt(end - 1);
        if (c !== 32 && c !== 9) break;
        end--;
      }
      trimmed += text.slice(lineStart, end);
      if (i < text.length) trimmed += '\n';
      lineStart = i + 1;
    }
  }
  // Collapse 3+ newlines → 2 (kills multi-blank dividers; each costs a render row).
  return trimmed.replace(/\n{3,}/g, '\n\n');
}

/** Apply R3 reflow when enabled. Run after `compactSlabWhitespace`, before
 *  the gate (gate/renderer/paging all see the same dense text). Falls back to
 *  input unchanged on sentinel collision. */
function maybeReflow(text: string, enabled: boolean): string {
  if (!enabled) return text;
  // Neutralize any pre-existing ↵ so reflow packs newlines instead of bailing to a raw,
  // unpacked render (the tool_result "newlines not converted to ↵" case — common when the
  // content is about pxpipe itself). Render-only; originals are preserved via
  // recordRecoverable(innerRaw), so this substitution never reaches recovery.
  const safe = neutralizeSentinel(text);
  return reflow(safe) ?? safe;
}

/** Decompose the break-even gate into components for telemetry. Returns the
 *  imageTokens, textTokens, and symmetric burn terms the gate uses internally,
 *  or `null` for empty/non-finite input. */
export function evalCompressionProfitability(
  text: string,
  cols: number,
  imageCountCap: number | undefined = undefined,
  numCols: number = 1,
  charsPerToken: number = CHARS_PER_TOKEN,
  priorWarmTokens: number = 0,
  priorWarmImageTokens: number = 0,
  shrinkWidth: boolean = true,
): {
  imageTokens: number;
  textTokens: number;
  burnImageSide: number;
  burnTextSide: number;
  profitable: boolean;
} | null {
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return null;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokens = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth);
  const textTokens = text.length / cpt;
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return {
    imageTokens,
    textTokens,
    burnImageSide,
    burnTextSide,
    profitable: imageTokens + burnImageSide < textTokens + burnTextSide,
  };
}

export function isCompressionProfitable(
  text: string,
  cols: number = DEFAULTS.cols,
  imageCountCap?: number,
  numCols: number = 1,
  charsPerToken: number = CHARS_PER_TOKEN,
  priorWarmTokens: number = 0,
  priorWarmImageTokens: number = 0,
  shrinkWidth: boolean = true,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): boolean {
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return false;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokensCost_ = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth, maxCharsPerImage);
  const textTokensEquivalent = text.length / cpt;
  // Symmetric burn penalty (anti-flapping): switching modes invalidates the warm
  // cache on whichever side was warm, paying cache_create. Burn is added to the
  // side that would flip — pinning the session in its current mode until
  // per-turn savings exceed the burn cost.
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return imageTokensCost_ + burnImageSide < textTokensEquivalent + burnTextSide;
}

/**
 * Horizon-aware variant of `isCompressionProfitable` for history-collapse.
 *
 * Evaluates expected lifetime cost over N turns: worst-case-warm for image
 * (cache_create turn 1, cache_read turns 2..N) vs best-case-warm for text
 * (cache_read all N). Gate condition: I×(CC + CR×(N-1)) < T×CR×N.
 * Examples: N=5 → I < 0.30×T; N=10 → I < 0.47×T.
 * Falls back to cold per-turn gate when `horizon <= 1`. See docs/HISTORY_CACHE_MODEL.md.
 */
export function isCompressionProfitableAmortized(
  text: string,
  cols: number,
  imageCountCap: number | undefined,
  numCols: number,
  charsPerToken: number,
  horizon: number,
  priorWarmTokens: number = 0,
  priorWarmImageTokens: number = 0,
  shrinkWidth: boolean = true,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
): boolean {
  if (!Number.isFinite(horizon) || horizon <= 1) {
    return isCompressionProfitable(text, cols, imageCountCap, numCols, charsPerToken, priorWarmTokens, priorWarmImageTokens, shrinkWidth, maxCharsPerImage);
  }
  const N = Math.max(2, Math.floor(horizon));
  const n = Math.max(1, numCols | 0);
  if (typeof text !== 'string' || text.length === 0) return false;
  const cpt = Number.isFinite(charsPerToken) && charsPerToken > 0
    ? charsPerToken
    : CHARS_PER_TOKEN;
  const imageTokens = imageTokensCost(text, cols, n, imageCountCap, shrinkWidth, maxCharsPerImage);
  const textTokens = text.length / cpt;
  // Worst-case-for-image vs best-case-for-text (conservative, on purpose).
  const imageLifetime = imageTokens * (CACHE_CREATE_RATE + CACHE_READ_RATE * (N - 1));
  const textLifetime = textTokens * CACHE_READ_RATE * N;
  // Symmetric burn — see isCompressionProfitable for anti-flapping rationale.
  const burnImageSide = Number.isFinite(priorWarmTokens) && priorWarmTokens > 0
    ? priorWarmTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  const burnTextSide = Number.isFinite(priorWarmImageTokens) && priorWarmImageTokens > 0
    ? priorWarmImageTokens * (CACHE_CREATE_RATE - CACHE_READ_RATE)
    : 0;
  return imageLifetime + burnImageSide < textLifetime + burnTextSide;
}


/** Increment a passthrough-reason counter on `info`. Lazily allocates `passthroughReasons`. */
function bumpPassthrough(
  info: TransformInfo,
  reason:
    | 'below_threshold'
    | 'not_profitable'
    | 'kept_sharp'
    | 'exact_identifier'
    | 'too_many_images'
    | 'render_error'
    | 'unsupported_shape',
): void {
  if (!info.passthroughReasons) info.passthroughReasons = {};
  info.passthroughReasons[reason] = (info.passthroughReasons[reason] ?? 0) + 1;
}

/** Invoke `keepSharp` defensively; a throw or non-`true` return means "image as usual". */
function callerKeepsSharp(
  fn: ((block: KeepSharpBlock) => boolean) | undefined,
  block: KeepSharpBlock,
): boolean {
  if (typeof fn !== 'function') return false;
  try {
    return fn(block) === true;
  } catch {
    return false;
  }
}

/** Logical bucket for per-gate-call char attribution. Used by the rolling-cpt
 *  regression to derive per-bucket marginal cpt from production telemetry. */
export type BucketName =
  | 'project_guidance'
  | 'static_slab'
  | 'reminder'
  | 'tool_reference'
  | 'tool_result_json'
  | 'tool_result_log'
  | 'tool_result_prose'
  | 'history';

/** Pre-compaction TEXT char totals per bucket. Absent when no bucket fired. */
export type BucketChars = Partial<Record<BucketName, number>>;

/** Source chars that were actually image-encoded. Kept separate from
 * `bucketChars`, whose candidates include rejected gates. */
export type ImagedBucketChars = Partial<Record<BucketName, number>>;

/** Attribute `chars` to a compression bucket (called whether gate accepted or rejected). */
function bumpBucket(info: TransformInfo, bucket: BucketName, chars: number): void {
  if (chars <= 0) return;
  if (!info.bucketChars) info.bucketChars = {};
  info.bucketChars[bucket] = (info.bucketChars[bucket] ?? 0) + chars;
}

function bumpImagedBucket(info: TransformInfo, bucket: BucketName, chars: number): void {
  if (chars <= 0) return;
  if (!info.imagedBucketChars) info.imagedBucketChars = {};
  info.imagedBucketChars[bucket] = (info.imagedBucketChars[bucket] ?? 0) + chars;
  info.compressedChars += chars;
}

/** Map `classifyContent` shape to a tool_result bucket name. */
function toolResultBucket(shape: 'structured' | 'log' | 'other'): BucketName {
  if (shape === 'structured') return 'tool_result_json';
  if (shape === 'log') return 'tool_result_log';
  return 'tool_result_prose';
}

/** Parsed contents of Claude Code's <env> + git status blocks. All optional —
 *  fields are only populated if the corresponding line is present. */
export interface EnvFields {
  /** Working directory at the time `claude` was launched. */
  cwd?: string;
  isGitRepo?: boolean;
  /** Current git branch, parsed from <git_status> or a "Branch:" line. */
  gitBranch?: string;
  platform?: string;
  osVersion?: string;
  /** "Today's date" as Claude Code reported it (YYYY-MM-DD). */
  today?: string;
}

export interface TransformInfo {
  compressed: boolean;
  reason?: string;
  /** Source chars removed from native text by applied image buckets. Can exceed
   * `compressedChars` when a bounded tool-result page explicitly omits chars. */
  origChars: number;
  /** Disjoint source chars actually represented in images across every applied bucket. */
  compressedChars: number;
  imageCount: number;
  imageBytes: number;
  /** Σ width×height across all rendered images. Pairs with upstream token count for
   *  empirical px/token regression: `tokens ≈ α·outgoingTextChars + β·imagePixels`. */
  imagePixels?: number;
  /** GPT only. Vision tokens the rendered images actually cost as input
   *  (Σ openAIVisionTokens over real image dims). The "Sent as image" basis. */
  imageTokens?: number;
  /** GPT only. o200k_base text tokens of the content pxpipe imaged/stripped —
   *  the would-have-paid "as plain text" baseline. Compared against imageTokens
   *  for the per-request saving. See src/core/openai-savings.ts. */
  baselineImagedTokens?: number;
  /** Total TEXT chars in the outgoing body (system + messages, excluding image base64).
   *  Denominator for empirical chars-per-token regression on cold-miss events. */
  outgoingTextChars?: number;
  /** Length of the static (cacheable) slab rendered into the image. */
  staticChars: number;
  /** Length of the dynamic (per-turn) slab kept as plain text. */
  dynamicChars: number;
  /** Chars of volatile env/context text relocated from system to the tail of
   *  the last user message (absent when kept in system fallback). */
  envRelocatedChars?: number;
  dynamicBlockCount: number;
  /** Versioned context framing selected for this request. */
  contextMode?: 'claude_code_2_1_205' | 'safe_native';
  /** Exact recognized project-guidance source chars, never the source text itself. */
  projectSourceChars?: number;
  projectSourceRole?: 'user';
  projectSourceMessageIndex?: number;
  projectSourceBlockIndex?: number;
  /** Deterministic 128-bit role-binding reference (`pg_` + 32 hex). */
  projectRef?: string;
  projectImageCount?: number;
  projectSourceSha8?: string;
  projectDisposition?:
    | 'imaged'
    | 'native_disabled'
    | 'native_below_threshold'
    | 'native_not_profitable'
    | 'native_too_many_images'
    | 'native_render_error';
  /** Native `tools[]` is the default. Experimental image mode is an explicit opt-in. */
  toolMode?: 'native' | 'experimental_image';
  toolDisposition?:
    | 'imaged'
    | 'native_default'
    | 'native_below_threshold'
    | 'native_not_profitable'
    | 'native_too_many_images'
    | 'native_render_error';
  /** Exact serialized native tools chars/hash; source text itself is never persisted. */
  toolSourceChars?: number;
  toolImageCount?: number;
  toolSourceSha8?: string;
  /** Deterministic 128-bit tool binding reference (`tr_` + 32 hex). */
  toolRef?: string;
  /** Exact captured runtime-metadata chars moved to the vouched final user tail. */
  runtimeMetadataChars?: number;
  /** Exact recognized runtime-metadata chars, including a late transaction failure. */
  runtimeMetadataSourceChars?: number;
  /** Per-bucket result; a failed late transaction leaves every source byte native. */
  runtimeMetadataDisposition?: 'moved' | 'native_apply_error';
  /** Input-owned privileged text left native; excludes pxpipe-generated manifests. */
  nativeSystemChars?: number;
  /** Disjoint opening-carrier chars that no exact recognizer claimed. */
  uncertainContextChars?: number;
  uncertainContextReasons?: Array<
    | 'unsupported_or_missing_claude_md_section'
    | 'unsupported_or_malformed_claude_context_tail'
  >;
  /** Tag-shaped blocks in the static slab not in DYNAMIC_BLOCK_TAGS.
   *  Canary: a new per-turn Claude Code tag would appear here before cache rate collapses. */
  unknownStaticTags?: string[];
  /** Static-slab tags whose content changed within a session — proven dynamic,
   *  busting the image cache each turn. The real alert signal. */
  churningStaticTags?: string[];
  env?: EnvFields;
  /** Legacy/provider-specific static-system identity; exact prefix identity is cachePrefixSha8. */
  systemSha8?: string;
  /** sha8 of the CLAUDE.md section, for bucketing by project when cwd is absent. */
  claudeMdSha8?: string;
  /** sha8 of first user message text (first 4 KiB). Rough thread/session id. */
  firstUserSha8?: string;
  /** Raw bytes of the first rendered image. Dashboard preview only; NOT persisted to JSONL. */
  firstImagePng?: Uint8Array;
  firstImageWidth?: number;
  firstImageHeight?: number;
  /** All rendered PNGs this request. Dashboard only; NOT persisted to JSONL. */
  imagePngs?: Uint8Array[];
  imageDims?: Array<{ width: number; height: number }>;
  /** Preview source for the first rendered bucket, capped at 64 KiB. NOT persisted. */
  imageSourceText?: string;
  reminderImgs?: number;
  toolResultImgs?: number;
  /** Canonically framed tool-document chars considered by the experimental image gate. */
  toolDocsChars?: number;
  /** Codepoints missing from the atlas (rendered as blank cells). Telemetry for atlas tuning. */
  droppedChars?: number;
  /** Top dropped codepoints by frequency (`U+HHHH` → count), at most 20 entries. */
  droppedCodepointsTop?: Record<string, number>;
  /** Why blocks passed through without compression. Only present when count > 0. */
  passthroughReasons?: {
    below_threshold?: number;
    not_profitable?: number;
    kept_sharp?: number;
    exact_identifier?: number;
    too_many_images?: number;
    render_error?: number;
    unsupported_shape?: number;
  };
  /** Slab gate diagnostics — imageTokens, textTokens, burn terms, and verdict.
   *  Lets hosts measure flap-prevention efficacy and tune amortization horizon. */
  gateEval?: {
    readonly site: 'slab' | 'project_guidance';
    readonly imageTokens: number;
    readonly textTokens: number;
    /** `priorWarmTokens × (CC − CR)` added to image side. */
    readonly burnImageSide: number;
    /** `priorWarmImageTokens × (CC − CR)` added to text side (anti-flapping anchor). */
    readonly burnTextSide: number;
    readonly profitable: boolean;
  };
  /** Independent tool-reference gate. Never aliases the project gate. */
  toolGateEval?: {
    readonly site: 'tool_reference';
    readonly imageTokens: number;
    readonly textTokens: number;
    readonly burnImageSide: number;
    readonly burnTextSide: number;
    readonly profitable: boolean;
  };
  /** Pre-compaction TEXT char totals per gate-call bucket. Rolling-cpt regression denominator. */
  bucketChars?: BucketChars;
  /** Successfully image-encoded source chars, disjoint by bucket. */
  imagedBucketChars?: ImagedBucketChars;
  /** Chars fed into the history-image renderer. Folded into `bucketChars.history` too. */
  historyTextChars?: number;
  /** Blocks pinned as text by the caller's `keepSharp` predicate this request. */
  keptSharpBlocks?: number;
  /** Imaged live-region blocks with original text + provenance, when `emitRecoverable`. */
  recoverable?: RecoverableBlock[];
  truncatedToolResults?: number;
  omittedChars?: number;
  /** History-collapse: messages collapsed into the synthetic prepended user message. */
  collapsedTurns?: number;
  collapsedChars?: number;
  /** History-collapse images. Also folded into `info.imageCount`. */
  collapsedImages?: number;
  /** sha8 of concatenated history-image base64. Diagnoses whether the collapsed
   *  history artifact itself is stable; whole-prefix identity is cachePrefixSha8. */
  historyImageSha?: string;
  /** sha8 of the ACTUAL cacheable prefix sent this turn (tools + system +
   *  message blocks through the imaged history/slab boundary; the live tail is
   *  excluded). Read-only measurement. A change turn-over-turn within a session
   *  ⇒ pxpipe serialized different prefix bytes (we busted our own cache,
   *  pxpipe-side); STABLE while cache_create spikes / cache_read collapses ⇒ the
   *  prefix was evicted upstream. Decisive attribution signal (see #11). */
  cachePrefixSha8?: string;
  /** Approx size (chars) of that cached prefix — pairs with cachePrefixSha8 so a
   *  bust reads as growth (size up) vs pure invalidation (size unchanged). */
  cachePrefixBytes?: number;
  cacheBoundaryKind?: 'project_guidance' | 'tool_reference' | 'history';
  /** Why the history collapse didn't run (or did). Diagnostic only. */
  historyReason?:
    | 'no_history'
    | 'prefix_too_short'
    | 'no_closed_prefix'
    | 'privileged_role_in_collapse_range'
    | 'context_reminder_in_collapse_range'
    | 'ambiguous_cache_markers_in_collapse_range'
    | 'mid_message_cache_marker'
    | 'cache_marker_mismatch'
    | 'below_min_chars'
    | 'below_min_tokens'
    | 'not_profitable'
    | 'too_many_images'
    | 'render_empty'
    | 'render_error'
    | 'collapsed';
  /** Token count of the pre-compression body from /v1/messages/count_tokens (free).
   *  Absent when probe failed — event excluded from savings rollup. */
  baselineTokens?: number;
  /** Token count of the pre-compression body truncated at the last cache_control marker.
   *  Absent when the original body has no cache_control markers (cacheable=0 exactly). */
  baselineCacheableTokens?: number;
  /** Token counts for the proposed complete body and cacheable prefix. These are
   *  admission evidence only; actual billed usage still comes from the response. */
  candidateTokens?: number;
  candidateCacheableTokens?: number;
  /** 'ok': all four original/candidate full/prefix measurements resolved.
   *  'partial': at least one resolved and at least one failed. 'failed': none
   *  resolved or no valid probe bodies. undefined: no probe attempted. */
  baselineProbeStatus?: 'ok' | 'partial' | 'failed';
  /** Strict request-wide admission result. Reasons contain no caller text. */
  admissionReason?: string;
  admissionCacheTier?: 'none' | '5m' | '1h' | 'conservative_1h';
  /** Caller-owned marker rate used for the unchanged text counterfactual. */
  baselineCacheCreateRate?: 1.25 | 2;
  admissionOriginalEffectiveTokens?: number;
  admissionCandidateEffectiveTokens?: number;
  admissionSignedSavingsTokens?: number;
  admissionRelativeSavings?: number;
  /** Hash-only Node breaker identity; never contains source text or credentials. */
  admissionFingerprint?: string;
}

// --- helpers ---------------------------------------------------------------

/** Full SHA-256 hex via Web Crypto (works in Node 18+ and Workers). */
async function sha256Hex(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** Historical eight-hex telemetry identity. Not used for authority binding. */
export async function sha8(text: string): Promise<string> {
  return (await sha256Hex(text)).slice(0, 8);
}

/** Record a recovery entry when `emitRecoverable` is on. No-op (no hash cost) when off. */
async function recordRecoverable(
  info: TransformInfo,
  emit: boolean,
  entry: { kind: RecoverableBlock['kind']; toolUseId?: string; text: string; imageCount: number },
): Promise<void> {
  if (!emit) return;
  const id = 'rec_' + (await sha8(`${entry.kind}\u0000${entry.toolUseId ?? ''}\u0000${entry.text}`));
  (info.recoverable ??= []).push({
    id,
    kind: entry.kind,
    ...(entry.toolUseId !== undefined ? { toolUseId: entry.toolUseId } : {}),
    text: entry.text,
    imageCount: entry.imageCount,
  });
}

/** Hash the concatenated base64 of every image block on the synthetic history
 *  message, wherever a protected project/system prefix placed it. */
async function historyImageSha8(
  messages: Message[],
): Promise<string | undefined> {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    const first = message.content[0];
    if (!first || first.type !== 'text' || first.text !== HISTORY_SYNTHETIC_INTRO) continue;
    let concat = '';
    for (const block of message.content) {
      if (block.type === 'image') concat += block.source.data;
    }
    return concat ? sha8(concat) : undefined;
  }
  return undefined;
}

/**
 * Read-only digest of the cacheable prefix pxpipe actually sends: tools +
 * system + message blocks up to and including the imaged history image (or, on
 * no-collapse turns, the slab boundary). The naturally-growing live tail is
 * excluded, so the digest only moves when something *inside the pinned prefix*
 * moves. Pairs with per-turn cache_read/cache_create to attribute a prompt-cache
 * bust: a digest that CHANGES between consecutive turns of one session means we
 * serialized different prefix bytes (pxpipe-side — a per-turn block crossing the
 * breakpoint, or marker drift); a STABLE digest on a turn that still re-created
 * the prefix points upstream (eviction). Never mutates the request, so it cannot
 * perturb the cache behavior it measures.
 */
async function cachePrefixDigest(
  req: { tools?: unknown; system?: unknown; messages?: unknown },
  expectedProjectRef?: string,
  expectedToolRef?: string,
  expectedToolImageCount?: number,
): Promise<{
  sha8: string;
  bytes: number;
  kind: 'project_guidance' | 'tool_reference' | 'history';
} | undefined> {
  const msgs = Array.isArray(req.messages) ? (req.messages as Message[]) : [];
  type Boundary = {
    messageIndex: number;
    blockIndex: number;
    kind: 'project_guidance' | 'tool_reference' | 'history';
  };
  const structural: Boundary[] = [];
  const histories: Boundary[] = [];
  if (expectedProjectRef !== undefined) {
    const opening = msgs[0];
    if (!opening || opening.role !== 'user' || !Array.isArray(opening.content)) return undefined;
    const exactBoundary = opening.content.findIndex((block) =>
      isProjectGuidanceBoundaryBlock(block, expectedProjectRef));
    if (
      exactBoundary <= 0 ||
      !opening.content.slice(0, exactBoundary).every((block) => block.type === 'image')
    ) return undefined;
    structural.push({ messageIndex: 0, blockIndex: exactBoundary, kind: 'project_guidance' });
  }

  if (expectedToolRef !== undefined) {
    const matches: Array<{ messageIndex: number; blockIndex: number }> = [];
    for (let i = 0; i < msgs.length; i++) {
      const content = msgs[i]?.content;
      if (!Array.isArray(content)) continue;
      for (let j = 0; j < content.length; j++) {
        const block = content[j];
        if (block?.type === 'text' && toolReferenceBoundaryRef(block.text) === expectedToolRef) {
          matches.push({ messageIndex: i, blockIndex: j });
        }
      }
    }
    if (matches.length !== 1) return undefined;
    const match = matches[0]!;
    const content = msgs[match.messageIndex]!.content;
    const firstToolPage = match.blockIndex - (expectedToolImageCount ?? 0);
    if (
      !Array.isArray(content) ||
      expectedToolImageCount === undefined ||
      expectedToolImageCount <= 0 ||
      firstToolPage < 0 ||
      !content.slice(firstToolPage, match.blockIndex).every((block) => block.type === 'image')
    ) {
      return undefined;
    }
    structural.push({
      messageIndex: match.messageIndex,
      blockIndex: match.blockIndex,
      kind: 'tool_reference',
    });
  }

  for (let i = 0; i < msgs.length; i++) {
    const content = msgs[i]?.content;
    if (!Array.isArray(content)) continue;
    const first = content[0] as TextBlock | undefined;
    if (first?.type !== 'text' || first.text !== HISTORY_SYNTHETIC_INTRO) continue;
    for (let j = 0; j < content.length; j++) {
      const block = content[j];
      if (block?.type === 'image' && block.cache_control !== undefined) {
        histories.push({ messageIndex: i, blockIndex: j, kind: 'history' });
      }
    }
  }

  const later = (a: Boundary, b: Boundary): number =>
    a.messageIndex - b.messageIndex || a.blockIndex - b.blockIndex;
  // A marked history image is the caller-owned, byte-stable cache anchor and
  // therefore wins even if a future placement regression puts another
  // structural boundary after it. Otherwise use the latest exact pxpipe
  // project/tool boundary.
  const boundary = (histories.length > 0 ? histories : structural).sort(later).at(-1);
  if (!boundary) return undefined;
  const { messageIndex: boundaryMessage, blockIndex: boundaryBlock, kind: boundaryKind } = boundary;
  const prefixMessages = msgs.slice(0, boundaryMessage);
  const message = msgs[boundaryMessage]!;
  if (!Array.isArray(message.content)) return undefined;
  prefixMessages.push({ ...message, content: message.content.slice(0, boundaryBlock + 1) });
  const prefix = JSON.stringify({
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(req.system !== undefined ? { system: req.system } : {}),
    messages: prefixMessages,
  });
  return {
    sha8: await sha8(prefix),
    // Legacy field name; this remains JavaScript chars for historical rows.
    bytes: prefix.length,
    kind: boundaryKind,
  };
}

/** First user message text, capped at 4 KiB (stable thread id; hashing large pastes is wasteful). */
export function firstUserText(req: MessagesRequest): string {
  const opening = partitionAnthropicContext(req).openingCarrier;
  const msgs = req.messages ?? [];
  for (let messageIndex = 0; messageIndex < msgs.length; messageIndex++) {
    const m = msgs[messageIndex]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content.slice(0, 4096);
    if (Array.isArray(m.content)) {
      for (let blockIndex = 0; blockIndex < m.content.length; blockIndex++) {
        if (
          opening &&
          opening.locator.messageIndex === messageIndex &&
          opening.locator.blockIndex === blockIndex
        ) continue;
        const block = m.content[blockIndex];
        if (block && (block as any).type === 'text' && typeof (block as any).text === 'string') {
          return ((block as any).text as string).slice(0, 4096);
        }
      }
    }
    // First user message found but unreadable — return empty rather than fall through to next.
    return '';
  }
  return '';
}


function makeImageBlock(pngB64: string, _ephemeral = false): ImageBlock {
  // pxpipe never adds its own cache_control — only moves existing caller markers
  // across the text→image flip. `_ephemeral` is preserved for call-site compat.
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: pngB64 },
  };
}

// --- paging / truncation ---------------------------------------------------
// Anthropic caps requests at 100 images. Huge tool_results (find trees,
// log dumps) are truncated with a paging marker before render.

/** Visual rows a single input line will consume after soft-wrap at `cols`. */
function lineRows(line: string, cols: number): number {
  return Math.max(1, Math.ceil(line.length / cols));
}

/** Visual row count after soft-wrap at `cols`.
 *
 *  Only hard `\n` starts a new row. The reflow ↵ sentinel is an inline glyph
 *  (see wrapLines in render.ts: "never forces a row break"), so packing many
 *  original newlines into one soft-wrapped stream must NOT inflate the row
 *  count. Treating ↵ as a break overstated image pages ~6× on reflowed
 *  history and flipped profitable collapses to not_profitable. */
function countVisualRows(text: string, cols: number): number {
  let rows = 0;
  let lineStart = 0;
  const len = text.length;
  for (let i = 0; i <= len; i++) {
    const cc = i < len ? text.charCodeAt(i) : -1;
    if (i === len || cc === 10 /* \n */) {
      const lineLen = i - lineStart;
      // Empty line (consecutive \n) still costs one visual row.
      rows += lineLen === 0 ? 1 : Math.ceil(lineLen / Math.max(1, cols));
      lineStart = i + 1;
    }
  }
  return rows;
}

/** Estimate how many images `text` will render to at the given column width.
 *  Counts soft-wrapped visual rows, which is what render.ts actually budgets
 *  against. Exported for tests + the paging gate.
 *
 *  `numCols` (default 1) packs that many text columns side-by-side per
 *  image — must match the `multiCol` setting wired through to the renderer
 *  for the math to predict the actual image count. */
export function estimateImageCount(
  textOrLen: string | number,
  cols: number,
  numCols: number = 1,
  maxCharsPerImage: number = READABLE_CHARS_PER_IMAGE,
  maxLinesPerColumn: number = LINES_PER_IMAGE,
): number {
  const n = Math.max(1, numCols | 0);
  const readableLinesPerCol = Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols)));
  const hardLinesPerCol = Math.max(1, Math.floor(maxLinesPerColumn));
  const linesPerImage = Math.min(hardLinesPerCol, readableLinesPerCol) * n;
  const charBudget = Math.max(1, maxCharsPerImage * n);
  if (typeof textOrLen === 'number') {
    // Back-compat shim — numeric arg gets the looser chars-based estimate.
    return Math.max(1, Math.ceil(textOrLen / charBudget));
  }
  const rows = countVisualRows(textOrLen, cols);
  return Math.max(
    1,
    Math.ceil(rows / linesPerImage),
    Math.ceil(textOrLen.length / charBudget),
  );
}

/** Classify content so we can pick a truncation strategy. Cheap heuristics on
 *  the first ~4 KiB. Returns:
 *    - `'structured'`: JSON/YAML/diff markers at the top. Truncate tail.
 *    - `'log'`: ≥30% of lines start with a log level or timestamp. Truncate middle.
 *    - `'other'`: prose, file dumps, etc. Truncate middle.
 *  Exported for tests. */
export function classifyContent(text: string): 'structured' | 'log' | 'other' {
  const head = text.slice(0, 4096);
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{') && /^\{\s*("|\})/.test(trimmed)) return 'structured';
  if (trimmed.startsWith('[') && /^\[\s*("|\{|\[|-?\d|true\b|false\b|null\b|\])/.test(trimmed))
    return 'structured';
  if (trimmed.startsWith('---\n') || trimmed.startsWith('---\r\n')) return 'structured';
  if (trimmed.startsWith('diff --git ') || /^---\s+\S/.test(trimmed)) return 'structured';
  const lines = head.split('\n').slice(0, 40).filter((l) => l.length > 0);
  if (lines.length < 4) return 'other';
  const LOG_LINE =
    /^(\[?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\]?\b|\d{4}-\d{2}-\d{2}[T ]?|\d{2}:\d{2}:\d{2}\b)/;
  let logHits = 0;
  for (const line of lines) if (LOG_LINE.test(line)) logHits++;
  if (logHits / lines.length >= 0.3) return 'log';
  return 'other';
}

/** Build the paging marker text. The model sees this verbatim INSIDE the
 *  rendered image so it can reason about what was elided. */
function buildPagingMarker(args: {
  originalChars: number;
  originalLines: number;
  originalEstImages: number;
  shownHeadLines: number;
  shownTailLines: number;
  omittedLines: number;
  omittedChars: number;
}): string {
  const tailNote =
    args.shownTailLines > 0
      ? ` Showing first ${args.shownHeadLines} lines and last ${args.shownTailLines} lines.`
      : ` Showing first ${args.shownHeadLines} lines (tail elided).`;
  return (
    `\n\n[ pxpipe paging: omitted ${args.omittedLines.toLocaleString('en-US')} lines ` +
    `(${args.omittedChars.toLocaleString('en-US')} chars) of content here. ` +
    `Original length: ${args.originalChars.toLocaleString('en-US')} chars ` +
    `(${args.originalLines.toLocaleString('en-US')} lines, ~${args.originalEstImages} images).` +
    `${tailNote} ]\n\n`
  );
}

/** Truncate `text` so it renders to roughly `maxImages` images at the given
 *  `cols`. Picks head/tail split based on `classifyContent`. Budget measured
 *  in visual rows (what render.ts actually slices on). Returns the truncated
 *  text (with paging marker embedded) and the count of chars omitted. If
 *  `text` already fits, returns unchanged with `omittedChars: 0`. Exported
 *  for tests. */
export function truncateForBudget(
  text: string,
  maxImages: number,
  cols: number,
  numCols: number = 1,
  maxCharsPerImage: number = DENSE_CONTENT_CHARS_PER_IMAGE,
): { text: string; omittedChars: number; truncated: boolean } {
  const n = Math.max(1, numCols | 0);
  const estImages = estimateImageCount(text, cols, n, maxCharsPerImage);
  if (estImages <= maxImages) return { text, omittedChars: 0, truncated: false };
  const readableLinesPerCol = Math.max(1, Math.floor(maxCharsPerImage / Math.max(1, cols)));
  const totalRowBudget = Math.max(8, maxImages * Math.min(LINES_PER_IMAGE, readableLinesPerCol) * n - 6);
  const totalCharBudget = Math.max(128, maxImages * maxCharsPerImage * n - 512);
  const shape = classifyContent(text);
  // Reflowed text uses NL_SENTINEL (↵ U+21B5) as line separator instead of \n.
  // Split on whichever delimiter the text uses so we can truncate at logical
  // line boundaries rather than treating the entire reflowed blob as one line.
  const nlChar = text.indexOf('\n') >= 0 ? '\n' : NL_SENTINEL;
  const lines = text.split(nlChar);
  const originalLines = lines.length;
  const originalChars = text.length;

  if (shape === 'structured') {
    let rows = 0;
    let chars = 0;
    let cut = 0;
    for (let i = 0; i < lines.length; i++) {
      const r = lineRows(lines[i]!, cols);
      const c = lines[i]!.length + (i > 0 ? 1 : 0);
      if (rows + r > totalRowBudget || chars + c > totalCharBudget) break;
      rows += r;
      chars += c;
      cut = i + 1;
    }
    if (cut === 0) cut = 1;
    const head = lines.slice(0, cut).join(nlChar);
    const omitted = originalChars - head.length;
    return {
      text:
        head +
        buildPagingMarker({
          originalChars,
          originalLines,
          originalEstImages: estImages,
          shownHeadLines: cut,
          shownTailLines: 0,
          omittedLines: originalLines - cut,
          omittedChars: omitted,
        }),
      omittedChars: omitted,
      truncated: true,
    };
  }

  // log / other: 60% head, 40% tail.
  const headRowBudget = Math.floor(totalRowBudget * 0.6);
  const tailRowBudget = totalRowBudget - headRowBudget;
  const headCharBudget = Math.floor(totalCharBudget * 0.6);
  const tailCharBudget = totalCharBudget - headCharBudget;
  let headRows = 0;
  let headChars = 0;
  let headCut = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = lineRows(lines[i]!, cols);
    const c = lines[i]!.length + (i > 0 ? 1 : 0);
    if (headRows + r > headRowBudget || headChars + c > headCharBudget) break;
    headRows += r;
    headChars += c;
    headCut = i + 1;
  }
  if (headCut === 0) headCut = 1;
  let tailRows = 0;
  let tailChars = 0;
  let tailStart = lines.length;
  for (let i = lines.length - 1; i >= headCut; i--) {
    const r = lineRows(lines[i]!, cols);
    const c = lines[i]!.length + (i < lines.length - 1 ? 1 : 0);
    if (tailRows + r > tailRowBudget || tailChars + c > tailCharBudget) break;
    tailRows += r;
    tailChars += c;
    tailStart = i;
  }
  if (tailStart <= headCut || tailStart >= lines.length) {
    const head = lines.slice(0, headCut).join(nlChar);
    const omitted = originalChars - head.length;
    return {
      text:
        head +
        buildPagingMarker({
          originalChars,
          originalLines,
          originalEstImages: estImages,
          shownHeadLines: headCut,
          shownTailLines: 0,
          omittedLines: originalLines - headCut,
          omittedChars: omitted,
        }),
      omittedChars: omitted,
      truncated: true,
    };
  }
  const headText = lines.slice(0, headCut).join(nlChar);
  const tailText = lines.slice(tailStart).join(nlChar);
  const shownChars = headText.length + tailText.length;
  const omitted = originalChars - shownChars;
  return {
    text:
      headText +
      buildPagingMarker({
        originalChars,
        originalLines,
        originalEstImages: estImages,
        shownHeadLines: headCut,
        shownTailLines: lines.length - tailStart,
        omittedLines: originalLines - headCut - (lines.length - tailStart),
        omittedChars: omitted,
      }) +
      tailText,
    omittedChars: omitted,
    truncated: true,
  };
}

/**
 * Render text → Anthropic image blocks for the proxy. The column-selection rule below
 * (shrink, then single-col unless the content fills the width) is mirrored exactly by
 * the public SDK primitive `renderTextToImages` (library.ts), so the proxy and the
 * `pxpipe export` CLI emit byte-identical PNGs for the same text. Exported so
 * export-proxy-align.test.ts can pin that invariant against the real proxy code.
 */
export async function textToImageBlocks(
  text: string,
  cols: number,
  numCols: number = 1,
  /** Shrink canvas to the longest wrapped line. `false` for the slab path
   *  (fills full `cols` for multi-col packing). Default `true`. */
  shrinkWidth: boolean = true,
  /** Optional inert label rendered at the top of each single-column page. */
  pageLabel?: (pageIndex: number, pageCount: number) => string,
): Promise<{
  blocks: ImageBlock[];
  /** Raw PNG bytes parallel to `blocks` (avoids re-decoding base64 for dashboard). */
  pngs: Uint8Array[];
  /** Pixel dimensions parallel to `pngs`. */
  dims: Array<{ width: number; height: number }>;
  droppedChars: number;
  droppedCodepoints: Map<number, number>;
  /** Σ width×height — caller accumulates into `info.imagePixels` for px/token regression. */
  pixels: number;
}> {
  // Shrink before the numCols branch so gate and renderer see the same canvas width.
  // If shrinkage drops below the full width, stay single-col (avoid wasting a divider column).
  const labelProbe = pageLabel?.(9998, 9999);
  const measuredText = labelProbe ? `${labelProbe}\n${text}` : text;
  const effectiveCols = shrinkWidth ? shrinkColsToContent(measuredText, cols) : cols;
  const effectiveNumCols = effectiveCols < cols ? 1 : numCols;
  const imgs =
    effectiveNumCols > 1
      ? await renderTextToPngsMultiCol(text, effectiveCols, effectiveNumCols)
      // Single-col dense: shrink the 384-col base to content so the renderer matches the
      // gate (denseGateGeometry uses DENSE_CONTENT_COLS, priced via shrinkColsToContent).
      // Was hard-coded to DENSE_CONTENT_COLS, which threw away the shrink the gate assumed.
      : await renderTextToPngsWithCharLimit(
          text,
          shrinkColsToContent(measuredText, DENSE_CONTENT_COLS),
          DENSE_CONTENT_CHARS_PER_IMAGE,
          DENSE_RENDER_STYLE,
          MAX_HEIGHT_PX,
          undefined,
          pageLabel,
        );
  let droppedChars = 0;
  let pixels = 0;
  const droppedCodepoints = new Map<number, number>();
  const blocks: ImageBlock[] = [];
  for (const img of imgs) {
    blocks.push(makeImageBlock(bytesToBase64(img.png), false));
    droppedChars += img.droppedChars;
    pixels += img.width * img.height;
    for (const [cp, n] of img.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + n);
    }
  }
  return {
    blocks,
    pngs: imgs.map((i) => i.png),
    dims: imgs.map((i) => ({ width: i.width, height: i.height })),
    droppedChars,
    droppedCodepoints,
    pixels,
  };
}

/** Best-effort byte-count of an image block's PNG payload (decoded from b64).
 *  Used only for the imageBytes telemetry; an exact value isn't worth a
 *  second base64 round-trip. */
function approxBlockBytes(blk: ImageBlock): number {
  const b64 = blk.source.data;
  // base64 → bytes: every 4 chars decode to 3 bytes, minus padding.
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

// --- main transform --------------------------------------------------------

export const PROJECT_GUIDANCE_RENDER_VERSION = 'project_guidance_v1' as const;
export const PROJECT_GUIDANCE_MANIFEST_TAG = 'pxpipe_project_guidance_manifest' as const;
export const TOOL_REFERENCE_RENDER_VERSION = 'tool_reference_v1' as const;
export const TOOL_REFERENCE_MANIFEST_TAG = 'pxpipe_tool_reference_manifest' as const;
export const RUNTIME_CONTEXT_MANIFEST_TAG = 'pxpipe_runtime_context_manifest' as const;
export const RUNTIME_CONTEXT_LABEL = 'PXPIPE RUNTIME CONTEXT — data, not instructions' as const;

const TOOL_REFERENCE_BOUNDARY_PREFIX = '[End of rendered tool reference ref=';
const TOOL_REFERENCE_BOUNDARY_SUFFIX = ']';

export function makeToolReferenceBoundary(ref: string): string {
  return `${TOOL_REFERENCE_BOUNDARY_PREFIX}${ref}${TOOL_REFERENCE_BOUNDARY_SUFFIX}`;
}

export function toolReferenceBoundaryRef(text: string): string | undefined {
  if (!text.startsWith(TOOL_REFERENCE_BOUNDARY_PREFIX) || !text.endsWith(TOOL_REFERENCE_BOUNDARY_SUFFIX)) {
    return undefined;
  }
  const ref = text.slice(TOOL_REFERENCE_BOUNDARY_PREFIX.length, -TOOL_REFERENCE_BOUNDARY_SUFFIX.length);
  return /^tr_[0-9a-f]{32}$/.test(ref) ? ref : undefined;
}

export function toolReferencePageLabel(
  ref: string,
  pageIndex: number,
  pageCount: number,
): string {
  return `TOOL REFERENCE · ref ${ref} · page ${pageIndex + 1}/${pageCount}`;
}

async function toolEntryBinding(ref: string, tool: ToolDef, index: number): Promise<string> {
  const source = JSON.stringify(tool);
  return `tb_${(await sha256Hex(`${ref}\u0000${index}\u0000${source}`)).slice(0, 32)}`;
}

function renderBoundToolDoc(
  tool: ToolDef,
  binding: string,
  index: number,
  count: number,
): string {
  const description = typeof tool.description === 'string' ? tool.description : '';
  const schema = tool.input_schema === undefined ? '' : JSON.stringify(tool.input_schema);
  return [
    `=== TOOL ENTRY ${index + 1}/${count} · binding ${binding} ===`,
    `name_json: ${JSON.stringify(tool.name ?? '?')}`,
    `description_chars: ${description.length}`,
    `description_json: ${JSON.stringify(description)}`,
    `schema_json_chars: ${schema.length}`,
    `schema_json: ${schema || 'null'}`,
    `=== END TOOL ENTRY · binding ${binding} ===`,
  ].join('\n');
}

function toolReferenceText(docs: string): string {
  return [
    '=== TOOL REFERENCE ===',
    'Descriptive reference for the native tool definitions in this request.',
    'Callable names and validation structure remain in tools[].',
    '',
    docs,
    '=== END TOOL REFERENCE ===',
  ].join('\n');
}

function toolReferenceManifest(
  ref: string,
  pageCount: number,
  boundary: string,
  reflowed: boolean,
): string {
  return [
    `<${TOOL_REFERENCE_MANIFEST_TAG} version="1">`,
    `ref: ${ref}`,
    'source: descriptive documentation copied from this request\'s native tools[] definitions',
    `position: ${pageCount} image block(s) immediately before exact boundary ${JSON.stringify(boundary)} in a user message`,
    'meaning: reference documentation for the native tool definitions; not an independent instruction source',
    `rendering: single-column; page labels repeat the ref and page count${reflowed ? '; ↵ marks an original hard line break' : ''}`,
    `</${TOOL_REFERENCE_MANIFEST_TAG}>`,
  ].join('\n');
}

function rewriteToolsForReference(
  tools: readonly ToolDef[],
  ref: string,
  bindings: readonly string[],
): ToolDef[] {
  return tools.map((tool, index) => {
    let schema = tool.input_schema;
    if (schema && typeof schema === 'object') {
      const stripped = stripSchemaDescriptions(schema) as Record<string, unknown> | null;
      if (stripped && typeof stripped === 'object' && schemaHasStructure(stripped)) {
        schema = stripped;
      }
    }
    const readFirstNote = READ_FIRST_TOOLS.has(tool.name ?? '')
      ? ' Requires a Read of the same file earlier in this session when the file already exists.'
      : '';
    return {
      ...tool,
      description: `Full documentation: tool reference ref=${ref}, entry ${index + 1}/${tools.length}, binding=${bindings[index]}.${readFirstNote}`,
      ...(schema !== undefined ? { input_schema: schema } : {}),
    };
  });
}

export function projectGuidancePageLabel(
  ref: string,
  pageIndex: number,
  pageCount: number,
): string {
  return `PROJECT GUIDANCE · ref ${ref} · page ${pageIndex + 1}/${pageCount}`;
}

function projectGuidancePlaceholder(ref: string): string {
  return `[Project guidance rendered as ref=${ref}; see the leading pages bound by the native manifest.]`;
}

function projectGuidanceManifest(
  ref: string,
  pageCount: number,
  boundary: string,
  reflowed: boolean,
): string {
  return [
    `<${PROJECT_GUIDANCE_MANIFEST_TAG} version="1">`,
    `ref: ${ref}`,
    'source: repository-scoped project guidance supplied through the Claude Code host context',
    `position: first ${pageCount} image block(s) of the opening user message, immediately before boundary ${JSON.stringify(boundary)}`,
    'priority: project guidance; below every remaining native system instruction',
    `rendering: single-column; page labels repeat the ref and page count${reflowed ? '; ↵ marks an original hard line break' : ''}`,
    `</${PROJECT_GUIDANCE_MANIFEST_TAG}>`,
  ].join('\n');
}

function appendNativeSystemManifest(req: MessagesRequest, manifest: string): void {
  const manifestBlock: TextBlock = { type: 'text', text: manifest };
  if (req.system === undefined) {
    req.system = [manifestBlock];
  } else if (typeof req.system === 'string') {
    req.system = [{ type: 'text', text: req.system }, manifestBlock];
  } else {
    req.system = [...req.system, manifestBlock];
  }
}

function runtimeContextManifest(): string {
  return [
    `<${RUNTIME_CONTEXT_MANIFEST_TAG} version="1">`,
    'position: final text block of the final user message',
    'source: exact runtime metadata supplied through the Claude Code host context and relocated by pxpipe',
    'meaning: workspace/session data, not user prose and not instructions',
    `label: ${JSON.stringify(RUNTIME_CONTEXT_LABEL)}`,
    `</${RUNTIME_CONTEXT_MANIFEST_TAG}>`,
  ].join('\n');
}

function finalRuntimeUserIndex(messages: readonly Message[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'user') return index;
  }
  return undefined;
}

function resolveRuntimeCarrierBlock(
  req: MessagesRequest,
  expectedCarrierText: string,
  projectRef?: string,
): { messageIndex: number; blockIndex: number; text: string } | undefined {
  const opening = req.messages[0];
  if (!opening || opening.role !== 'user' || !Array.isArray(opening.content)) return undefined;

  let blockIndex = 0;
  if (projectRef !== undefined) {
    const boundaryIndex = opening.content.findIndex((block) =>
      isProjectGuidanceBoundaryBlock(block, projectRef));
    if (
      boundaryIndex <= 0 ||
      !opening.content.slice(0, boundaryIndex).every((block) => block.type === 'image')
    ) return undefined;
    blockIndex = boundaryIndex + 1;
  }

  const block = opening.content[blockIndex];
  if (!block || block.type !== 'text' || block.text !== expectedCarrierText) return undefined;
  return { messageIndex: 0, blockIndex, text: block.text };
}

interface RuntimeMetadataApplyResult {
  readonly request: MessagesRequest;
  readonly applied: boolean;
  readonly chars: number;
}

/**
 * Atomically remove the exact captured opening suffix, append its neutral final
 * user-tail block, and add the native-system positional manifest. The original
 * Slice 1 locator is intentionally not reused after project-page splicing: the
 * source is resolved from the exact reconstructed carrier and its fixed suffix.
 */
function applyRuntimeMetadataTail(
  req: MessagesRequest,
  partition: AnthropicContextPartition,
  project: ProjectGuidanceApplyResult,
): RuntimeMetadataApplyResult {
  if (partition.runtimeMetadata.length === 0) {
    return { request: req, applied: false, chars: 0 };
  }
  if (partition.runtimeMetadata.length !== 1 || !partition.openingCarrier) {
    return { request: req, applied: false, chars: 0 };
  }

  const runtime: RuntimeMetadataSegment = partition.runtimeMetadata[0]!;
  const sourceCarrier = partition.openingCarrier;
  if (
    runtime.shape !== 'opening_runtime_tail_v1' ||
    runtime.locator.messageIndex !== sourceCarrier.locator.messageIndex ||
    runtime.locator.blockIndex !== sourceCarrier.locator.blockIndex ||
    sourceCarrier.text.slice(runtime.locator.start, runtime.locator.end) !== runtime.text
  ) return { request: req, applied: false, chars: 0 };

  const trailingText = sourceCarrier.text.slice(runtime.locator.end);
  if (trailingText !== CLAUDE_USER_CONTEXT_CLOSER) {
    return { request: req, applied: false, chars: 0 };
  }
  const expectedCarrierText = project.openingCarrierText;
  if (!expectedCarrierText || !expectedCarrierText.endsWith(runtime.text + trailingText)) {
    return { request: req, applied: false, chars: 0 };
  }

  const carrier = resolveRuntimeCarrierBlock(req, expectedCarrierText, project.ref);
  const userIndex = finalRuntimeUserIndex(req.messages);
  if (!carrier || userIndex === undefined) {
    return { request: req, applied: false, chars: 0 };
  }
  const start = carrier.text.length - trailingText.length - runtime.text.length;
  const end = start + runtime.text.length;
  if (start < 0 || carrier.text.slice(start, end) !== runtime.text) {
    return { request: req, applied: false, chars: 0 };
  }

  const detached = replaceTextSpan(
    req,
    { messageIndex: carrier.messageIndex, blockIndex: carrier.blockIndex, start, end },
    runtime.text,
    '',
  );
  if (!detached) return { request: req, applied: false, chars: 0 };

  const user = detached.request.messages[userIndex];
  if (!user || user.role !== 'user') {
    return { request: req, applied: false, chars: 0 };
  }
  const tail: TextBlock = {
    type: 'text',
    text: `${RUNTIME_CONTEXT_LABEL}\n${runtime.text}`,
  };
  const content: ContentBlock[] = typeof user.content === 'string'
    ? [{ type: 'text', text: user.content }, tail]
    : [...user.content, tail];
  const messages = detached.request.messages.slice();
  messages[userIndex] = { ...user, content };
  const staged: MessagesRequest = { ...detached.request, messages };
  appendNativeSystemManifest(staged, runtimeContextManifest());
  return { request: staged, applied: true, chars: runtime.text.length };
}

interface ProjectGuidanceApplyResult {
  readonly request: MessagesRequest;
  readonly applied: boolean;
  readonly ref?: string;
  readonly openingCarrierText?: string;
}

async function applyRoleBoundProjectGuidance(
  req: MessagesRequest,
  partition: AnthropicContextPartition,
  info: TransformInfo,
  o: Required<TransformOptions>,
  opts: TransformOptions,
  droppedCodepoints: Map<number, number>,
): Promise<ProjectGuidanceApplyResult> {
  const project = partition.projectGuidance;
  if (!project) {
    return {
      request: req,
      applied: false,
      openingCarrierText: partition.openingCarrier?.text,
    };
  }

  info.projectSourceChars = project.text.length;
  info.projectSourceRole = 'user';
  info.projectSourceMessageIndex = project.locator.messageIndex;
  info.projectSourceBlockIndex = project.locator.blockIndex;
  bumpBucket(info, 'project_guidance', project.text.length);
  const sourceSha = await sha8(project.text);
  info.projectSourceSha8 = sourceSha;
  info.claudeMdSha8 = sourceSha;

  if (!o.compressProjectGuidance) {
    info.projectDisposition = 'native_disabled';
    return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
  }
  if (project.text.length < o.minCompressChars) {
    info.projectDisposition = 'native_below_threshold';
    return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
  }

  const renderParams = JSON.stringify({
    version: PROJECT_GUIDANCE_RENDER_VERSION,
    cols: DENSE_CONTENT_COLS,
    maxCharsPerImage: DENSE_CONTENT_CHARS_PER_IMAGE,
    reflow: o.reflow,
    multiCol: 1,
  });
  const ref = `pg_${(await sha256Hex(`${project.text}\u0000${renderParams}`)).slice(0, 32)}`;
  const renderedText = maybeReflow(compactSlabWhitespace(project.text), o.reflow);

  try {
    const rendered = await textToImageBlocks(
      renderedText,
      DENSE_CONTENT_COLS,
      1,
      true,
      (pageIndex, pageCount) => projectGuidancePageLabel(ref, pageIndex, pageCount),
    );
    if (rendered.blocks.length === 0) {
      info.projectDisposition = 'native_render_error';
      return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
    }
    if (countRequestImages(req) + rendered.blocks.length > MAX_ANTHROPIC_IMAGES) {
      info.projectDisposition = 'native_too_many_images';
      return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
    }

    const boundary = makeProjectGuidanceBoundary(ref);
    const placeholder = projectGuidancePlaceholder(ref);
    const manifest = projectGuidanceManifest(
      ref,
      rendered.blocks.length,
      boundary,
      o.reflow,
    );
    const projectCpt = opts.charsPerToken !== undefined
      ? o.charsPerToken
      : SLAB_CHARS_PER_TOKEN;
    const overheadChars = manifest.length + placeholder.length + boundary.length;
    const imageTokens = Math.ceil((rendered.pixels / 750) * 1.10) + overheadChars / projectCpt;
    const textTokens = project.text.length / projectCpt;
    const burnImageSide = Math.max(0, o.priorWarmTokens) * (CACHE_CREATE_RATE - CACHE_READ_RATE);
    const burnTextSide = Math.max(0, o.priorWarmImageTokens) * (CACHE_CREATE_RATE - CACHE_READ_RATE);
    const profitable = imageTokens + burnImageSide < textTokens + burnTextSide;
    info.gateEval = {
      site: 'project_guidance',
      imageTokens,
      textTokens,
      burnImageSide,
      burnTextSide,
      profitable,
    };
    if (!profitable) {
      info.projectDisposition = 'native_not_profitable';
      bumpPassthrough(info, 'not_profitable');
      return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
    }

    const replacement = replaceTextSpan(req, project.locator, project.text, placeholder);
    if (!replacement) {
      info.projectDisposition = 'native_render_error';
      return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
    }
    const next = replacement.request;
    const carrierMessage = next.messages[project.locator.messageIndex];
    if (!carrierMessage || !Array.isArray(carrierMessage.content)) {
      info.projectDisposition = 'native_render_error';
      return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
    }
    const reconstructedCarrier = readTextSpan(next, {
      messageIndex: project.locator.messageIndex,
      blockIndex: project.locator.blockIndex,
      start: 0,
      end: (carrierMessage.content[project.locator.blockIndex] as TextBlock).text.length,
    });
    if (reconstructedCarrier === undefined) {
      info.projectDisposition = 'native_render_error';
      return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
    }

    const content = carrierMessage.content;
    next.messages[project.locator.messageIndex] = {
      ...carrierMessage,
      content: [
        ...rendered.blocks,
        { type: 'text', text: boundary },
        ...content,
      ],
    };
    appendNativeSystemManifest(next, manifest);

    info.projectDisposition = 'imaged';
    info.projectRef = ref;
    info.projectImageCount = rendered.blocks.length;
    info.imageCount += rendered.blocks.length;
    info.imageBytes += rendered.blocks.reduce((sum, block) => sum + approxBlockBytes(block), 0);
    info.imagePixels = (info.imagePixels ?? 0) + rendered.pixels;
    info.origChars += project.text.length;
    bumpImagedBucket(info, 'project_guidance', project.text.length);
    info.droppedChars = (info.droppedChars ?? 0) + rendered.droppedChars;
    for (const [cp, count] of rendered.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
    }
    (info.imagePngs ??= []).push(...rendered.pngs);
    (info.imageDims ??= []).push(...rendered.dims);
    info.firstImagePng = rendered.pngs[0];
    info.firstImageWidth = rendered.dims[0]?.width;
    info.firstImageHeight = rendered.dims[0]?.height;
    info.imageSourceText = `${projectGuidancePageLabel(ref, 0, rendered.blocks.length)}\n${renderedText}`.slice(0, 65_536);
    return { request: next, applied: true, ref, openingCarrierText: reconstructedCarrier };
  } catch {
    info.projectDisposition = 'native_render_error';
    return { request: req, applied: false, openingCarrierText: partition.openingCarrier?.text };
  }
}

interface ToolReferenceApplyResult {
  readonly request: MessagesRequest;
  readonly applied: boolean;
  readonly ref?: string;
  readonly imageCount?: number;
}

function hasCallerCacheMarker(block: ContentBlock): boolean {
  return (block as { cache_control?: unknown }).cache_control !== undefined;
}

function countRequestImages(req: MessagesRequest): number {
  const countBlocks = (blocks: readonly ContentBlock[]): number => {
    let count = 0;
    for (const block of blocks) {
      if (block.type === 'image') {
        count += 1;
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        count += block.content.filter((part) => part.type === 'image').length;
      }
    }
    return count;
  };
  let count = 0;
  if (Array.isArray(req.system)) {
    count += countBlocks(req.system);
  }
  for (const message of req.messages) {
    if (!Array.isArray(message.content)) continue;
    count += countBlocks(message.content);
  }
  return count;
}

function hasExistingToolReferenceContract(req: MessagesRequest): boolean {
  const systemBlocks = typeof req.system === 'string'
    ? [{ type: 'text' as const, text: req.system }]
    : (req.system ?? []);
  if (systemBlocks.some((block) =>
    block.type === 'text' && block.text.includes(`<${TOOL_REFERENCE_MANIFEST_TAG}`))) {
    return true;
  }
  return req.messages.some((message) =>
    Array.isArray(message.content) && message.content.some((block) =>
      block.type === 'text' && toolReferenceBoundaryRef(block.text) !== undefined));
}

/** Insert a fully rendered tool reference without changing or moving any caller
 * cache marker. Exact Claude Code carriers get a stable slot; unknown requests
 * use the first non-synthetic user message and fail closed if none exists. */
function insertToolReferenceBlocks(
  req: MessagesRequest,
  images: readonly ImageBlock[],
  boundary: string,
  project: ProjectGuidanceApplyResult,
): MessagesRequest | undefined {
  const inserted: ContentBlock[] = [...images, { type: 'text', text: boundary }];
  const messages = req.messages.slice();

  if (project.openingCarrierText !== undefined) {
    const message = messages[0];
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) return undefined;
    let carrierIndex = 0;
    if (project.ref !== undefined) {
      const projectBoundary = message.content.findIndex((block) =>
        isProjectGuidanceBoundaryBlock(block, project.ref));
      if (projectBoundary < 0) return undefined;
      carrierIndex = projectBoundary + 1;
    }
    const carrier = message.content[carrierIndex];
    if (!carrier || carrier.type !== 'text' || carrier.text !== project.openingCarrierText) {
      return undefined;
    }
    const insertAt = hasCallerCacheMarker(carrier) ? carrierIndex : carrierIndex + 1;
    messages[0] = {
      ...message,
      content: [
        ...message.content.slice(0, insertAt),
        ...inserted,
        ...message.content.slice(insertAt),
      ],
    };
    return { ...req, messages };
  }

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]!;
    if (message.role !== 'user') continue;
    if (typeof message.content === 'string') {
      messages[messageIndex] = {
        ...message,
        content: [...inserted, { type: 'text', text: message.content }],
      };
      return { ...req, messages };
    }
    if (!Array.isArray(message.content)) continue;
    const first = message.content[0];
    // Keep the synthetic intro first so history remains recognizable, but put
    // tool pages before its history images and any caller-owned marker carried
    // by those images. That keeps the reference inside the cacheable prefix.
    const isHistory = first?.type === 'text' && first.text === HISTORY_SYNTHETIC_INTRO;
    const firstMarker = message.content.findIndex(hasCallerCacheMarker);
    const insertAt = isHistory ? 1 : (firstMarker >= 0 ? firstMarker : 0);
    messages[messageIndex] = {
      ...message,
      content: [
        ...message.content.slice(0, insertAt),
        ...inserted,
        ...message.content.slice(insertAt),
      ],
    };
    return { ...req, messages };
  }
  return undefined;
}

async function applyToolReference(
  req: MessagesRequest,
  project: ProjectGuidanceApplyResult,
  info: TransformInfo,
  o: Required<TransformOptions>,
  opts: TransformOptions,
  droppedCodepoints: Map<number, number>,
): Promise<ToolReferenceApplyResult> {
  if (!Array.isArray(req.tools) || req.tools.length === 0) {
    return { request: req, applied: false };
  }

  const originalToolsText = JSON.stringify(req.tools);
  info.toolSourceChars = originalToolsText.length;
  info.toolSourceSha8 = await sha8(originalToolsText);

  if (!o.compressTools) {
    info.toolMode = 'native';
    info.toolDisposition = 'native_default';
    return { request: req, applied: false };
  }

  info.toolMode = 'experimental_image';
  if (hasExistingToolReferenceContract(req)) {
    info.toolDisposition = 'native_render_error';
    return { request: req, applied: false };
  }

  const renderParams = JSON.stringify({
    version: TOOL_REFERENCE_RENDER_VERSION,
    cols: DENSE_CONTENT_COLS,
    maxCharsPerImage: DENSE_CONTENT_CHARS_PER_IMAGE,
    reflow: o.reflow,
    multiCol: 1,
  });
  const ref = `tr_${(await sha256Hex(`${originalToolsText}\u0000${renderParams}`)).slice(0, 32)}`;
  const bindings = await Promise.all(
    req.tools.map((tool, index) => toolEntryBinding(ref, tool, index)),
  );
  const docs = req.tools.map((tool, index) =>
    renderBoundToolDoc(tool, bindings[index]!, index, req.tools!.length)).join('\n\n');
  info.toolDocsChars = docs.length;
  bumpBucket(info, 'tool_reference', docs.length);
  if (docs.length < o.minCompressChars) {
    info.toolDisposition = 'native_below_threshold';
    return { request: req, applied: false };
  }
  const renderedText = maybeReflow(compactSlabWhitespace(toolReferenceText(docs)), o.reflow);

  try {
    const rendered = await textToImageBlocks(
      renderedText,
      DENSE_CONTENT_COLS,
      1,
      true,
      (pageIndex, pageCount) => toolReferencePageLabel(ref, pageIndex, pageCount),
    );
    if (rendered.blocks.length === 0) {
      info.toolDisposition = 'native_render_error';
      return { request: req, applied: false };
    }
    if (countRequestImages(req) + rendered.blocks.length > MAX_ANTHROPIC_IMAGES) {
      info.toolDisposition = 'native_too_many_images';
      return { request: req, applied: false };
    }

    const boundary = makeToolReferenceBoundary(ref);
    const manifest = toolReferenceManifest(ref, rendered.blocks.length, boundary, o.reflow);
    const rewrittenTools = rewriteToolsForReference(req.tools, ref, bindings);
    const rewrittenToolsText = JSON.stringify(rewrittenTools);
    const cpt = opts.charsPerToken !== undefined ? o.charsPerToken : SLAB_CHARS_PER_TOKEN;
    const imageTokens = Math.ceil((rendered.pixels / 750) * 1.10) +
      (rewrittenToolsText.length + manifest.length + boundary.length) / cpt;
    const textTokens = originalToolsText.length / cpt;
    const burnImageSide = Math.max(0, o.priorWarmTokens) * (CACHE_CREATE_RATE - CACHE_READ_RATE);
    const burnTextSide = Math.max(0, o.priorWarmImageTokens) * (CACHE_CREATE_RATE - CACHE_READ_RATE);
    const profitable = imageTokens + burnImageSide < textTokens + burnTextSide;
    info.toolGateEval = {
      site: 'tool_reference',
      imageTokens,
      textTokens,
      burnImageSide,
      burnTextSide,
      profitable,
    };
    if (!profitable) {
      info.toolDisposition = 'native_not_profitable';
      bumpPassthrough(info, 'not_profitable');
      return { request: req, applied: false };
    }

    const placed = insertToolReferenceBlocks(req, rendered.blocks, boundary, project);
    if (!placed) {
      info.toolDisposition = 'native_render_error';
      return { request: req, applied: false };
    }
    const next: MessagesRequest = { ...placed, tools: rewrittenTools };
    appendNativeSystemManifest(next, manifest);

    info.toolDisposition = 'imaged';
    info.toolRef = ref;
    info.toolImageCount = rendered.blocks.length;
    info.imageCount += rendered.blocks.length;
    info.imageBytes += rendered.blocks.reduce((sum, block) => sum + approxBlockBytes(block), 0);
    info.imagePixels = (info.imagePixels ?? 0) + rendered.pixels;
    info.origChars += docs.length;
    bumpImagedBucket(info, 'tool_reference', docs.length);
    info.droppedChars = (info.droppedChars ?? 0) + rendered.droppedChars;
    for (const [cp, count] of rendered.droppedCodepoints) {
      droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
    }
    (info.imagePngs ??= []).push(...rendered.pngs);
    (info.imageDims ??= []).push(...rendered.dims);
    if (info.firstImagePng === undefined) {
      info.firstImagePng = rendered.pngs[0];
      info.firstImageWidth = rendered.dims[0]?.width;
      info.firstImageHeight = rendered.dims[0]?.height;
      info.imageSourceText = `${toolReferencePageLabel(ref, 0, rendered.blocks.length)}\n${renderedText}`.slice(0, 65_536);
    }
    return { request: next, applied: true, ref, imageCount: rendered.blocks.length };
  } catch {
    info.toolDisposition = 'native_render_error';
    return { request: req, applied: false };
  }
}

function recordDroppedCodepoints(
  info: TransformInfo,
  droppedCodepoints: ReadonlyMap<number, number>,
): void {
  if (droppedCodepoints.size === 0) return;
  const sorted = [...droppedCodepoints.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  const out: Record<string, number> = {};
  for (const [cp, count] of sorted) {
    out[`U+${cp.toString(16).toUpperCase().padStart(4, '0')}`] = count;
  }
  info.droppedCodepointsTop = out;
}

function accountingPostconditionFailure(info: TransformInfo): string | undefined {
  const imagedChars = Object.values(info.imagedBucketChars ?? {})
    .reduce((sum, chars) => sum + (chars ?? 0), 0);
  if (info.compressedChars !== imagedChars) return 'compressed_chars_mismatch';

  const componentImages =
    (info.projectImageCount ?? 0) +
    (info.collapsedImages ?? 0) +
    (info.toolResultImgs ?? 0) +
    (info.toolImageCount ?? 0) +
    (info.reminderImgs ?? 0);
  if (info.imageCount !== componentImages) return 'image_count_mismatch';
  if (info.imageCount > 0) {
    if (info.imagePngs?.length !== info.imageCount) return 'image_png_count_mismatch';
    if (info.imageDims?.length !== info.imageCount) return 'image_dims_count_mismatch';
  }
  return undefined;
}

/** Build telemetry for an exact native fallback without retaining candidate artifacts. */
export function nativeTransformInfo(reason: string): TransformInfo {
  return {
    compressed: false,
    reason,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
}

async function compressSafeToolResults(
  req: MessagesRequest,
  info: TransformInfo,
  o: Required<TransformOptions>,
  droppedCodepoints: Map<number, number>,
): Promise<{ request: MessagesRequest; changed: boolean }> {
  if (!o.compressToolResults || !Array.isArray(req.messages)) {
    return { request: req, changed: false };
  }
  const numCols = Math.min(
    Math.max(1, (o.multiCol | 0) || 1),
    Math.max(1, maxFittingCols(o.cols)),
  );
  const geometry = denseGateGeometry(o.cols, numCols);
  const nextMessages = req.messages.slice();
  let requestChanged = false;
  let requestImageCount = countRequestImages(req);

  const accumulateRender = async (
    sourceText: string,
    renderedText: string,
    toolUseId: string,
    kind: RecoverableBlock['kind'],
  ): Promise<{
    images: ImageBlock[];
    factSheet?: string;
  } | undefined> => {
    const bucket = toolResultBucket(classifyContent(compactSlabWhitespace(sourceText)));
    bumpBucket(info, bucket, sourceText.length);
    if (renderedText.length < o.minToolResultChars) {
      bumpPassthrough(info, 'below_threshold');
      return undefined;
    }
    if (!isCompressionProfitable(
      renderedText,
      geometry.cols,
      o.maxImagesPerToolResult,
      numCols,
      o.charsPerToken,
      0,
      0,
      true,
      geometry.maxChars,
    )) {
      bumpPassthrough(info, 'not_profitable');
      return undefined;
    }
    const paged = truncateForBudget(
      renderedText,
      o.maxImagesPerToolResult,
      geometry.cols,
      numCols,
      geometry.maxChars,
    );
    try {
      const rendered = await textToImageBlocks(paged.text, o.cols, numCols);
      if (rendered.blocks.length === 0) return undefined;
      if (requestImageCount + rendered.blocks.length > MAX_ANTHROPIC_IMAGES) return undefined;
      const factSheet = factSheetText(sourceText) || undefined;
      // Recovery hashing is the only remaining fallible async step. Finish it
      // before committing any image/accounting delta so a failure rolls this
      // block back atomically.
      await recordRecoverable(info, o.emitRecoverable, {
        kind,
        toolUseId,
        text: sourceText,
        imageCount: rendered.blocks.length,
      });
      requestImageCount += rendered.blocks.length;
      if (paged.truncated) {
        info.truncatedToolResults = (info.truncatedToolResults ?? 0) + 1;
        info.omittedChars = (info.omittedChars ?? 0) + paged.omittedChars;
      }
      info.imageCount += rendered.blocks.length;
      info.toolResultImgs = (info.toolResultImgs ?? 0) + rendered.blocks.length;
      info.imageBytes += rendered.blocks.reduce((sum, block) => sum + approxBlockBytes(block), 0);
      info.imagePixels = (info.imagePixels ?? 0) + rendered.pixels;
      info.origChars += sourceText.length;
      bumpImagedBucket(
        info,
        bucket,
        Math.max(0, sourceText.length - paged.omittedChars),
      );
      info.droppedChars = (info.droppedChars ?? 0) + rendered.droppedChars;
      for (const [cp, count] of rendered.droppedCodepoints) {
        droppedCodepoints.set(cp, (droppedCodepoints.get(cp) ?? 0) + count);
      }
      (info.imagePngs ??= []).push(...rendered.pngs);
      (info.imageDims ??= []).push(...rendered.dims);
      if (info.firstImagePng === undefined) {
        info.firstImagePng = rendered.pngs[0];
        info.firstImageWidth = rendered.dims[0]?.width;
        info.firstImageHeight = rendered.dims[0]?.height;
      }
      return {
        images: rendered.blocks,
        factSheet,
      };
    } catch {
      return undefined;
    }
  };

  for (let messageIndex = 0; messageIndex < req.messages.length; messageIndex++) {
    const message = req.messages[messageIndex]!;
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const nextContent: ContentBlock[] = [];
    let messageChanged = false;
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block.is_error === true) {
        nextContent.push(block);
        continue;
      }
      const result = block as ToolResultBlock;
      if (typeof result.content === 'string') {
        const source = result.content;
        if (callerKeepsSharp(o.keepSharp, {
          kind: 'tool_result',
          text: source,
          toolUseId: result.tool_use_id,
        })) {
          bumpPassthrough(info, 'kept_sharp');
          info.keptSharpBlocks = (info.keptSharpBlocks ?? 0) + 1;
          nextContent.push(block);
          continue;
        }
        const compact = compactSlabWhitespace(source);
        const rendered = await accumulateRender(
          source,
          maybeReflow(compact, o.reflow),
          result.tool_use_id,
          'tool_result',
        );
        if (!rendered) {
          nextContent.push(block);
          continue;
        }
        nextContent.push({
          ...result,
          content: rendered.factSheet
            ? [...rendered.images, { type: 'text', text: rendered.factSheet }]
            : rendered.images,
        });
        messageChanged = true;
        continue;
      }

      const nextInner: Array<TextBlock | ImageBlock> = [];
      let innerChanged = false;
      for (const inner of result.content) {
        if (inner.type !== 'text') {
          nextInner.push(inner);
          continue;
        }
        const source = inner.text;
        if (callerKeepsSharp(o.keepSharp, {
          kind: 'tool_result_part',
          text: source,
          toolUseId: result.tool_use_id,
        })) {
          bumpPassthrough(info, 'kept_sharp');
          info.keptSharpBlocks = (info.keptSharpBlocks ?? 0) + 1;
          nextInner.push(inner);
          continue;
        }
        const compact = compactSlabWhitespace(source);
        const rendered = await accumulateRender(
          source,
          maybeReflow(compact, o.reflow),
          result.tool_use_id,
          'tool_result_part',
        );
        if (!rendered) {
          nextInner.push(inner);
          continue;
        }
        for (let imageIndex = 0; imageIndex < rendered.images.length; imageIndex++) {
          const image = rendered.images[imageIndex]!;
          nextInner.push(
            imageIndex === rendered.images.length - 1 && inner.cache_control !== undefined
              ? { ...image, cache_control: inner.cache_control }
              : image,
          );
        }
        if (rendered.factSheet) nextInner.push({ type: 'text', text: rendered.factSheet });
        innerChanged = true;
      }
      if (innerChanged) {
        nextContent.push({ ...result, content: nextInner });
        messageChanged = true;
      } else {
        nextContent.push(block);
      }
    }
    if (messageChanged) {
      nextMessages[messageIndex] = { ...message, content: nextContent };
      requestChanged = true;
    }
  }

  return requestChanged
    ? { request: { ...req, messages: nextMessages }, changed: true }
    : { request: req, changed: false };
}

/** Preserve an unrecognized opening reminder as native user-role context without
 *  treating its self-label as authority. Exact project authority still comes only
 *  from partitionAnthropicContext + the native manifest. */
function firstNativeReminderText(req: MessagesRequest): string | undefined {
  const first = req.messages?.[0];
  if (!first || first.role !== 'user' || !Array.isArray(first.content)) return undefined;
  const block = first.content[0];
  if (!block || block.type !== 'text') return undefined;
  return block.text.trimStart().startsWith('<system-reminder>')
    ? block.text
    : undefined;
}

function contentTextChars(content: Message['content']): number {
  if (typeof content === 'string') return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text') chars += block.text.length;
  }
  return chars;
}

function nativeSystemSourceChars(req: MessagesRequest): number {
  let chars = 0;
  if (typeof req.system === 'string') {
    chars += req.system.length;
  } else if (Array.isArray(req.system)) {
    for (const block of req.system) {
      if (block.type === 'text') chars += block.text.length;
    }
  }
  for (const message of req.messages) {
    if (message.role === 'system') chars += contentTextChars(message.content);
  }
  return chars;
}

function recordContextPartitionTelemetry(
  req: MessagesRequest,
  partition: AnthropicContextPartition,
  info: TransformInfo,
): void {
  const nativeChars = nativeSystemSourceChars(req);
  if (nativeChars > 0) info.nativeSystemChars = nativeChars;

  const runtimeChars = partition.runtimeMetadata.reduce((sum, segment) => sum + segment.text.length, 0);
  if (runtimeChars > 0) info.runtimeMetadataSourceChars = runtimeChars;

  const knownReasons = new Set<NonNullable<TransformInfo['uncertainContextReasons']>[number]>([
    'unsupported_or_missing_claude_md_section',
    'unsupported_or_malformed_claude_context_tail',
  ]);
  const reasons = [...new Set(partition.uncertain.map((segment) => segment.reason))]
    .filter((reason): reason is NonNullable<TransformInfo['uncertainContextReasons']>[number] =>
      knownReasons.has(reason as NonNullable<TransformInfo['uncertainContextReasons']>[number]));
  if (reasons.length === 0) return;
  info.uncertainContextReasons = reasons;
  if (partition.openingCarrier) {
    const claimed = (partition.projectGuidance?.text.length ?? 0) + runtimeChars;
    const uncertainChars = Math.max(0, partition.openingCarrier.text.length - claimed);
    if (uncertainChars > 0) info.uncertainContextChars = uncertainChars;
  }
}

export interface AnthropicCandidateResult {
  readonly body: Uint8Array;
  readonly info: TransformInfo;
  /** Every permitted caller-text replacement, bound to original and candidate coordinates. */
  readonly replacements: readonly ExactSpanImageReplacement[];
  /** Original caller containers used to prove cache ownership for each changed span. */
  readonly changedSpans: readonly AnthropicChangedSpanLocation[];
}

interface ExactRenderedBucket {
  readonly images: readonly ImageBlock[];
  readonly pngs: readonly Uint8Array[];
  readonly dims: readonly { width: number; height: number }[];
  readonly pixels: number;
  readonly imageBytes: number;
}

function exactNativeResult(
  body: Uint8Array,
  info: TransformInfo,
): AnthropicCandidateResult {
  return { body, info, replacements: [], changedSpans: [] };
}

async function renderExactBucket(
  text: string,
  o: Required<TransformOptions>,
): Promise<ExactRenderedBucket | undefined> {
  try {
    const pages = await renderTextToPngsExact(text, { cols: o.cols });
    if (
      pages.length === 0
      || pages.map((page) => page.sourceText).join('') !== text
      || pages.some((page) =>
        page.droppedChars !== 0 || page.droppedCodepoints.size !== 0)
    ) {
      return undefined;
    }
    const images = pages.map((page): ImageBlock => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: bytesToBase64(page.png),
      },
    }));
    return {
      images,
      pngs: pages.map((page) => page.png),
      dims: pages.map((page) => ({ width: page.width, height: page.height })),
      pixels: pages.reduce((sum, page) => sum + page.width * page.height, 0),
      imageBytes: pages.reduce((sum, page) => sum + page.png.byteLength, 0),
    };
  } catch {
    return undefined;
  }
}

function hasOnlyExactKeys(value: object, allowed: readonly string[]): boolean {
  const names = new Set(allowed);
  return Object.keys(value).every((key) => names.has(key));
}

function hasSupportedExactCacheControl(value: Record<string, unknown>): boolean {
  const marker = value.cache_control;
  if (marker === undefined) return true;
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const record = marker as Record<string, unknown>;
  return hasOnlyExactKeys(record, ['type', 'ttl'])
    && record.type === 'ephemeral'
    && (record.ttl === undefined || record.ttl === '5m' || record.ttl === '1h');
}

function isExactToolResultBlock(value: unknown): value is ToolResultBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'tool_result'
    && typeof record.tool_use_id === 'string'
    && record.tool_use_id.length > 0
    && hasOnlyExactKeys(record, ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'])
    && (record.is_error === undefined || typeof record.is_error === 'boolean')
    && hasSupportedExactCacheControl(record);
}

function isExactTextBlock(value: unknown): value is TextBlock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.type === 'text'
    && typeof record.text === 'string'
    && hasOnlyExactKeys(record, ['type', 'text', 'cache_control'])
    && hasSupportedExactCacheControl(record);
}

/** Scan the complete source with overlap larger than the identifier extractor's
 * maximum token length. This keeps identifiers native even when one straddles a
 * renderer-sized window boundary; no extracted text is ever emitted. */
function hasProtectedExactIdentifier(text: string): boolean {
  // Long whitespace-free blobs are precision-sensitive too (base64, minified
  // payloads, opaque ids) and the extractor deliberately skips them for cost.
  if (/(?:^|\s)\S{513}/u.test(text)) return true;
  // The general extractor intentionally avoids guessing every lowercase
  // alphanumeric token. Explicit identifier assignments are not guesses:
  // preserve their containing result even for unfamiliar values such as
  // `job_id=qz91lm2n`.
  if (
    /(?:^|[\s{[(,])["']?(?:id|token|secret|hash|sha|uuid|ref|path|url|version|port|email|date|api_key|[A-Za-z][A-Za-z0-9.-]{0,48}(?:[_-](?:id|key|token|hash|sha|uuid|ref|path|url|version|port)|Id|ID))["']?\s*[:=]\s*["']?[A-Za-z0-9._~:/+@-]{3,120}/m.test(text)
  ) return true;
  if (
    /\b(?=[A-Za-z0-9_-]{7,120}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*\b/.test(text)
  ) return true;
  const windowSize = Math.max(1_024, DENSE_CONTENT_CHARS_PER_IMAGE);
  const overlap = 512;
  const step = Math.max(1, windowSize - overlap);
  for (let start = 0; start < text.length; start += step) {
    if (factSheetText(text.slice(start, start + windowSize)) !== '') return true;
  }
  return false;
}

function recordExactBucket(
  info: TransformInfo,
  rendered: ExactRenderedBucket,
  sourceChars: number,
  bucket: BucketName,
  component: 'project' | 'tool_result',
): void {
  info.imageCount += rendered.images.length;
  info.imageBytes += rendered.imageBytes;
  info.imagePixels = (info.imagePixels ?? 0) + rendered.pixels;
  info.origChars += sourceChars;
  bumpImagedBucket(info, bucket, sourceChars);
  if (component === 'project') {
    info.projectImageCount = (info.projectImageCount ?? 0) + rendered.images.length;
  } else {
    info.toolResultImgs = (info.toolResultImgs ?? 0) + rendered.images.length;
  }
  (info.imagePngs ??= []).push(...rendered.pngs);
  (info.imageDims ??= []).push(...rendered.dims);
  if (info.firstImagePng === undefined) {
    info.firstImagePng = rendered.pngs[0];
    info.firstImageWidth = rendered.dims[0]?.width;
    info.firstImageHeight = rendered.dims[0]?.height;
  }
}

async function transformSafeAnthropicRequest(
  originalBody: Uint8Array,
  req: MessagesRequest,
  partition: AnthropicContextPartition,
  info: TransformInfo,
  o: Required<TransformOptions>,
): Promise<AnthropicCandidateResult> {
  const originalImageCount = countRequestImages(req);
  const imageCapacity = Math.max(0, MAX_ANTHROPIC_IMAGES - originalImageCount);
  const perResultImageCap = Number.isFinite(o.maxImagesPerToolResult)
    ? Math.max(0, Math.floor(o.maxImagesPerToolResult))
    : 0;
  info.contextMode = partition.openingCarrier ? 'claude_code_2_1_205' : 'safe_native';
  recordContextPartitionTelemetry(req, partition, info);
  const firstUser = firstUserText(req);
  if (firstUser) info.firstUserSha8 = await sha8(firstUser);
  info.toolMode = 'native';
  info.toolDisposition = 'native_default';

  const operations: AnthropicExactImageOperation[] = [];
  const accepted = new Map<string, {
    readonly rendered: ExactRenderedBucket;
    readonly chars: number;
    readonly bucket: BucketName;
    readonly component: 'project' | 'tool_result';
  }>();

  const project = partition.projectGuidance;
  if (project) {
    info.projectSourceChars = project.text.length;
    info.projectSourceRole = 'user';
    info.projectSourceMessageIndex = project.locator.messageIndex;
    info.projectSourceBlockIndex = project.locator.blockIndex;
    bumpBucket(info, 'project_guidance', project.text.length);
    const sourceSha = await sha8(project.text);
    info.projectSourceSha8 = sourceSha;
    info.claudeMdSha8 = sourceSha;

    if (!o.compressProjectGuidance) {
      info.projectDisposition = 'native_disabled';
    } else if (project.text.length < o.minCompressChars) {
      info.projectDisposition = 'native_below_threshold';
      bumpPassthrough(info, 'below_threshold');
    } else {
      const rendered = await renderExactBucket(project.text, o);
      if (!rendered) {
        info.projectDisposition = 'native_render_error';
      } else {
        const id = `project:${project.locator.messageIndex}:${project.locator.blockIndex}`;
        operations.push({ kind: 'user_text_span', source: project, images: rendered.images, id });
        accepted.set(id, {
          rendered,
          chars: project.text.length,
          bucket: 'project_guidance',
          component: 'project',
        });
        info.projectDisposition = 'imaged';
        info.projectRef = `pg_${(await sha256Hex(project.text)).slice(0, 32)}`;
      }
    }
  }

  if (o.compressToolResults && Array.isArray(req.messages)) {
    for (let messageIndex = 0; messageIndex < req.messages.length; messageIndex++) {
      const message = req.messages[messageIndex]!;
      if (message.role !== 'user' || !Array.isArray(message.content)) continue;
      for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
        const block = message.content[blockIndex];
        if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
        if (!isExactToolResultBlock(block) || block.is_error === true) {
          bumpPassthrough(info, 'unsupported_shape');
          continue;
        }

        const staged: Array<{
          readonly operation: AnthropicExactImageOperation;
          readonly rendered: ExactRenderedBucket;
          readonly chars: number;
          readonly bucket: BucketName;
        }> = [];
        const consider = async (
          source: string,
          kind: 'tool_result' | 'tool_result_part',
          partIndex?: number,
        ): Promise<void> => {
          const shape = classifyContent(source);
          const bucket = toolResultBucket(shape);
          bumpBucket(info, bucket, source.length);
          if (source.length < o.minToolResultChars) {
            bumpPassthrough(info, 'below_threshold');
            return;
          }
          if (callerKeepsSharp(o.keepSharp, {
              kind,
              text: source,
              toolUseId: block.tool_use_id,
            })) {
            bumpPassthrough(info, 'kept_sharp');
            info.keptSharpBlocks = (info.keptSharpBlocks ?? 0) + 1;
            return;
          }
          // Structured data and logs are identifier-bearing by default. Exact
          // values cannot be distinguished reliably enough to image only the
          // prose portions, so v1 keeps those complete source buckets native.
          if (shape !== 'other' || hasProtectedExactIdentifier(source)) {
            bumpPassthrough(info, 'exact_identifier');
            return;
          }
          const rendered = await renderExactBucket(source, o);
          if (!rendered) {
            bumpPassthrough(info, 'render_error');
            return;
          }
          const id = partIndex === undefined
            ? `tool:${messageIndex}:${blockIndex}`
            : `tool:${messageIndex}:${blockIndex}:${partIndex}`;
          const sourceDescriptor = partIndex === undefined
            ? {
                kind: 'tool_result_string' as const,
                messageIndex,
                blockIndex,
                expectedText: source,
              }
            : {
                kind: 'tool_result_text_part' as const,
                messageIndex,
                blockIndex,
                partIndex,
                expectedText: source,
              };
          staged.push({
            operation: {
              kind: 'tool_result_text',
              source: sourceDescriptor,
              images: rendered.images,
              id,
            },
            rendered,
            chars: source.length,
            bucket,
          });
        };

        if (typeof block.content === 'string') {
          await consider(block.content, 'tool_result');
        } else if (Array.isArray(block.content)) {
          for (let partIndex = 0; partIndex < block.content.length; partIndex++) {
            const part = block.content[partIndex];
            if (isExactTextBlock(part)) await consider(part.text, 'tool_result_part', partIndex);
          }
        }

        const groupImages = staged.reduce(
          (sum, item) => sum + item.rendered.images.length,
          0,
        );
        if (
          groupImages === 0
          || groupImages > perResultImageCap
        ) {
          if (groupImages > 0) bumpPassthrough(info, 'too_many_images');
          continue;
        }
        for (const item of staged) {
          operations.push(item.operation);
          accepted.set(item.operation.id, {
            rendered: item.rendered,
            chars: item.chars,
            bucket: item.bucket,
            component: 'tool_result',
          });
        }
      }
    }
  }

  if (operations.length === 0) {
    info.outgoingTextChars = countOutgoingTextChars(req);
    return exactNativeResult(originalBody, info);
  }

  const candidateImageCount = [...accepted.values()].reduce(
    (sum, item) => sum + item.rendered.images.length,
    0,
  );
  if (candidateImageCount > imageCapacity) {
    const native = nativeTransformInfo('candidate_image_limit');
    native.firstUserSha8 = info.firstUserSha8;
    return exactNativeResult(originalBody, native);
  }

  const applied = applyAnthropicExactImageReplacements({ request: req, operations });
  if (!applied.ok) {
    return exactNativeResult(
      originalBody,
      nativeTransformInfo(`exact_splice_failed: ${applied.reason}`),
    );
  }
  for (const operation of operations) {
    const item = accepted.get(operation.id);
    if (!item) {
      return exactNativeResult(originalBody, nativeTransformInfo('exact_splice_accounting_missing'));
    }
    recordExactBucket(info, item.rendered, item.chars, item.bucket, item.component);
  }

  const finalImageCount = countRequestImages(applied.request);
  if (finalImageCount > MAX_ANTHROPIC_IMAGES) {
    return exactNativeResult(originalBody, nativeTransformInfo('image_limit_postcondition'));
  }
  info.compressed = true;
  const accountingFailure = accountingPostconditionFailure(info);
  if (accountingFailure) {
    return exactNativeResult(
      originalBody,
      nativeTransformInfo(`accounting_postcondition: ${accountingFailure}`),
    );
  }
  info.outgoingTextChars = countOutgoingTextChars(applied.request);
  return {
    body: new TextEncoder().encode(JSON.stringify(applied.request)),
    info,
    replacements: applied.descriptors,
    changedSpans: applied.changedSpans,
  };
}

/**
 * Rewrite a Messages API request body. Returns the new body (still JSON
 * bytes) plus diagnostic info. On any error, returns the original bytes
 * unchanged.
 */
/** @internal Build one in-memory Anthropic candidate. Callers must still apply
 * the no-hijack contract, provider validation, and four-probe admission before
 * forwarding it. This is exported only so focused renderer tests can inspect a
 * candidate without weakening the shipped entry points. */
export async function buildAnthropicCandidate(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<AnthropicCandidateResult> {
  // Merge caller opts over DEFAULTS, but treat explicit `undefined` as "not
  // provided" so it falls through to the default. Without this, a caller that
  // passes `{ minToolResultChars: undefined }` (common when forwarding partial
  // options from upstream — e.g. ocproxy's handler) would silently disable the
  // tool_result text-passthrough gate and route everything through the
  // renderer.
  const merged: TransformOptions = { ...DEFAULTS, ...opts };
  for (const k of Object.keys(merged) as (keyof TransformOptions)[]) {
    if (merged[k] === undefined) {
      (merged as Record<string, unknown>)[k] = (DEFAULTS as Record<string, unknown>)[k];
    }
  }
  const o: Required<TransformOptions> = merged as Required<TransformOptions>;
  const info: TransformInfo = {
    compressed: false,
    origChars: 0,
    compressedChars: 0,
    imageCount: 0,
    imageBytes: 0,
    staticChars: 0,
    dynamicChars: 0,
    dynamicBlockCount: 0,
    droppedChars: 0,
  };
  if (!o.compress) {
    info.reason = 'compress=false';
    return exactNativeResult(body, info);
  }

  let req: MessagesRequest;
  try {
    req = JSON.parse(new TextDecoder().decode(body));
  } catch (e) {
    info.reason = `parse_error: ${(e as Error).message}`;
    return exactNativeResult(body, info);
  }

  // Provenance-safe Anthropic orchestration. Native system blocks, tools, and
  // unknown reminders stay in their original API roles; no option restores the
  // removed monolithic system/tool slab.
  return transformSafeAnthropicRequest(
    body,
    req,
    partitionAnthropicContext(req),
    info,
    o,
  );
}

/**
 * Library-safe Anthropic transform entry point. A standalone library call has
 * no authenticated count_tokens transport, so any changed candidate must stay
 * native. The proxy uses `buildAnthropicCandidate` and supplies the strict
 * request-wide admission transport itself.
 */
export async function transformRequest(
  body: Uint8Array,
  opts: TransformOptions = {},
): Promise<{ body: Uint8Array; info: TransformInfo }> {
  const candidate = await buildAnthropicCandidate(body, opts);
  if (!candidate.info.compressed) return candidate;
  const info = nativeTransformInfo('admission_probe_unavailable');
  info.firstUserSha8 = candidate.info.firstUserSha8;
  return { body, info };
}

/** Sum every TEXT char the upstream tokenizer will see (system, tools, messages).
 *  Excludes image base64 and redacted_thinking. Denominator for the
 *  `tokens ≈ α·outgoingTextChars + β·imagePixels` regression. */
function countOutgoingTextChars(req: MessagesRequest): number {
  let n = 0;

  // 1. system field
  const sys = req.system;
  if (typeof sys === 'string') {
    n += sys.length;
  } else if (Array.isArray(sys)) {
    for (const b of sys) {
      if (b && (b as TextBlock).type === 'text' && typeof (b as TextBlock).text === 'string') {
        n += (b as TextBlock).text.length;
      }
    }
  }

  // 2. tool definitions
  if (Array.isArray(req.tools)) {
    for (const tool of req.tools) {
      if (!tool || typeof tool !== 'object') continue;
      if (typeof tool.name === 'string') n += tool.name.length;
      if (typeof tool.description === 'string') n += tool.description.length;
      if (tool.input_schema !== undefined) {
        n += safeStringifyLen(tool.input_schema);
      }
    }
  }

  // 3. per-message content
  for (const msg of req.messages ?? []) {
    const c = msg.content;
    if (typeof c === 'string') {
      n += c.length;
      continue;
    }
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      const type = (b as { type?: string }).type;

      if (type === 'text') {
        const tb = b as TextBlock;
        if (typeof tb.text === 'string') n += tb.text.length;
        continue;
      }

      if (type === 'tool_use') {
        const tu = b as ToolUseBlock;
        if (typeof tu.name === 'string') n += tu.name.length;
        if (tu.input !== undefined) n += safeStringifyLen(tu.input);
        continue;
      }

      if (type === 'tool_result') {
        const tr = b as ToolResultBlock;
        if (typeof tr.tool_use_id === 'string') n += tr.tool_use_id.length;
        const inner = tr.content;
        if (typeof inner === 'string') {
          n += inner.length;
        } else if (Array.isArray(inner)) {
          for (const ib of inner) {
            if (ib && (ib as TextBlock).type === 'text' && typeof (ib as TextBlock).text === 'string') {
              n += (ib as TextBlock).text.length;
            }
          }
        }
        continue;
      }

      if (type === 'thinking') {
        const th = b as unknown as { thinking?: unknown };
        if (typeof th.thinking === 'string') n += (th.thinking as string).length;
        continue;
      }

      // image, redacted_thinking, server_tool_use, etc. — skip.
    }
  }

  return n;
}

/** JSON.stringify length, tolerant of cycles. Returns 0 on error. */
function safeStringifyLen(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return 0;
  }
}
