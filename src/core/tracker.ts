/**
 * Runtime-agnostic event sink for pxpipe.
 * Per-request JSONL record — same shape on Node (file) and Workers (console.log).
 * Never emits raw text; only sizes, counts, durations, env fields, and sha256 prefixes.
 */

import type { ProxyEvent } from './proxy.js';
import { bytesToBase64 } from './png.js';

/** Canonical bucket keys emitted by current transforms. Deriving the union from
 * this allow-list keeps runtime projection and persisted typing in lockstep. */
const TRACK_BUCKET_NAMES = [
  'project_guidance',
  'static_slab',
  'reminder',
  'tool_reference',
  'tool_result_json',
  'tool_result_log',
  'tool_result_prose',
  'history',
] as const;
export type TrackBucketName = typeof TRACK_BUCKET_NAMES[number];

/** `tool_result_structured` was emitted by an older tracker type. Readers keep
 * accepting it, while new projection emits the canonical `tool_result_json`. */
export type TrackBucketChars = Partial<Record<
  TrackBucketName | 'tool_result_structured',
  number
>>;

export type ContextMode = 'claude_code_2_1_205' | 'safe_native';
export type ProjectDisposition =
  | 'imaged'
  | 'native_disabled'
  | 'native_below_threshold'
  | 'native_not_profitable'
  | 'native_too_many_images'
  | 'native_render_error';
export type RuntimeMetadataDisposition = 'moved' | 'native_apply_error';
export type UncertainContextReason =
  | 'unsupported_or_missing_claude_md_section'
  | 'unsupported_or_malformed_claude_context_tail';
const UNCERTAIN_CONTEXT_REASONS = new Set<UncertainContextReason>([
  'unsupported_or_missing_claude_md_section',
  'unsupported_or_malformed_claude_context_tail',
]);
export type ToolMode = 'native' | 'experimental_image';
export type ToolDisposition =
  | 'native_default'
  | 'native_below_threshold'
  | 'native_not_profitable'
  | 'native_too_many_images'
  | 'native_render_error'
  | 'imaged';
export type CacheBoundaryKind = 'project_guidance' | 'tool_reference' | 'history';

export interface TrackGateEval {
  site: 'tool_reference';
  image_tokens: number;
  text_tokens: number;
  burn_image_side: number;
  burn_text_side: number;
  profitable: boolean;
}

/** Flat record persisted per request. Adding a field is non-breaking for readers. */
export interface TrackEvent {
  ts: string;
  method: string;
  path: string;
  /** Top-level request model when present. */
  model?: string;
  status: number;
  duration_ms: number;
  first_byte_ms?: number;

  // From TransformInfo:
  compressed?: boolean;
  reason?: string;
  orig_chars?: number;
  /** Source chars successfully replaced by image blocks across all buckets.
   *  Compare with image_count: textTokens(n/4) vs imageTokens(n×2500). */
  compressed_chars?: number;
  image_count?: number;
  image_bytes?: number;
  /** Total pixel area across all rendered images; pairs with cache_create_tokens for px/token regression. */
  image_pixels?: number;
  /** GPT only: vision tokens billed for rendered images. */
  image_tokens?: number;
  /** GPT only: o200k text tokens the imaged/stripped content would have cost. */
  baseline_imaged_tokens?: number;
  /** TEXT chars in the outgoing body (all text blocks, incl. non-compressed tool_results).
   *  With image_pixels, a regression over cold-miss events solves chars_per_token (α) and pixels_per_token (β). */
  outgoing_text_chars?: number;
  static_chars?: number;
  dynamic_chars?: number;
  dynamic_block_count?: number;
  /** Recognized Anthropic host-context framing mode. */
  context_mode?: ContextMode;
  /** Exact recognized project-guidance source size and provenance. No source text. */
  project_source_chars?: number;
  project_source_role?: 'user';
  project_source_message_index?: number;
  project_source_block_index?: number;
  project_disposition?: ProjectDisposition;
  project_image_count?: number;
  project_source_sha8?: string;
  project_ref?: string;
  /** Recognized runtime source vs the subset actually moved to the vouched tail. */
  runtime_metadata_source_chars?: number;
  runtime_metadata_chars?: number;
  runtime_metadata_disposition?: RuntimeMetadataDisposition;
  /** Input-owned privileged text that remained native; generated manifests are excluded. */
  native_system_chars?: number;
  /** Disjoint fail-closed context spans and fixed reasons; never raw payloads. */
  uncertain_context_chars?: number;
  uncertain_context_reasons?: UncertainContextReason[];
  /** Tool definitions use an independent native/experimental-image decision. */
  tool_mode?: ToolMode;
  tool_disposition?: ToolDisposition;
  tool_source_chars?: number;
  tool_image_count?: number;
  tool_source_sha8?: string;
  tool_ref?: string;
  tool_gate_eval?: TrackGateEval;
  /** Images from compressing <system-reminder> blocks in the first user message. */
  reminder_imgs?: number;
  /** Images from compressing tool_result content. */
  tool_result_imgs?: number;
  /** Canonically framed tool-document chars considered by the experimental image gate. */
  tool_docs_chars?: number;
  /** tool_result blocks where text exceeded the per-result image budget and was truncated. */
  truncated_tool_results?: number;
  /** Chars elided by paging across all tool_results this request. */
  omitted_chars?: number;
  /** History-image: messages collapsed into the synthetic prepended user message. */
  collapsed_turns?: number;
  /** Total chars serialized into history image(s) before render. */
  collapsed_chars?: number;
  /** PNG blocks emitted for the history; also folded into image_count. */
  collapsed_images?: number;
  /** Why history collapse didn't run (or did). Diagnostic. */
  history_reason?: string;
  /** Codepoints not in the glyph atlas. A spike means users type glyphs we don't ship — widen ATLAS_PROFILE. */
  dropped_chars?: number;
  /** Top-20 dropped codepoints (U+HHHH keys) by frequency. Only present when dropped_chars > 0. */
  dropped_codepoints_top?: Record<string, number>;
  /** Blocks that weren't image-compressed this request; only emitted when at least one counter > 0. */
  passthrough_reasons?: {
    below_threshold?: number;
    not_profitable?: number;
    kept_sharp?: number;
  };
  /** Unrecognized tag names in the static slab — canary for Claude Code releases adding new dynamic tags. */
  unknown_static_tags?: string[];
  /** Slab tags whose content changed within a session — proven per-turn dynamics busting the image cache. */
  churning_static_tags?: string[];
  /** Pre-compression candidate chars through each gate, including rejected
   *  candidates. Absent when no candidate gate fired; enables cpt regression. */
  bucket_chars?: TrackBucketChars;
  /** Disjoint source chars that were actually image-encoded. */
  imaged_bucket_chars?: TrackBucketChars;
  /** TEXT chars that fed the history-image renderer; separate from bucket_chars because it credits a synthetic message. */
  history_text_chars?: number;
  /** sha8 of the collapsed history image. Diagnoses the collapse artifact only;
   *  whole-prefix warmth identity is cache_prefix_sha8 with legacy system fallback. */
  history_image_sha8?: string;
  /** sha8 of the exact pxpipe-vouched prefix (tools+system+imaged prefix, live
   *  tail excluded). Changes turn-over-turn within a session ⇒ pxpipe-side cache
   *  bust; stable while cache_create spikes ⇒ upstream eviction. See #11. */
  cache_prefix_sha8?: string;
  /** Approx chars in that pinned prefix (growth vs pure-invalidation split). */
  cache_prefix_bytes?: number;
  /** Exact vouched boundary represented by cache_prefix_sha8. */
  cache_boundary_kind?: CacheBoundaryKind;

  // From TransformInfo.env:
  cwd?: string;
  is_git_repo?: boolean;
  git_branch?: string;
  platform?: string;
  os_version?: string;
  today?: string;

  // Fingerprints:
  system_sha8?: string;
  claude_md_sha8?: string;
  first_user_sha8?: string;

  // From Anthropic/OpenAI Usage:
  input_tokens?: number;
  output_tokens?: number;
  cache_create_tokens?: number;
  cache_read_tokens?: number;
  /** OpenAI prompt-cache hits (subset of input_tokens), from input/prompt_tokens_details.cached_tokens. */
  cached_tokens?: number;
  /** Cache_create split by tier — 1.25x (5-min) and 2x (1-hour) input rates.
   *  Their sum equals `cache_create_tokens` when both fields are present. */
  cache_create_5m_tokens?: number;
  cache_create_1h_tokens?: number;
  /** Server-side web search calls billed per-request (not per-token). */
  web_search_requests?: number;

  /** Model stop reason ("end_turn", "tool_use", "max_tokens", "refusal", …).
   *  OpenAI finish_reason ("stop", "length", "content_filter", …) lands in the same field. */
  stop_reason?: string;
  /** True when the stop reason indicates a safety classifier fired ("refusal" /
   *  "content_filter"). Refusal rows emit almost no output and would otherwise
   *  read as "cheap" — scorers MUST fail cost comparisons on these rows, and a
   *  cluster of them after a transform change means the imaged prompt itself is
   *  tripping the classifier (see transform.ts reasoning_extraction notes). */
  safety_flagged?: boolean;

  /** Ground-truth output chars measured by streaming the response body ourselves — independent of
   *  usage.output_tokens. redacted_block_count_measured counts opaque server-encrypted blocks;
   *  dashboard applies a low/mid/high estimate for those. Absent on non-scannable responses. */
  text_chars_measured?: number;
  thinking_chars_measured?: number;
  tool_use_chars_measured?: number;
  redacted_block_count_measured?: number;

  /** count_tokens on the ORIGINAL body (free endpoint). Absent on probe failure; excluded from savings rollup. */
  baseline_tokens?: number;
  /** count_tokens on the original body truncated at the last cache_control marker — gives cacheable_prefix_tokens.
   *  With baseline_tokens, decomposes unproxied cost into (cacheable_prefix, cold_tail).
   *  Explicit zero means the complete four-probe admission measured a marker-free prefix. */
  baseline_cacheable_tokens?: number;
  /** count_tokens on the complete proposed body and its cacheable prefix. */
  candidate_tokens?: number;
  candidate_cacheable_tokens?: number;
  /** Four-probe outcome. Consumers attribute a counterfactual only when status === 'ok'. */
  baseline_probe_status?: 'ok' | 'partial' | 'failed';
  /** Strict request-wide admission evidence. Values never contain request text. */
  admission_reason?: string;
  admission_cache_tier?: 'none' | '5m' | '1h' | 'conservative_1h';
  baseline_cache_create_rate?: 1.25 | 2;
  admission_original_effective_tokens?: number;
  admission_candidate_effective_tokens?: number;
  admission_signed_savings_tokens?: number;
  admission_relative_savings?: number;
  /** Hash-only process-local admission/breaker identity. */
  admission_fingerprint?: string;

  // Errors:
  error?: string;
  /** First ~2 KiB of the upstream 4xx response body. */
  error_body?: string;
  /** sha256[0..8] of the TRANSFORMED outgoing body — correlates payloads without persisting them. */
  req_body_sha8?: string;
  /** Gzipped+base64 TRANSFORMED body for 4xx, inlined when ≤ TRACK_BODY_INLINE_MAX. Node host writes sidecar for larger bodies. */
  req_body_sample_b64?: string;
  /** Node host only: path to gzipped sidecar when inline cap exceeded. Workers drop oversized samples. */
  req_body_sample_path?: string;
}

/** Max inline base64 body per JSONL row (32 KiB). Larger goes to sidecar (Node) or is dropped (Workers). */
export const TRACK_BODY_INLINE_MAX = 32 * 1024;

/** Hosts implement this to persist events. */
export interface Tracker {
  emit(ev: TrackEvent): void | Promise<void>;
  /** Optional: flush any buffered writes (file rotation, etc.). */
  flush?(): void | Promise<void>;
}

/** Forward-compatible view of provenance telemetry. Keeping this structural
 * avoids coupling tracker rollout to the TransformInfo slice that produces the
 * pending native/uncertain/tool fields. */
interface ProvenanceTelemetryInfo {
  contextMode?: ContextMode;
  projectSourceChars?: number;
  projectSourceRole?: 'user';
  projectSourceMessageIndex?: number;
  projectSourceBlockIndex?: number;
  projectDisposition?: ProjectDisposition;
  projectImageCount?: number;
  projectSourceSha8?: string;
  projectRef?: string;
  runtimeMetadataSourceChars?: number;
  runtimeMetadataChars?: number;
  runtimeMetadataDisposition?: RuntimeMetadataDisposition;
  nativeSystemChars?: number;
  uncertainContextChars?: number;
  uncertainContextReasons?: readonly UncertainContextReason[];
  toolMode?: ToolMode;
  toolDisposition?: ToolDisposition;
  toolSourceChars?: number;
  toolImageCount?: number;
  toolSourceSha8?: string;
  toolRef?: string;
  toolGateEval?: {
    site: 'tool_reference';
    imageTokens: number;
    textTokens: number;
    burnImageSide: number;
    burnTextSide: number;
    profitable: boolean;
  };
  cacheBoundaryKind?: CacheBoundaryKind;
  bucketChars?: Partial<Record<TrackBucketName, number>>;
  imagedBucketChars?: Partial<Record<TrackBucketName, number>>;
}

/** Copy only known numeric bucket keys. Besides keeping old/new key names
 * deterministic, this prevents an augmented info object from smuggling source
 * payloads into JSONL through the nested map. */
function projectBucketChars(value: unknown): TrackBucketChars | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const out: TrackBucketChars = {};
  for (const key of TRACK_BUCKET_NAMES) {
    const chars = source[key];
    if (typeof chars === 'number') out[key] = chars;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Convert a ProxyEvent to its flat persisted shape. Shared in core so Node/Worker hosts stay in sync. */
export function toTrackEvent(ev: ProxyEvent): TrackEvent {
  const info = ev.info;
  const env = info?.env;
  const u = ev.usage;
  const out: TrackEvent = {
    ts: new Date().toISOString(),
    method: ev.method,
    path: ev.path,
    status: ev.status,
    duration_ms: ev.durationMs,
  };
  if (ev.model) out.model = ev.model;
  if (ev.firstByteMs !== undefined) out.first_byte_ms = ev.firstByteMs;
  if (ev.error) out.error = ev.error;
  if (ev.errorBody) out.error_body = ev.errorBody;
  if (ev.reqBodySha8) out.req_body_sha8 = ev.reqBodySha8;
  // Body sample: sidecar path (Node) > inline base64 if it fits > drop (Workers, oversized).
  if (ev.reqBodySamplePath) {
    out.req_body_sample_path = ev.reqBodySamplePath;
  } else if (ev.reqBodyGz && ev.reqBodyGz.byteLength > 0) {
    const b64 = bytesToBase64(ev.reqBodyGz);
    if (b64.length <= TRACK_BODY_INLINE_MAX) {
      out.req_body_sample_b64 = b64;
    }
  }

  if (info) {
    const provenance = info as ProvenanceTelemetryInfo;
    if (info.compressed !== undefined) out.compressed = info.compressed;
    if (info.reason) out.reason = info.reason;
    if (info.origChars !== undefined) out.orig_chars = info.origChars;
    // Zero is measured data for runtime-only rewrites. Persist it so consumers
    // can distinguish a current zero-image row from legacy rows that predate
    // compressed_chars and therefore need the orig_chars fallback.
    if (info.compressedChars !== undefined) {
      out.compressed_chars = info.compressedChars;
    }
    if (info.imageCount !== undefined) out.image_count = info.imageCount;
    if (info.imageBytes !== undefined) out.image_bytes = info.imageBytes;
    if (info.imagePixels !== undefined && info.imagePixels > 0) {
      out.image_pixels = info.imagePixels;
    }
    if (info.imageTokens !== undefined && info.imageTokens > 0) {
      out.image_tokens = info.imageTokens;
    }
    if (info.baselineImagedTokens !== undefined && info.baselineImagedTokens > 0) {
      out.baseline_imaged_tokens = info.baselineImagedTokens;
    }
    if (info.outgoingTextChars !== undefined && info.outgoingTextChars > 0) {
      out.outgoing_text_chars = info.outgoingTextChars;
    }
    if (info.staticChars !== undefined) out.static_chars = info.staticChars;
    if (info.dynamicChars !== undefined) out.dynamic_chars = info.dynamicChars;
    if (info.dynamicBlockCount !== undefined) out.dynamic_block_count = info.dynamicBlockCount;
    if (provenance.contextMode !== undefined) out.context_mode = provenance.contextMode;
    if (provenance.projectSourceChars !== undefined) {
      out.project_source_chars = provenance.projectSourceChars;
    }
    if (provenance.projectSourceRole !== undefined) {
      out.project_source_role = provenance.projectSourceRole;
    }
    if (provenance.projectSourceMessageIndex !== undefined) {
      out.project_source_message_index = provenance.projectSourceMessageIndex;
    }
    if (provenance.projectSourceBlockIndex !== undefined) {
      out.project_source_block_index = provenance.projectSourceBlockIndex;
    }
    if (provenance.projectDisposition !== undefined) {
      out.project_disposition = provenance.projectDisposition;
    }
    if (provenance.projectImageCount !== undefined) {
      out.project_image_count = provenance.projectImageCount;
    }
    if (provenance.projectSourceSha8) {
      out.project_source_sha8 = provenance.projectSourceSha8;
    }
    if (provenance.projectRef) out.project_ref = provenance.projectRef;
    if (provenance.runtimeMetadataSourceChars !== undefined) {
      out.runtime_metadata_source_chars = provenance.runtimeMetadataSourceChars;
    }
    if (provenance.runtimeMetadataChars !== undefined) {
      out.runtime_metadata_chars = provenance.runtimeMetadataChars;
    }
    if (provenance.runtimeMetadataDisposition !== undefined) {
      out.runtime_metadata_disposition = provenance.runtimeMetadataDisposition;
    }
    if (provenance.nativeSystemChars !== undefined) {
      out.native_system_chars = provenance.nativeSystemChars;
    }
    if (provenance.uncertainContextChars !== undefined) {
      out.uncertain_context_chars = provenance.uncertainContextChars;
    }
    if (provenance.uncertainContextReasons?.length) {
      const reasons = provenance.uncertainContextReasons.filter((reason) =>
        UNCERTAIN_CONTEXT_REASONS.has(reason));
      if (reasons.length > 0) out.uncertain_context_reasons = [...new Set(reasons)];
    }
    if (provenance.toolMode !== undefined) out.tool_mode = provenance.toolMode;
    if (provenance.toolDisposition !== undefined) {
      out.tool_disposition = provenance.toolDisposition;
    }
    if (provenance.toolSourceChars !== undefined) {
      out.tool_source_chars = provenance.toolSourceChars;
    }
    if (provenance.toolImageCount !== undefined) {
      out.tool_image_count = provenance.toolImageCount;
    }
    if (provenance.toolSourceSha8) out.tool_source_sha8 = provenance.toolSourceSha8;
    if (provenance.toolRef) out.tool_ref = provenance.toolRef;
    if (provenance.toolGateEval) {
      out.tool_gate_eval = {
        site: provenance.toolGateEval.site,
        image_tokens: provenance.toolGateEval.imageTokens,
        text_tokens: provenance.toolGateEval.textTokens,
        burn_image_side: provenance.toolGateEval.burnImageSide,
        burn_text_side: provenance.toolGateEval.burnTextSide,
        profitable: provenance.toolGateEval.profitable,
      };
    }
    if (info.reminderImgs !== undefined) out.reminder_imgs = info.reminderImgs;
    if (info.toolResultImgs !== undefined) out.tool_result_imgs = info.toolResultImgs;
    if (info.toolDocsChars !== undefined) out.tool_docs_chars = info.toolDocsChars;
    if (info.truncatedToolResults !== undefined && info.truncatedToolResults > 0) {
      out.truncated_tool_results = info.truncatedToolResults;
    }
    if (info.omittedChars !== undefined && info.omittedChars > 0) {
      out.omitted_chars = info.omittedChars;
    }
    if (info.collapsedTurns !== undefined && info.collapsedTurns > 0) {
      out.collapsed_turns = info.collapsedTurns;
    }
    if (info.collapsedChars !== undefined && info.collapsedChars > 0) {
      out.collapsed_chars = info.collapsedChars;
    }
    if (info.collapsedImages !== undefined && info.collapsedImages > 0) {
      out.collapsed_images = info.collapsedImages;
    }
    if (info.historyReason !== undefined) {
      out.history_reason = info.historyReason;
    }
    if (info.droppedChars !== undefined && info.droppedChars > 0) {
      out.dropped_chars = info.droppedChars;
    }
    if (info.droppedCodepointsTop && Object.keys(info.droppedCodepointsTop).length > 0) {
      out.dropped_codepoints_top = info.droppedCodepointsTop;
    }
    if (info.passthroughReasons) {
      const pr = info.passthroughReasons;
      if (
        (pr.below_threshold ?? 0) > 0 ||
        (pr.not_profitable ?? 0) > 0 ||
        (pr.kept_sharp ?? 0) > 0
      ) {
        out.passthrough_reasons = pr;
      }
    }
    const bucketChars = projectBucketChars(provenance.bucketChars);
    if (bucketChars) {
      // Omit empty object so noop-pass requests stay lean; presence means at least one gate fired.
      out.bucket_chars = bucketChars;
    }
    const imagedBucketChars = projectBucketChars(provenance.imagedBucketChars);
    if (imagedBucketChars) out.imaged_bucket_chars = imagedBucketChars;
    if (info.historyTextChars !== undefined && info.historyTextChars > 0) {
      out.history_text_chars = info.historyTextChars;
    }
    if (info.historyImageSha) {
      out.history_image_sha8 = info.historyImageSha;
    }
    if (info.cachePrefixSha8) out.cache_prefix_sha8 = info.cachePrefixSha8;
    if (info.cachePrefixBytes !== undefined) out.cache_prefix_bytes = info.cachePrefixBytes;
    if (provenance.cacheBoundaryKind !== undefined) {
      out.cache_boundary_kind = provenance.cacheBoundaryKind;
    }
    if (info.unknownStaticTags && info.unknownStaticTags.length > 0)
      out.unknown_static_tags = info.unknownStaticTags;
    if (info.churningStaticTags && info.churningStaticTags.length > 0)
      out.churning_static_tags = info.churningStaticTags;
    if (info.systemSha8) out.system_sha8 = info.systemSha8;
    if (info.claudeMdSha8) out.claude_md_sha8 = info.claudeMdSha8;
    if (info.firstUserSha8) out.first_user_sha8 = info.firstUserSha8;
    if (info.baselineTokens !== undefined && info.baselineTokens > 0) {
      out.baseline_tokens = info.baselineTokens;
    }
    if (
      info.baselineCacheableTokens !== undefined
      && (
        info.baselineCacheableTokens > 0
        || (info.baselineCacheableTokens === 0 && info.baselineProbeStatus === 'ok')
      )
    ) {
      out.baseline_cacheable_tokens = info.baselineCacheableTokens;
    }
    if (info.candidateTokens !== undefined && info.candidateTokens > 0) {
      out.candidate_tokens = info.candidateTokens;
    }
    if (
      info.candidateCacheableTokens !== undefined
      && (
        info.candidateCacheableTokens > 0
        || (info.candidateCacheableTokens === 0 && info.baselineProbeStatus === 'ok')
      )
    ) {
      out.candidate_cacheable_tokens = info.candidateCacheableTokens;
    }
    if (info.baselineProbeStatus !== undefined) {
      out.baseline_probe_status = info.baselineProbeStatus;
    }
    if (info.admissionReason !== undefined) out.admission_reason = info.admissionReason;
    if (info.admissionCacheTier !== undefined) {
      out.admission_cache_tier = info.admissionCacheTier;
    }
    if (info.baselineCacheCreateRate !== undefined) {
      out.baseline_cache_create_rate = info.baselineCacheCreateRate;
    }
    if (Number.isFinite(info.admissionOriginalEffectiveTokens)) {
      out.admission_original_effective_tokens = info.admissionOriginalEffectiveTokens;
    }
    if (Number.isFinite(info.admissionCandidateEffectiveTokens)) {
      out.admission_candidate_effective_tokens = info.admissionCandidateEffectiveTokens;
    }
    if (Number.isFinite(info.admissionSignedSavingsTokens)) {
      out.admission_signed_savings_tokens = info.admissionSignedSavingsTokens;
    }
    if (Number.isFinite(info.admissionRelativeSavings)) {
      out.admission_relative_savings = info.admissionRelativeSavings;
    }
    if (
      info.admissionFingerprint !== undefined
      && /^(?:pxa_|af_)?[0-9a-f]{16,64}$/i.test(info.admissionFingerprint)
    ) {
      out.admission_fingerprint = info.admissionFingerprint;
    }
  }
  if (env) {
    if (env.cwd) out.cwd = env.cwd;
    if (env.isGitRepo !== undefined) out.is_git_repo = env.isGitRepo;
    if (env.gitBranch) out.git_branch = env.gitBranch;
    if (env.platform) out.platform = env.platform;
    if (env.osVersion) out.os_version = env.osVersion;
    if (env.today) out.today = env.today;
  }
  if (u) {
    if (u.input_tokens !== undefined) out.input_tokens = u.input_tokens;
    if (u.output_tokens !== undefined) out.output_tokens = u.output_tokens;
    if (u.cache_creation_input_tokens !== undefined)
      out.cache_create_tokens = u.cache_creation_input_tokens;
    if (u.cache_read_input_tokens !== undefined)
      out.cache_read_tokens = u.cache_read_input_tokens;
    if (u.cached_tokens !== undefined)
      out.cached_tokens = u.cached_tokens;
    // cache_creation splits cache_creation_input_tokens across 5-min (1.25x) and 1-hour (2x) tiers.
    if (u.cache_creation) {
      if (u.cache_creation.ephemeral_5m_input_tokens !== undefined)
        out.cache_create_5m_tokens = u.cache_creation.ephemeral_5m_input_tokens;
      if (u.cache_creation.ephemeral_1h_input_tokens !== undefined)
        out.cache_create_1h_tokens = u.cache_creation.ephemeral_1h_input_tokens;
    }
    if (u.server_tool_use?.web_search_requests !== undefined)
      out.web_search_requests = u.server_tool_use.web_search_requests;
  }
  const m = ev.measurement;
  if (m) {
    if (m.textChars > 0) out.text_chars_measured = m.textChars;
    if (m.thinkingChars > 0) out.thinking_chars_measured = m.thinkingChars;
    if (m.toolUseChars > 0) out.tool_use_chars_measured = m.toolUseChars;
    if (m.redactedBlockCount > 0)
      out.redacted_block_count_measured = m.redactedBlockCount;
  }
  if (ev.stopReason) {
    out.stop_reason = ev.stopReason;
    if (SAFETY_STOP_REASONS.has(ev.stopReason)) out.safety_flagged = true;
  }
  return out;
}

/** Stop reasons that mean a safety classifier fired (Anthropic / OpenAI spellings). */
const SAFETY_STOP_REASONS = new Set(['refusal', 'content_filter']);

/** Writes one JSON line per event. Worker host uses console.log; Node host uses a file-backed variant. */
export class JsonLogTracker implements Tracker {
  constructor(private readonly sink: (line: string) => void = (s) => console.log(s)) {}
  emit(ev: TrackEvent): void {
    try {
      this.sink(JSON.stringify(ev));
    } catch {
      /* swallow — tracker must never break a request */
    }
  }
}

/** Tracker that drops everything. Used when PXPIPE_TRACK=0. */
export const noopTracker: Tracker = { emit() {} };
