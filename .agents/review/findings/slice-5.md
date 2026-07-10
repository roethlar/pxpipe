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
(pending)
