# Agent State

This is the first current-state entry point. Detailed verdicts and counts live
in the files linked below rather than being copied here.

## Now

- The no-context-hijack correction on `fix/provenance-safe-compression` is
  implemented and independently accepted; see
  `docs/CONTEXT_HIJACK_CORRECTION_PLAN.md` and `.agents/review/index.md`.
- Accepted source `e5c4ed6` is the healthy installed login service on loopback
  port 47821. Its installer receipt and current release both name that exact
  source. The prior no-context-hijack install receipt remains recorded at
  `.agents/review/findings/context-correction-slice-5.md`.
- Machine-local (`nagatha`): the durable package is in
  `/Users/michael/Dev/pxpipe-deploy`; the installed release is under
  `~/Library/Application Support/pxpipe/releases/e5c4ed65416af4b4da0415345d437d85f71b9c30`.
  No delivery artifact is stored under `/private`. The verified legacy launcher
  is preserved in the deploy directory; older raw logs and sidecars remain
  untouched pending an explicit owner decision.
- Upstream `main` was `8b525a1` at the final correction recheck. Its Grok
  imaging conflicts with the later exact-pass-through rule and was not imported.
- One-port subscription routing Slices 1–4 are independently accepted. Slice 4
  is implemented at `c39745d` and accepted at reviewed head `8c9180b`. Its exact
  package is in the durable deploy directory. Two installs safely rolled back
  when launchd briefly retained a PID before reporting `running`; bounded retry
  fix `c1521f8` is accepted at reviewed head `e5c4ed6`. No real client or model
  request ran. The real offline check then stopped before client execution on
  Codex's npm alias layout; exact identity fix `129ef35` is accepted at reviewed
  head `6912f53`. The staged commands next exposed missing metadata-only path
  resolution in the sandbox. Exact rule `04861f2` is accepted at reviewed head
  `33bb29e`; no output or live request ran.
  Canonical status and guard evidence live in
  `docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md` and `.agents/review/index.md`.
- The glyph-escape workstream remains separate and is not the purpose of this
  branch.

## Next

- Package and install exact reviewed head `33bb29e`, then rerun both offline
  parsers and verify one listener plus installed source.
- Any live subscription smoke, corrected live A/B matrix, push, merge, or
  upstream contribution remains separately owner-gated.

## Blockers

- No blocker remains for packaging and production offline validation. The
  current reviewed service remains healthy.
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
