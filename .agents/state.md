# Agent State

This is the first current-state entry point. Detailed verdicts and counts live
in the files linked below rather than being copied here.

## Now

- The no-context-hijack correction on `fix/provenance-safe-compression` is
  implemented and independently accepted; see
  `docs/CONTEXT_HIJACK_CORRECTION_PLAN.md` and `.agents/review/index.md`.
- As of accepted source `59e2b9a`, the clean local package passed its offline
  capture and is the healthy installed login service on loopback port 47821.
  The canonical package/install receipt is
  `.agents/review/findings/context-correction-slice-5.md`.
- Machine-local (`nagatha`): the durable bundle and hash-only capture are in
  `/Users/michael/Dev/pxpipe-deploy`; the installed release is under
  `~/Library/Application Support/pxpipe/releases/59e2b9a618af6faba6c54390970e62484ea501c1`.
  No delivery artifact is stored under `/private`. Older raw logs and sidecars
  remain untouched pending an explicit owner decision.
- Upstream `main` was `8b525a1` at the final correction recheck. Its Grok
  imaging conflicts with the later exact-pass-through rule and was not imported.
- One-port subscription routing Slices 1 and 2 are independently accepted.
  Slice 3's transactional installer and exact Codex/Grok client configuration
  are implemented at `44c121e` and pending independent Claude review; the
  canonical status and guard evidence live in
  `docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md` and `.agents/review/index.md`.
- The glyph-escape workstream remains separate and is not the purpose of this
  branch.

## Next

- Run independent Claude review of one-port Slice 3. If accepted, proceed to
  the separately scoped owner-facing package and local validation in Slice 4.
- Any live subscription smoke, corrected live A/B matrix, push, merge, or
  upstream contribution remains separately owner-gated.

## Blockers

- One-port Slice 3 is blocked only on its independent Claude implementation
  review; Slice 4 has not started.
- No blocker remains for the installed no-hijack correction.

## Verification

- Canonical commands: `.agents/repo-guidance.md` (Verification).
- Correction proofs and install receipt: `.agents/review/index.md` and
  `.agents/review/findings/context-correction-slice-5.md`.

## Active Sources

- `AGENTS.md`
- `.agents/repo-guidance.md`
- `.agents/decisions.md`
- `.agents/state.md`
- `docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`
- `docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`
- `.agents/review/index.md`

## Unrecorded Repo Memory

- None known.
