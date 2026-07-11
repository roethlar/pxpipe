# context-correction-slice-5: Public contract and local release documentation

**Severity**: HIGH — the public README, package description, and technical docs
still advertised the exact cross-role rewriting, unsafe savings claims, and
multi-terminal setup that the correction removed.
**Status**: Verified — independently accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `86eb64e9670b11f679bb34600cfda41322d1154a` (base: parent
`b22dabcf610a9d896a47d1a395991bee5617f476`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`, approved and independently accepted.
This record covers Slice 5's public description, technical/migration docs, and
package metadata. The reviewed local package will be built, captured, and
installed only after this documentation head is accepted. Live calls, push,
merge, and one-port routing remain out of scope for this review.

## Evidence

- The previous README claimed system prompts, tool definitions, conversation
  history, OpenAI/Codex/Grok traffic, and relocated runtime metadata were active
  image buckets with generated manifests, labels, factsheets, pointers, and
  behavioral guards.
- The package description repeated the system-prompt/tool-doc/history claim and
  advertised a Cloudflare deployment even though the owner requested a local
  package.
- The previous savings docs described per-bucket estimates and OpenAI savings
  as current behavior instead of the four-measurement Anthropic gate and
  OpenAI pass-through.
- The previous history doc described synthetic-user history collapse as an
  active cache strategy.
- The README documented the explicitly rejected extra-process/extra-port Codex
  and Grok workaround. The approved one-port plan remains paused until this
  correction is installed and passes local checks.
- Pre-release upstream `main` advanced to `8b525a1`; its overlapping Grok
  history/factsheet transform conflicts with the later approved pass-through
  and no-generated-prose requirements and does not solve this correction.

## Predicted observable failure

A user following the old public contract can install or enable a path believing
that system instructions and history will be safely compressed, trust a saving
that was not measured request-wide, or attempt the same multi-terminal routing
workflow the owner rejected. Package listings would continue advertising
behavior that the shipped transform deliberately no longer performs.

## What

The public contract now says exactly what can change: recognized Anthropic
project guidance and safe prose tool-result spans, in their original containers,
only after the complete candidate wins the strict cache-aware gate. It states
that ordinary history stays in place, OpenAI/Codex/Grok bodies are exact
pass-through, current telemetry is hash/count based, and the simple one-port
subscription setup is not yet shipped. It makes no current end-to-end savings
claim.

## Approach

README and package metadata lead with the safety boundary rather than token
savings. The technical docs distinguish per-bucket exclusion from whole-candidate
rollback, disclose normalized no-model prefix measurements, document 1.25/2.0/
0.10 cache rates, and separate dormant helpers/historical rows from active
behavior. The migration text warns that older raw 4xx samples are not silently
deleted. The correction plan records why the newly arrived upstream Grok commit
is not an overlapping solution to adopt.

## Files changed

- `README.md` — current behavior, local package use, unsupported one-port setup,
  telemetry privacy, and limitations.
- `CHANGELOG.md` — correction and migration record without unsupported savings
  claims.
- `package.json` — safety-first local package description.
- `docs/TRANSFORM_INFO.md` — exact active wire contract and telemetry fields.
- `docs/CACHING_AND_SAVINGS.md` — authoritative request-wide gate and signed
  accounting.
- `docs/HISTORY_CACHE_MODEL.md` — retired cross-message history behavior and
  same-container tool-result exception.
- `docs/CONTEXT_HIJACK_CORRECTION_PLAN.md` — implementation-state pointer and
  upstream recheck receipt.

## Guard proof

Coder proof:

1. A source/code audit found and corrected stale claims in all seven files,
   including misleading whole-history, whole-bucket, raw-byte, identifier,
   provider-schema, dashboard-persistence, and raw-telemetry assertions.
2. The final docs passed `tests/docs-integrity.test.ts` (links and anchors), the
   focused installer/OpenAI/request-isolation suite (33/33), and `git diff
   --check`.
3. The reviewed implementation plus these docs passed typecheck, all 859 tests
   across 51 files, and the production build.

Independent reviewer proof in a disposable worktree should at minimum:

1. Check out the reviewed head and replace the seven changed files with their
   base versions from `b22dabcf610a9d896a47d1a395991bee5617f476`.
2. Run a fixed local assertion that requires all of the following current
   claims: README same-container Anthropic behavior, byte-exact OpenAI Chat and
   Responses pass-through, no supported multi-terminal workaround, and hash-only
   telemetry; package description containing `same-container Anthropic` and no
   `system prompt`, `tool docs`, `old history`, or `Cloudflare Workers` claim;
   technical docs containing the 1.25/2.0/0.10 rates and retired cross-message
   history boundary. The base files must fail.
3. Restore all seven files from the reviewed head, rerun the assertion and
   `pnpm exec vitest run tests/docs-integrity.test.ts`; both must pass.
4. Compare every current claim against the active transform, proxy, admission,
   tracker, Node, installer, and tests. Confirm the tracked worktree is clean,
   then run `pnpm run typecheck && pnpm test && pnpm run build`, using the pinned
   npx pnpm fallback when needed.

## Coder dispute (if any)

Empty.

## Known gaps

- Package creation, digest verification, the hash-only no-network capture,
  installation, and running-source verification follow acceptance of this head.
- The one-port subscription plan remains intentionally paused until that local
  installation and capture pass. The rejected multi-terminal workaround is not
  documented as a supported alternative.
- The corrected live A/B matrix has not run, so no current end-to-end savings
  percentage is claimed.
- No live product model call, push, merge, release, or upstream contribution is
  authorized by this review.

## Reviewer comments

- R1 (2026-07-11T04:23:45Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-context-correction-s5-r1`.
  - Reviewed SHA: `f58b34ff3a9e0edc373bc3403f57249968655331`.
  - Base SHA: `b22dabcf610a9d896a47d1a395991bee5617f476`.
  - `guard_confirmed: true` — the reviewer restored all seven public/docs/
    package files from the base and confirmed that the fixed contract assertion
    failed, restored the reviewed head and confirmed that it passed, then ran
    the documentation integrity test and the complete repository gate.
  - Verdict: **accepted**.
  - Comments: none.

The JSON envelope exited zero and matched the required schema and both pinned
SHAs. Eight ancillary compound/`rtk`/temporary-script Bash attempts were denied;
the required base failure, head pass, source consistency inspection, docs check,
and final gate completed through allowed commands. The tracked review worktree
was clean after restoration; its only untracked entry was the temporary
`node_modules` symlink. Acceptance does not authorize a live product call, push,
merge, release, or the paused one-port routing implementation.
