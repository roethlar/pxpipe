# slice-5: Documentation, migration note, and evaluation harness

**Severity**: N/A — implementation slice under review, not a defect finding
**Status**: In progress
**Branch**: `fix/provenance-safe-compression`
**Commit**: `162a00f` (base: parent `e8c87da`)

## Plan authority
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` §Slice 5: update the named docs
"where evidence shows a changed contract", correct the called-out drift
(dynamic content described as remaining in system; obsolete placement/
threshold details), document the native manifest / fail-closed recognition /
project-tool split / runtime tail / safe defaults / telemetry / rollback,
and add a focused non-secret evaluation harness under `eval/` because the
existing scripts cannot record the §7 matrix.

## What the slice claims
- `docs/TRANSFORM_INFO.md` rewritten around the provenance partition
  (`anthropic-context.ts`), native manifests, bucket table with code-verified
  defaults, marker rules (`never adds`, tool_result marker onto last image,
  history re-plant, ambiguity fail-closed), fingerprints, and
  fail-closed-replaces-canary (the `unknownStaticTags` emitter is gone; the
  field/consumers remain for old rows).
- `docs/CACHING_AND_SAVINGS.md`: transformed-shape diagram and key invariant
  updated (marker count never increases; caller live-prompt marker unmoved;
  project pages ride before it).
- `docs/HISTORY_CACHE_MODEL.md`: relocation story → preserve/re-plant
  contract; slab-anchor protection → role-bound project carrier +
  contiguous system attachments; §7 `protectedPrefix` note corrected.
- `README.md`: tagline/try-it/how-it-works/compress-list no longer claim the
  system prompt and tool docs are imaged; example-render caption labeled as
  a pre-0.9 artifact.
- `CHANGELOG.md`: Unreleased entry (trust-boundary changes, added options/
  telemetry, migration notes; release gated on plan §7).
- `eval/provenance-ab/`: README (variants, redaction rules, §7.3 acceptance
  verbatim), `variant-proxy.mjs` (createProxy + per-variant overrides,
  loopback, JSONL TrackEvents), `run-variant.sh` (cold replicates, safety
  early-stop), `collect.mjs` (redacted matrix). `runs/` gitignored.
- No `src/` or `tests/` changes in this slice.

## Files changed
- `docs/TRANSFORM_INFO.md` (rewritten), `docs/CACHING_AND_SAVINGS.md`,
  `docs/HISTORY_CACHE_MODEL.md`, `README.md`, `CHANGELOG.md`, `.gitignore`
- New: `eval/provenance-ab/{README.md,variant-proxy.mjs,run-variant.sh,collect.mjs}`

## Guard proof (docs+eval slice — behavioral checks in lieu of revert-proof)
Docs-only content has no unit guard; verify instead:
1. Doc claims vs code: spot-check every default/symbol the docs assert
   (`DEFAULTS` in `src/core/transform.ts`; manifest tags/labels;
   `messageCacheControls` fail-closed reasons; `cachePrefixDigest` boundary
   preference; no `unknownStaticTags` setter anywhere in `src/`).
2. `npm test` green (37 files / 749 — includes the docs link-integrity
   suite covering the edited files), `npm run typecheck`, `npm run build`.
3. `node --check` both `.mjs` scripts; `bash -n` the driver.
4. Optional live smoke (no credentials needed): start
   `variant-proxy.mjs --variant OFF` on a free port, POST a dummy
   `/v1/messages` with a bogus key → upstream 401 relayed and one TrackEvent
   row written to the `--log` file.

## Known gaps
- The §7.1 `PROJECT` cell (runtime forced native) is not config-expressible
  on the current build; the README documents the disposable-worktree
  neutralization instead. Deliberate (plan §4.6 allows but does not require
  an internal option).
- The live matrix itself has NOT run — separately owner-gated.
- `unknownStaticTags` dead consumers in `src/node.ts`/`src/stats.ts` and the
  stale field comment in `TransformInfo` are code, out of slice-5 scope;
  documented in TRANSFORM_INFO §7 as compatibility leftovers.

## Reviewer comments
- Reviewer: codex-cli 0.144.1 (`codex exec --json --sandbox workspace-write`,
  stdin prompt), disposable worktree `/private/tmp/pxpipe-review-slice5`.
- Reviewed SHA: `162a00faa6d4b0bca74c4254ce238d4bc337c5be`;
  base SHA: `e8c87da8828595879733b6ebc61ddac95b4375c8`.
- `guard_confirmed: true` (doc-vs-code audit + npm test + typecheck run by
  the reviewer).
- Verdict: **reopened** (2026-07-10 ~11:20 UTC), 14 comments (verbatim):
  1. "README.md:111 — The live diagram still claims 1928px/~92,000 chars per
     tool-result page, but src/core/transform.ts:1181-1186 uses
     src/core/render.ts:32-39's 312-column, 28,080-char, 728px limits; a
     ~92k result renders as roughly four <=1568x728 pages, invalidating the
     documented page/token estimate."
  2. "README.md:117 — It says a native system manifest vouches for every
     rendered page, but compressSafeToolResults
     (src/core/transform.ts:1941-2143) and collapseHistory
     (src/core/history.ts:829-839) emit pages without manifests; a
     tool-result-only request produces images while system receives no
     provenance manifest."
  3. "README.md:183 — 'Everything else passes through byte-identical' omits
     the non-image runtime rewrite: src/core/transform.ts:1466-1489 deletes
     recognized userEmail/currentDate from the opener, appends a final-user
     block, and adds a system manifest, so even a no-image
     recognized-runtime request changes bytes."
  4. "README.md:187 — 'Content is imaged only when an exact versioned
     recognizer identified it' (also docs/TRANSFORM_INFO.md:221 and
     CHANGELOG.md:17) is false for independent tool-result/history paths at
     src/core/transform.ts:2044-2139 and :2237-2295; an unknown
     opening-context shape can remain native while profitable tool/history
     content is still imaged."
  5. "docs/TRANSFORM_INFO.md:67 — The final-wire diagram puts the runtime
     manifest before the tool manifest and line 73 says only claudeMd
     changes in the opener; transformSafeAnthropicRequest applies tools
     before runtime (src/core/transform.ts:2312-2328), and
     applyRuntimeMetadataTail removes the runtime suffix, so BOTH output has
     project/tool/runtime manifest order and the opener also loses runtime
     metadata."
  6. "docs/TRANSFORM_INFO.md:179 — The documented legacy whole-reminder
     imaging path does not exist: src/core/transform.ts:2415-2418 explicitly
     keeps unknown reminders native, and no transform pass reads
     compressReminders; enabling the documented flag produces no reminder
     images."
  7. "docs/TRANSFORM_INFO.md:203 — It calls historyImageSha a hash of image
     bytes, but historyImageSha8 concatenates base64 source.data strings and
     hashes that text (src/core/transform.ts:745-753); hashing decoded PNG
     bytes cannot reproduce the logged history_image_sha8."
  8. "docs/CACHING_AND_SAVINGS.md:216 — The summary retains the obsolete
     global marker-relocation story; the project splice at
     src/core/transform.ts:1614-1623 prepends pages/boundary while leaving
     the live-prompt marker block untouched, so output keeps that marker on
     the caller prompt rather than relocating it to the rewritten project's
     end."
  9. "docs/HISTORY_CACHE_MODEL.md:163 — It says a billing line and dynamic
     <env> are spliced after the breakpoint, but applyRuntimeMetadataTail
     (src/core/transform.ts:1425-1489) only moves exact opening
     userEmail/currentDate metadata and native <env> system blocks remain
     byte-exact; current output never has the documented billing/dynamic-env
     splice."
  10. "docs/HISTORY_CACHE_MODEL.md:194 — It says the stable prefix defined
      at line 190 as system prompt, tool docs, reminders, and history is
      swapped to images, but DEFAULTS has compressTools=false
      (src/core/transform.ts:136-145) and src/core/transform.ts:2415-2417
      preserves native system/tools; default output therefore contradicts
      this leftover monolithic-slab model."
  11. "eval/provenance-ab/run-variant.sh:46 — The PROJECT refusal instructs
      --variant PROJECT_RUNTIME --legacy-dir <patched>, but lines 64-69
      consult LEGACY_DIR only for variant LEGACY; following the instruction
      ignores the patched worktree and runs the current PROJECT+RUNTIME
      proxy, producing the wrong billed isolation cell."
  12. "eval/provenance-ab/run-variant.sh:104 — Early-stop checks only
      safety_flagged/refusal and never inspects turn modelUsage or output;
      an unexpected served-model switch or repeated injection accusation
      proceeds to later replicates, contrary to plan §7.1, spending extra
      calls and contaminating the cell."
  13. "eval/provenance-ab/collect.mjs:45 — task_outcome is derived only from
      Claude JSON is_error, and the returned row at lines 60-87 has no
      source commit, fallback flag, project-legitimacy/live-request
      distinction, injection-loop judgment, or tool disposition despite
      README.md:87; a non-error injection accusation is recorded completed
      and LEGACY/patched PROJECT rows cannot prove their build, so
      §7.2/§7.3 cannot be evaluated from the matrix."
  14. "eval/provenance-ab/collect.mjs:32 — The greedy run-name regex cannot
      preserve hyphenated workspace labels written verbatim by
      run-variant.sh:55; a required Stage-B label such as
      PROJECT_RUNTIME-ai-rpg-engine parses as variant
      PROJECT_RUNTIME-ai-rpg and workspace engine, corrupting matrix
      identifiers."

## Coder adjudication

### Finding 1 — adopted; resolved by newer main-branch documentation

`f70e530` merged canonical `main` at `8d7ba3e` while preferring its current
model-profile geometry. `README.md` now describes Claude's 1568×728 pages and
model-selected profiles; the obsolete 1928×1928 / ~92,000-character claim is
absent from the live README. The merge preserved the provenance-safe code and
passed typecheck, all 770 tests, and build. No additional product change is
needed for this finding.

### Finding 2 — adopted; resolved by newer main-branch documentation

The merge removed the false blanket claim that a native manifest vouches for
every rendered page. The live README now limits that statement to recognized
project-guidance pages. Tool-result and history images remain listed as
separate compression paths without a manifest claim, matching the code. No
additional product change is needed for this finding.

### Finding 3 — adopted and fixed

The README no longer says every non-imaged byte passes through unchanged. It
now names the exact `userEmail` / `currentDate` move that can occur without an
image, the final data-only block, and the native system note, while preserving
the fail-closed statement for unknown opening shapes. The focused
project-disabled runtime-tail test and documentation checks cover this claim.

### Finding 4 — adopted and fixed

The global recognizer claim is gone from the README and changelog after the
main-branch merge. `docs/TRANSFORM_INFO.md` now limits exact recognition to
host-context buckets and explicitly separates history and tool-result imaging,
which retain their own checks even when an unknown opening stays native. The
existing unknown-opening/history test and documentation checks cover the
described behavior.

### Finding 5 — adopted and fixed

The final-wire diagram now follows the implemented manifest order: project,
optional tool reference, then runtime. It also names both opening-carrier
changes: the project span becomes a reference and the recognized runtime
suffix moves to the final data-only block. This is a documentation correction;
the existing project, tool-reference, and runtime-tail tests verify the three
implemented passes without adding a test that would already pass unchanged.

Findings 6–14 remain pending individual adjudication against the merged head.
