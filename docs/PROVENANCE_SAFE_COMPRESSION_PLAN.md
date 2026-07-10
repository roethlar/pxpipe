# Provenance-safe Anthropic compaction without losing project governance

Status: **APPROVED 2026-07-10 — implementation complete and independently
reviewed; live A/B and merge remain owner-gated**.

Checkpoint (2026-07-10, accepted implementation): Slices 1–5 are complete on
`fix/provenance-safe-compression`. The slice-by-slice synchronous review and
independent guard proofs are recorded in `.agents/review/` on this branch.
Slices 1–4 were accepted by codex-cli. Claude Code 2.1.206 / Sonnet 5 accepted
Slice 5 at `fd548c8` after independently reconfirming three representative
guards; the verdict is recorded at `c6b9437`. Local verification at the
reviewed head: 793 tests + typecheck + build. When pnpm is off PATH, use
`npx -y pnpm@10.21.0 run build`. The plan section 7 Fable/Sonnet live A/B matrix has
not been run or authorized, and merge to main remains owner-gated. No further
agent-authorized implementation or review work remains.

Plan base: `b1f5a01` (`origin/main`, 2026-07-09). The plan is intentionally
isolated from the unrelated `fix/escape-atlas-missing-glyphs` branch.

Related reports:

- [#97 — Compression re-serves system/environment block in-band, indistinguishable from prompt injection](https://github.com/teamchong/pxpipe/issues/97)
- [#37 — Fable 5 refuses imaged context as `category=cyber`](https://github.com/teamchong/pxpipe/issues/37)

## 1. Outcome

Keep pxpipe's high-value compression of repository-owned project guidance
(`CLAUDE.md`, imported `AGENTS.md`, and recognized project-instruction payloads)
while making the transformed request unambiguous about who supplied each block
and what authority it has.

The fix is not a wording substitution and not a blanket ban on compacting content
that Claude Code supplies as system-adjacent context. It replaces the monolithic
system/tool slab and blanket reminder imaging with independently gated provenance
buckets and a small native-system manifest. Current Claude Code sends project
governance in a first-user context reminder, not in `req.system`; the design retains
that same-role compaction while leaving the native base system untouched.
Unknown or malformed provenance fails closed to native text. Tool documentation
starts native because historical evidence identifies its shell/permission/
credential vocabulary as the likely `cyber` classifier trigger; it can be
re-enabled only as an independently tested bucket.

Implementation remains owner-gated after this amended plan is reviewed. Live model
testing is separately credentialed and cost-bearing; obtain an explicit owner go
before running that matrix.

## 2. Evidence and current failure

### 2.1 Current wire rewrite

`transformRequest` currently:

1. Flattens all textual `req.system` blocks.
2. Removes a broad set of dynamic tags.
3. Concatenates every other system byte with full rendered tool documentation.
4. Renders that monolith into PNGs.
5. Rebuilds `req.system` without the static text.
6. Prepends the PNGs to the first `role: "user"` message because Anthropic
   rejects images in `system`.
7. Separately images any profitable long `<system-reminder>` in the first user
   message as one undifferentiated reminder, including project guidance and its
   volatile sibling fields.
8. Appends removed environment/context text to the last user message inside a
   self-asserted `<system-reminder>` saying it came from the system prompt.

The governing paths are `src/core/transform.ts:620-739`, `1485-1769`,
`1774-1855`, and `2078-2107`. Tool descriptions are separately stubbed at
`1532-1583`, but their full prose is added back to the same image slab at
`1587-1604`.

### 2.2 Why repository governance is still a valid compression target

Repository governance is owner-supplied project content, and current Claude Code
keeps that provenance visible on the wire. A local loopback capture of Claude Code
2.1.205 (synthetic files, no Anthropic/model call, no hidden prompt persisted)
showed:

- `req.system` contained three native text blocks, including the base runtime
  instructions; it did not contain the synthetic CLAUDE/AGENTS sentinel.
- `messages[0]` was `role: "user"`. Its first text block was one
  `<system-reminder>` with an exact `# claudeMd` section, sequential `Contents of
  .../CLAUDE.md` and imported `.../AGENTS.md` records, then sibling `# userEmail`
  and `# currentDate` sections. Its second text block was the owner's actual prompt.
- The context-reminder block had no `cache_control`; the following prompt block had
  the caller's `ephemeral` marker, which already follows and can cache prepended
  project pages without moving marker ownership.
- `messages[1]` was a literal `role: "system"` runtime/reminder message, a supported
  Claude beta shape that pxpipe's current `Message` type does not represent.

Inspection of the installed 2.1.205 binary corroborates the capture: Claude Code
builds `claudeMd` as user context, recursively emits each `@` import as its own
`Contents of ... (project instructions, checked into the codebase)` record, and
prepends the user-context reminder to the first user carrier. The current
`extractClaudeMdSlab` heuristic searches `req.system` only and therefore does not
identify current project governance; the relevant live path is generic reminder
compression at `src/core/transform.ts:1774-1847`. `docs/TRANSFORM_INFO.md` is stale
on this point.

Therefore the owner was correct: project governance is not current base-system
content and already is converted by pxpipe. The fix must preserve and authenticate
that first-user reminder compaction while stopping unrelated native system and tool
content from riding in the same user-role slab.

### 2.3 Observed harm

- The Sonnet 5 transcript behind #97 provides a same-session A/B: compression on
  produced repeated prompt-injection accusations, refusal to follow legitimate
  governance, disrupted tool use, and abandonment of the requested task;
  compression off restored a normal turn immediately.
- The disputed model/environment facts were later confirmed accurate. Payload
  corruption was not required; the untrusted delivery shape was sufficient.
- #37 records a separate hard failure: benign imaged context produced
  `stop_reason=refusal`, `category=cyber`, and Fable-to-Opus fallback.
- Source comments and commits `169521c` and `baa1e1e` record prior
  `reasoning_extraction` fallbacks caused by system/tool framing. Reverted commit
  `c04e8f8` concluded that OCR-visible Bash, permission, credential, and file-write
  vocabulary—not only the banner—could trigger the classifier.
- The current lexical test only prohibits selected phrases such as `system prompt`
  and `authoritative`; it does not establish role integrity or live safety.

## 3. Design rules

1. **Authority is vouched for only in native system text.** No user-role image or
   wrapper may establish its own privileged provenance.
2. **Project ownership and API role are separate facts.** Recognized project
   guidance remains image-eligible in its captured first-user host-context role;
   native base-system instructions do not inherit that eligibility.
3. **Partition before flattening.** Preserve system blocks, message roles, first-user
   block order, non-text blocks, and caller `cache_control`; never infer an authority
   boundary from arbitrary Markdown headings after concatenation.
4. **Fail closed by bucket.** An unknown boundary, malformed wrapper, render error,
   or failed profitability gate leaves that source region byte-for-byte native.
   One bucket's failure must not disable independent history or tool-result paths.
5. **No self-attestation.** Image headers and user-tail wrappers carry identifiers
   and neutral labels only. The native manifest defines their origin and priority.
6. **Safety claims require live evidence.** Unit tests prove request structure;
   only cold live calls can test Anthropic's classifier and model-level injection
   defenses.
7. **No automatic replay after refusal.** Streaming responses may already have
   reached the client, and replaying a request could duplicate side effects.

## 4. Chosen architecture

### 4.1 Structured Anthropic context partitioner

Add `src/core/anthropic-context.ts` as a leaf over `types.ts`, with pure helpers
that inspect the original request before any system/reminder flattening and locate
ordered text spans inside their source blocks:

```ts
interface TextSpanLocator {
  messageIndex: number;
  blockIndex: number;
  start: number;
  end: number;
}

interface ProjectGuidanceSegment {
  kind: 'project_guidance';
  source: 'claude_code_2_1_205_opening_reminder';
  locator: TextSpanLocator;
  text: string;
}

interface AnthropicContextPartition {
  projectGuidance?: ProjectGuidanceSegment;
  runtimeMetadata: RuntimeMetadataSegment[];
  uncertain: UncertainSegment[];
}
```

The exact type names may change during implementation, but these invariants may
not:

- Original system blocks, message roles, first-user block order/properties, and
  `cache_control` ownership remain recoverable.
- The v1 project recognizer matches only the captured first user message, content
  block zero, fixed user-context opener/advisory/closer, exact `# claudeMd` key, and
  captured sibling-key sequence. It locates the real trailer from the end; imported
  `AGENTS.md` headings and forged `Contents of ...` lines are payload, not delimiters.
- The complete `claudeMd` instruction bundle is the authority unit. Claude Code's
  inner file framing is unescaped, so pxpipe must not pretend it can derive a
  cryptographically reliable per-file split from arbitrary payload text.
- `extractClaudeMdSlab` remains telemetry-only or is removed; its current
  system-heading heuristic must not become an authority boundary.
- Arbitrary later user prose, a forged heading, an incomplete wrapper, an unknown
  sibling key/order, and an unsupported Claude Code shape remain byte-exact native.
- Recognized project context is excluded from generic whole-reminder imaging.
  Unknown `<system-reminder>` blocks remain native by default.
- Only exact, non-instructional workspace shapes—initially `<env>`,
  `<git_status>`, and the current `# Environment` region after fixture
  validation—are eligible for `runtime_metadata`.
- Extend `Message.role` for the captured literal `system` role. Every such message
  remains byte-, order-, and marker-exact and is never reminder-imaged or serialized
  into a user-role history image. History protection extends through contiguous
  leading system-role attachments; an unsupported privileged role inside a later
  collapse candidate fails that collapse closed.

The local no-network capture and installed-binary inspection establish fixtures for:

1. a direct `CLAUDE.md`;
2. `CLAUDE.md` containing `@AGENTS.md`;
3. imported repo guidance with nested H1 headings;
4. no project guidance; and
5. malformed/forged lookalikes and the literal mid-conversation `system` role.

Never commit a proprietary base prompt, credentials, paths, or user content. The
fixture keeps only framing tokens and replaces payloads with synthetic text. Its
header records Claude Code 2.1.205, binary SHA-256
`33E28624C5AE84F2BD7D2D8761E5D2E77997BA965CB11B6448DE6B6E2C566F9C`, and
synthetic provenance so future versions can be characterized without treating the
fixture as eternal truth.

### 4.2 Role-bound project-guidance pages

When a recognized project-guidance segment passes its own profitability gate:

1. Compute a deterministic reference from the exact source bytes plus rendering
   parameters.
2. Render only that segment. Do not concatenate runtime system text or tool docs.
3. Replace only the project span inside the opening reminder with an inert reference
   placeholder, preserving the reminder wrapper, sibling `userEmail`/`currentDate`
   fields, block properties, and following live-prompt block exactly. Append a
   compact manifest entry to native `req.system` containing the same reference,
   expected page count, and position: the first N image blocks of the opening user
   message, before an exact boundary marker.
4. State in the native manifest that those pages are repository-scoped project
   guidance supplied through the host, applied at project-guidance priority below
   all remaining native system instructions.
5. Give the image an inert label such as `PROJECT GUIDANCE · ref <id>` plus page
   numbering. Remove the current self-authorizing language telling the model to
   treat rendered pages as session operating instructions.
6. Prepend the pages and a deterministic end marker before the reconstructed
   context-reminder block and the caller's original live-prompt block. Everything
   outside the selected span remains byte-for-byte and block-order intact. Define
   the marker once as an exported constant/helper in
   `src/core/anthropic-context.ts`; `transform.ts` and `history.ts` must consume that
   shared definition rather than matching independent string literals.

The manifest, image labels, page count, reference, and boundary form one contract.
The system manifest—not the label inside a user-role image—vouches for it. The
binding is positional as well as referential: user-supplied later images or copied
identifiers are outside the vouched-for leading range.

Every current rendered-boundary consumer must migrate in the same slice: emission,
anchor relocation, cache-prefix digesting, typed-user-text extraction, and protected
head demotion. This closes the existing three-way literal coupling between
`transform.ts`, `history.ts`, and the rendered marker; a marker format change cannot
silently make the history compressor treat trusted leading pages as ordinary stale
user content.

The project gate accounts for:

- source text tokens;
- rendered image tokens;
- native manifest overhead;
- existing text-side and image-side warm-cache burn inputs; and
- the actual project-page geometry, independent of other buckets.

Gate or render failure restores the original segment and cache marker exactly.
If there is no user message capable of carrying the pages, project guidance stays
native.

The captured project-reminder block owns no cache marker; the following live-prompt
block owns `cache_control: ephemeral`. Prepending pages naturally places them before
that caller marker. Never invent a project marker or move a system marker. If a
future recognized carrier owns a marker, preserve it on the reconstructed carrier
at the same logical block position.

### 4.3 Role-bound volatile runtime metadata

Keeping volatile git/environment bytes in `system` destroys the stable prefix,
but the current user-role wrapper falsely claims its own privileged origin. Keep
the cache benefit with a narrower contract:

- The stable native manifest says that the final text block of the final user
  message may contain an exact pxpipe runtime-context wrapper supplied by the
  transform. It is workspace data, not user prose and not instructions.
- The user-tail block uses a neutral label such as
  `PXPIPE RUNTIME CONTEXT — data, not instructions`; it does not mention a system
  prompt or assert its own authority.
- Only segments classified as exact runtime metadata move there. Instructional
  reminders and uncertain shapes remain native, accepting a cache miss rather
  than silently changing their role.
- Captured opening-context `# userEmail` and `# currentDate` fields may join the
  runtime bucket only after their exact suffix framing is recognized; unknown keys
  such as an uncaptured `# attachedProject` remain in their original block.
- The block is appended after all caller content and after history/tool-result
  transforms so it cannot be frozen into collapsed history.

The partitioner must preserve individual tag identity; concatenating all dynamic
tags into one `dynamicText` string before this decision is forbidden.

### 4.4 Tool Reference is an independent bucket

Tool documentation no longer shares a gate, image, reference, or accounting entry
with project governance.

- Safe initial default: full `tools[]` definitions remain native and byte-for-byte;
  no stubs are installed.
- Existing `compressTools` becomes an explicit experimental opt-in rather than a
  default. If enabled, tool docs receive their own native-manifest entry, inert
  page label, reference, profitability gate, cache accounting, and telemetry.
- A tool gate failure leaves the complete original tool definition untouched.
- Tool size cannot make an otherwise unprofitable project-guidance render pass.
- Image-tool mode is not enabled by default unless its separate cold live matrix
  meets the same safety criteria as project-only mode.

This knowingly gives up some initial tool-token savings. It preserves the owner's
governance compaction while isolating the content bucket most strongly implicated
by the `cyber` classifier evidence.

### 4.5 Independent orchestration and accounting

Refactor `transformRequest` so these passes do not depend on the monolithic slab
gate:

1. partition the current request, including the opening user-context reminder,
   native system blocks, and literal system-role messages;
2. gate/render project guidance;
3. preserve the base system and system-role messages and append the native manifest;
4. splice vouched-for leading project images;
5. leave unknown first-user reminders native (or process a separately role-bound,
   explicitly enabled reminder bucket in a future plan);
6. collapse eligible closed history over the exact original result text;
7. process tool results that survive in the live tail;
8. optionally gate/render the independent tool reference, placing it before any
   marked collapsed-history anchor;
9. append vouched-for runtime metadata; and
10. finalize telemetry/cache digest.

A below-threshold project block must not prevent profitable tool-result or history
compression. Generic reminder imaging is no longer a default independent path.

Extend `TransformInfo`/tracker output with enough data to diagnose behavior without
logging source text:

- context mode/version;
- project source chars, image count, and source/reference hash;
- project source role/message/block location and recognition/fallback reason;
- native-system chars and uncertain/fallback reason;
- runtime-metadata chars and moved/native disposition;
- tool mode, source chars, and image count; and
- the exact cache-boundary digest.

`cachePrefixDigest` must stop at the vouched-for boundary, not accidentally include
the rest of the first user message. Same governance plus changed runtime metadata
must produce identical manifest bytes, image bytes, and prefix digest through the
project boundary; changed governance must change all three.

`firstUserSha8` must identify the first live user text after the host-context/
project boundary, not hash the leading reminder. Existing dashboard/session warmth
consumers must use `cache_prefix_sha8 ?? system_sha8` (or a documented compatibility
alias); emitting the new exact digest without making those consumers use it is not
complete. `historyImageSha8` must locate `HISTORY_SYNTHETIC_INTRO` instead of
assuming the synthetic history message is at index zero once a protected prefix
exists.

### 4.6 Configuration and rollback

- Add `compressProjectGuidance?: boolean` to the public transform options; default
  `true` for Anthropic.
- Change Anthropic `compressTools` and generic `compressReminders` defaults to
  `false`. Project guidance is controlled independently by
  `compressProjectGuidance`; setting `compressReminders` must never send recognized
  project context back through the legacy whole-reminder path.
- Extend the public library's deliberately narrow `PxpipeOptions` pick with the
  chosen project/tool/reminder controls. Node continues to rely on core defaults.
  Worker must omit provider-specific option properties when their environment
  variables are unset, so Anthropic can default tools off while OpenAI's independent
  tool-compression default remains on; an explicit shared `false` would regress
  OpenAI.
- Keep runtime-metadata relocation enabled only for exact recognized shapes. An
  internal option may support the live native-vs-tail experiment, but it is not a
  public promise unless the experiment demonstrates operator value.
- Do not ship a permanent `legacy` mode. Reproduce legacy behavior from the pinned
  base commit/worktree during the A/B. Production rollback remains the existing
  pxpipe kill switch / `PXPIPE_DISABLE` path, which returns the original request.
- OpenAI transforms and their configuration are unchanged.

## 5. Implementation slices

Each slice lands as one focused commit on a new branch/worktree from `main` after
owner approval. Run focused tests first and the full verification entry points
before each commit. Do not build on `fix/escape-atlas-missing-glyphs`.

### Slice 1 — Characterize framing and add the lossless partitioner

Files:

- Create `src/core/anthropic-context.ts`.
- Create whole-request sanitized structural fixtures under `tests/fixtures/` for
  direct/imported/no-guidance/malformed opening context and literal system-role
  attachment shapes.
- Create `tests/anthropic-context.test.ts`.

Deliverables:

- A locator for the exact `# claudeMd` span inside the first-user context reminder,
  with exact original-block reassembly.
- Versioned exact project/runtime recognizers.
- Fail-closed unknown and malformed cases.
- Nested imported `AGENTS.md` headings retained as payload.
- Unknown/later `<system-reminder>` blocks retained natively.
- `Message.role` represents the captured `system` role; fixtures establish that it
  is privileged host context, not a user/assistant turn.
- No request behavior change yet.

Guard proof: parser tests fail before the module exists; after implementation they
pass, and round-trip tests prove non-selected content and metadata are byte-exact.

### Slice 2 — Role-bound project-guidance transform

Files:

- Modify `src/core/transform.ts`, `src/core/history.ts`, and `src/core/types.ts`.
- Add `tests/anthropic-role-integrity.test.ts`.
- Update relevant assertions in `tests/render.test.ts`,
  `tests/design-behavior-e2e.test.ts`, `tests/history.test.ts`, and
  `tests/anthropic-cache-align.test.ts`.

Deliverables:

- Native system manifest and inert project-page labels.
- Deterministic reference/page-count/position binding.
- One exported boundary constant/helper used by every emitter and detector in
  `transform.ts` and `history.ts`; no duplicated marker literal remains.
- Project-only profitability gate including manifest overhead.
- Only the selected `claudeMd` span becomes an inert ref placeholder; the reminder
  wrapper/siblings and live user block remain verbatim after the exact boundary.
- All base/unknown system content and tools stay native; the legacy monolithic
  system/tool slab and stubs do not run on the safe default path.
- Generic/unknown reminders stay native and the recognized project carrier cannot
  enter generic reminder compression.
- History collapse cannot absorb or detach the vouched-for leading range.
- History protection extends through contiguous leading `role: "system"`
  attachments; a privileged role inside a later collapse range fails closed rather
  than being serialized as `<user>`.
- `cachePrefixDigest`, `historyImageSha8`, and `firstUserSha8` use the actual shared
  boundary/synthetic marker/live-user position rather than whole-message or index-0
  assumptions.
- Gate/render failure restores the original request region.

Guard proof: against the legacy transform, the role-integrity tests must fail
because native runtime system text leaves `system`, no native manifest exists, the
project reminder is imaged wholesale with volatile siblings, tool docs are mixed
into the system slab, a literal system-role attachment can be serialized as user
history, and boundary consumers are independently coupled to the old literal.
Restore the implementation and prove focused plus full suites green, including a
history-collapse case using the new shared marker and system-role protection.

### Slice 3 — Narrow, vouched-for runtime metadata tail

Files:

- Modify `src/core/anthropic-context.ts` and `src/core/transform.ts`.
- Update `tests/anthropic-role-integrity.test.ts` and
  `tests/cache-stability-e2e.test.ts`.

Deliverables:

- Exact workspace metadata moves to the final user-tail block.
- Native manifest vouches for its position and data-only meaning.
- Instructional reminders and uncertain tags stay native.
- No outgoing text contains the current `Context relocated by pxpipe from the
  system prompt` claim.
- Same governance plus changed environment preserves project images/manifest and
  the cache prefix through their boundary.

Implementation characterization correction: the committed Slice 1 fixture had
simplified the captured `userEmail` value. Claude Code 2.1.205 actually emits the
fixed sentence `The user's email address is <address>.`; Slice 3 corrects and pins
that framing before moving it. The available `<env>`/`<git_status>` examples are
synthetic legacy-compatibility cases rather than whole-block wire captures, while
the installed 2.1.205 `# Environment` builder can mix workspace facts with
operational instructions. Under the plan's fail-closed and non-instructional rules,
Slice 3 v1 therefore moves only the exact captured opening `userEmail`/`currentDate`
suffix. Those native-system shapes remain byte-exact until a sanitized capture
establishes a complete, dedicated, marker-free data-only block; this deliberately
accepts their cache cost rather than reviving the legacy substring regexes.

Guard proof: reverting the slice leaves the exact runtime suffix in its opening
carrier and removes the native runtime manifest/final data block; the new tests
fail. The pinned legacy revision separately demonstrates the obsolete
self-asserted wrapper. Restore and prove the focused and full suites green.

### Slice 4 — Separate tool mode, per-bucket telemetry, and host wiring

Files:

- Modify `src/core/transform.ts`, `src/core/tracker.ts`, `src/core/library.ts`,
  `src/node.ts`, `src/worker.ts`, `src/sessions.ts`, `src/dashboard.ts`, and
  `src/stats.ts` as required.
- Update tracker, proxy-usage, render, and cache-alignment tests.

Deliverables:

- Native tools are the safe default on Node, Worker, and library paths.
- Generic reminder imaging is off by default; project-guidance imaging remains on
  through its independent control.
- Experimental image tools use a separate manifest/gate/reference and install
  stubs only after successful rendering.
- No double counting; project and tool profitability are independent.
- Cache marker count never increases and caller marker ownership is preserved.
- New telemetry fields are optional/backward-compatible for old event rows.
- Worker omission/default tests prove the shared options object does not disable
  OpenAI's independent tool compression when Anthropic defaults tools off.
- Session/dashboard/stats warmth identity prefers the exact cache-prefix digest,
  with `system_sha8` retained only as historical fallback.

Implementation characterization correction: the safe transaction order is
project guidance → closed history → surviving live-tail tool results → optional
tool reference → runtime tail. Compressing tool results before history allowed the
later collapse to remove those generated images while leaving their telemetry
committed, and could make history encode an image placeholder instead of the exact
original result text. All image-producing passes now share a recursive 100-image
budget and final accounting postcondition. History recognizes one caller cache
marker per collapsed message, including a marker nested in tool-result content;
multiple same-message markers or any marker-value/count mismatch fail that history
bucket closed. Tool stubs bind to JSON-escaped, ordinal, per-entry digest framing so
tool-supplied headings or wrapper text cannot impersonate another entry.

Guard proof: reverting the slice re-combines tool docs with project guidance or
restores default tool imaging; bucket-isolation/default tests fail. Restore and run
the full suite.

### Slice 5 — Documentation, migration note, and evaluation harness

Files:

- Update `README.md`, `docs/TRANSFORM_INFO.md`,
  `docs/CACHING_AND_SAVINGS.md`, `docs/HISTORY_CACHE_MODEL.md`, and
  `CHANGELOG.md` where evidence shows a changed contract.
- Add a focused, non-secret evaluation harness/README under `eval/` if existing
  scripts cannot record the required matrix.

Correct documented drift while touching the contract: current docs still describe
dynamic content as remaining in system and describe obsolete placement/threshold
details. Document the native manifest, fail-closed recognition, project/tool split,
runtime tail, safe defaults, telemetry, and rollback.

Do not commit raw system prompts, credentials, full transcripts, or model-output
receipts containing sensitive repository context. Store a redacted matrix with
model IDs, outcome fields, hashes, and aggregate token/cache numbers.

## 6. Automated verification

### 6.1 Required structural matrix

Tests must prove at least:

1. Direct and imported project guidance is recognized only inside the exact captured
   first-user context-reminder framing; a later ordinary user lookalike is ignored.
2. Nested H1s and forged `Contents of ...` lines inside imported `AGENTS.md` do not
   terminate or repartition the complete `claudeMd` bundle.
3. No-guidance, forged, malformed, unsupported-version, unknown-sibling, and
   ambiguous shapes remain native.
4. Native system block order/content, first-user block properties/order, system-role
   messages, and every caller cache marker survive.
5. The native manifest reference/page count matches exactly the leading image
   range and exact end boundary.
6. The reminder wrapper and sibling metadata plus original live-user text/blocks
   remain verbatim after the boundary; only the selected span becomes a placeholder.
7. Project images never contain base runtime system text or tool docs.
8. Tools remain byte-exact by default; experimental tool pages have a separate
   reference and gate.
9. Generic reminders stay native by default; recognized project context cannot
   fall through into whole-reminder imaging.
10. Exact runtime metadata becomes the final data-only block; arbitrary or
   instructional content does not move.
11. No user-role content self-asserts that it came from a system prompt or asks to
    be treated as privileged instructions.
12. Gate/render error is lossless per bucket.
13. Cache-control marker count does not increase; project pages sit before the
    caller-owned live-prompt marker without moving a system/project marker.
14. Same guidance + changed env/live prompt yields stable project
    manifest/images/prefix through the project boundary;
    changed guidance changes their reference and images.
15. Project gate math includes manifest overhead and is unaffected by tool size.
16. A project gate miss does not suppress tool-result or history
    compression.
17. History collapse cannot absorb or detach the role-bound leading blocks; literal
    system-role attachments remain native and can never appear as `<user>` in a
    history image; all
    boundary emitters/detectors use the one shared marker definition.
18. `firstUserSha8` hashes the live user text, `historyImageSha8` finds the synthetic
    history marker at nonzero indices, and warmth consumers prefer the exact prefix
    digest.
19. Existing OpenAI behavior, including default tool compression through a Worker
    options object with no explicit tool override, is unchanged.
20. Telemetry omits source text and remains compatible with older rows.

### 6.2 Commands

Run after every code slice and once more at the final implementation head:

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

For each new behavioral test, prove the guard: observe it fail against the relevant
legacy/reverted behavior, restore the implementation, then observe it pass. A test
that passes against both implementations is not a guard and must be replaced.

## 7. Credentialed live A/B

Automation cannot prove Anthropic classifier behavior. After the automated suite
passes and the owner separately authorizes model calls, run cold, fresh-session
tests with the currently resolved Fable and Sonnet model IDs and record both the
requested and served model.

### 7.1 Stage A — bucket isolation

Use identical benign tasks across an empty repo and AgentGovernanceBootstrap:

| Variant | Source revision/config | Purpose |
|---|---|---|
| OFF | transform disabled | Clean behavioral baseline |
| LEGACY | pinned `b1f5a01` worktree | Confirm historical combined-slab behavior |
| PROJECT | role-bound project pages; tools native; runtime native | Test governance compaction and manifest |
| PROJECT+RUNTIME | chosen design; tools native | Test vouched-for volatile tail |
| TOOLS | project native; experimental image tools | Isolate likely `cyber` bucket |
| BOTH | project and tools independently imaged | Test coexistence without concatenation |

Run at least three cold replicates per cell. Stop a variant on its first safety
refusal, unexpected model switch, or repeated prompt-injection accusation; do not
spend calls proving a known-bad cell is still bad.

### 7.2 Stage B — candidate confirmation

For the candidate default selected by Stage A, run at least five cold sessions per
model in each of:

1. empty repo with a neutral inspect-and-report task;
2. AgentGovernanceBootstrap with imported `AGENTS.md`, asking for a governance
   summary and a harmless read-only task; and
3. `ai-rpg-engine` with a representative read-only documentation task.

Record:

- transform variant and source commit;
- requested and served model;
- stop reason and safety category if present;
- whether fallback occurred;
- whether the model identified the project pages as legitimate project guidance;
- whether it distinguished the owner's live request from rendered guidance and
  runtime data;
- whether it completed the benign task without an injection/refusal loop;
- project/tool image counts and references; and
- input/cache-create/cache-read usage and savings versus OFF.

### 7.3 Acceptance

The default may ship only if:

- every Stage B candidate run has zero `refusal`/`content_filter` stop reasons,
  zero unexpected served-model switches, and zero sustained prompt-injection loops;
- project guidance is followed at the intended priority and the live user request
  remains distinguishable;
- project guidance is actually imaged and shows positive measured token savings
  versus OFF on the governance repos;
- changing only runtime metadata leaves the project image/reference/cache prefix
  stable; and
- the chosen default is no worse than the OFF control on task completion.

Image-tool mode has an independent gate: it stays experimental/native-by-default if
any tool-only or combined candidate fails, even when project-only passes.

If role-bound project-only mode itself fails, stop. Do not weaken the acceptance
criteria or tune banners until a pass appears; return the evidence and unresolved
design choice to the owner.

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Claude Code framing is undocumented and changes | Exact versioned recognizers; sanitized fixtures; unknown shapes remain native; fallback telemetry |
| Claude's unescaped file payload imitates metadata headings | Treat the whole `claudeMd` bundle as one unit; locate the real fixed trailer from the end; ambiguous/unknown sibling shapes remain native |
| Native manifest still does not satisfy Anthropic's classifier | Live bucket-isolation matrix; project-only must pass against OFF before defaulting on |
| A forged user block copies a project reference | Native system vouches for an exact leading block range, count, and boundary inserted before caller content |
| Tool docs remain classifier-toxic | Native default; independent experimental bucket and acceptance gate |
| Runtime wrapper still looks like injection | Native manifest is the only provenance claim; wrapper is data-only; compare runtime-native and runtime-tail variants |
| Moving only project guidance yields less savings | Measure honestly; retain history/tool-result compression; enable tool pages only with independent safety evidence |
| Cache marker changes cause cost regressions | Per-bucket marker ownership tests and stable-prefix A/B; account for manifest overhead and warm-cache burn |
| Parser accidentally drops or reorders instructions | Lossless round-trip tests; per-bucket rollback; unknown/malformed stays native |
| Literal mid-conversation system messages enter history images | Model the `system` role, protect the leading attachment prefix byte-exact, and fail a later collapse closed rather than defaulting unknown roles to user |
| Retry duplicates side effects | No automatic refusal retry |
| New config modes become permanent complexity | No shipped legacy mode; use pinned worktrees/internal eval options; keep the existing global kill switch |

## 9. Out of scope

- Rewording the current banner without changing the trust boundary.
- Treating base system-field text or every reminder as repository guidance.
- Compressing unknown or higher-priority host/runtime instructions.
- General OCR fidelity work, font/glyph changes, or the unrelated
  `fix/escape-atlas-missing-glyphs` branch.
- A general redesign of old-history role flattening. The narrower current-shape
  requirement is in scope: literal `role: "system"` attachments never enter images
  or get relabeled as user content.
- Automatic retry/fallback routing after a safety response.
- Publishing an upstream PR, issue comment, release, or package without a separate
  owner go.

## 10. Review and approval protocol

Review uses a plan-specific adaptation of the repository's synchronous
`review <agent>` discipline. A preimplementation plan cannot honestly claim the
code review playbook's `guard_confirmed: true`, so the Claude reviewer instead
returns a structured `accepted|reopened|invalid` verdict with evidence-backed
must-fix and should-fix items. Every must-fix item requires a plan/source location,
predicted observable failure, and concrete correction. A clean review is valid.

The author independently adjudicates each item as adopted or declined with
evidence, commits the revision, and dispatches a fresh one-shot review against the
new pinned SHA. Malformed/off-schema output gets one schema-restated retry and then
becomes contested. Material disagreement is shown to the owner; consensus is never
manufactured.

Claude runs read-only with pxpipe bypassed so the bug under review cannot alter the
review. An accepted review means only that the plan is ready for owner judgment; it
does not authorize implementation.

### Review log

- Pre-r1 dispatch (2026-07-10, Claude Code 2.1.205 / Sonnet 5): no verdict;
  bounded read pass hit `max_turns=30` and was discarded fail-closed.
- r1 (2026-07-10, Claude Code 2.1.205 / Sonnet 5, reviewed SHA `b6352af`):
  **accepted**, zero must-fix findings, one MEDIUM should-fix finding. Claude
  confirmed the current transform, dynamic-tag, tool-default, and cache-test claims.
  Finding adopted: the rendered-context boundary was coupled through independent
  literals in `transform.ts` and `history.ts`; Slice 2 now owns both files, requires
  one shared exported boundary definition, migrates every consumer, and names the
  history-collapse guard. Revised plan awaits a fresh pinned-SHA review.
- r2 (2026-07-10, Claude Code 2.1.205 / Sonnet 5, reviewed SHA `55e47ad`):
  **accepted**, zero must-fix findings, zero should-fix findings, no open questions.
  Claude verified that all five functional rendered-boundary consumers are covered
  by Slice 2 and that the round-1 history-detachment risk is closed. Consensus
  reached; acceptance makes the plan ready for owner judgment, not implementation.
- Post-r2 characterization (2026-07-10, after owner approval): the plan-required
  local no-network wire capture falsified §2.2/§4.1's placement assumption. Claude
  Code 2.1.205 sends the complete `claudeMd` bundle in the first user-context
  reminder and emits a separate literal system-role attachment; it does not place
  project governance in `req.system`. No product code had changed. Implementation
  paused, the lower-authority plan was amended to the captured request shape, and
  prior approval is not treated as approval of the amendment.
- r3 (2026-07-10, Claude Code 2.1.205 / Sonnet 5, reviewed SHA `4d8ad92`):
  **accepted**, zero must-fix findings, zero should-fix findings, no open questions.
  Claude corroborated the amended request-shape, cache/history, Worker/OpenAI, and
  self-attestation claims against current source and found the revised slices and
  guard proofs coherent and falsifiable. Amendment consensus reached; implementation
  was approved by the owner on 2026-07-10.
