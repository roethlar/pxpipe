# context-correction-telemetry-privacy: Keep private request data out of telemetry

**Severity**: HIGH — a provider 4xx or malformed request could persist private
prompts, project text, host identity, dates, or upstream error text in JSONL,
console output, or sidecar files.
**Status**: Verified — independently accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `a1e3bc40af2c45aea733bb94f849341487f84fa5` (base: parent
`c8e75344503b95b3432d6b3deb2bf39972dc516d`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md` requires telemetry to contain no
source text or personal data. This finding closes a pre-package acceptance gap
discovered during Slice 5 documentation audit. Documentation, packaging,
installation, live calls, push, merge, and one-port routing are out of scope.

## Evidence

- `src/core/proxy.ts` previously copied the first 2 KiB of every upstream 4xx
  body and gzipped the complete forwarded request into `ProxyEvent`.
- `src/core/tracker.ts` serialized those values inline or as a sidecar path and
  also projected legacy `info.env` values including cwd, branch, OS, and date.
- `src/node.ts` printed the upstream 4xx body and wrote oversized request
  samples beneath `~/.pxpipe/4xx-bodies/`.
- Modern `JSON.parse` errors can quote the malformed input; the Anthropic
  transform and proxy exception paths previously persisted exception messages.
- Upstream `main` advanced to `8b525a1` during this audit. That commit does not
  touch these telemetry, proxy, Node, or session paths and supplies no
  overlapping fix.

## Predicted observable failure

A synthetic request containing a private marker followed by a 400 response can
leave that marker recoverable from `ProxyEvent`, `events.jsonl`, console output,
or a gzip sidecar. A malformed request or thrown exception can echo its marker
through `reason` or `error`. Legacy `info.env` values can expose a username,
private project, branch, host, or caller date even without a 4xx.

## What

Current events retain status, timing, usage, signed accounting, and a short
request hash, but never retain model request bodies, upstream error bodies,
arbitrary exception messages, or host/workspace identity. Error responses are
left as client-only streams and reach the caller unchanged. Historical sidecars
remain readable only so the existing cleanup UI can account for and prune old
data; current code creates no new sidecar.

## Approach

`src/core/proxy.ts` no longer tees errors or gzips requests and emits only fixed
`transform_error` / `upstream_error` codes. `src/core/tracker.ts` projects only
those fixed codes and drops legacy raw-body and environment fields even if a
caller supplies them. `src/core/transform.ts` uses a fixed `parse_error` reason.
The Node writer/logger was removed while `src/sessions.ts` keeps a narrow
read-only compatibility cast for old sidecar paths.

## Files changed

- `src/core/proxy.ts` — client-only error streams, hash-only request
  correlation, fixed exception codes.
- `src/core/tracker.ts` — no raw-body or host-identity projection; fixed error
  allowlist.
- `src/core/transform.ts` — non-echoing malformed-JSON reason.
- `src/node.ts` — remove raw 4xx console logging and sidecar creation.
- `src/sessions.ts` — read legacy sidecar paths only for cleanup.
- `tests/proxy-usage.test.ts`, `tests/tracker.test.ts`,
  `tests/sessions.test.ts` — privacy, unchanged-client-response, fixed-error,
  legacy-cleanup, and hash-retention guards.

## Guard proof

Coder proof:

1. Against the old proxy/tracker behavior, the four new raw-body privacy cases
   failed because 4xx response text, a complete request sample, or legacy host
   fields were present. Restoring the correction made all focused cases pass.
2. Temporarily restoring the retired `error_body` projection made the tracker
   privacy guard fail 1/25. Restoring the sanitizer made it pass.
3. Temporarily restoring the dynamic JSON parse message made the marker guard
   fail 1/25 with the private marker inside `reason`. Restoring fixed
   `parse_error` made it pass.
4. Temporarily restoring arbitrary proxy exception messages and arbitrary
   tracker error projection made all three fixed-error guards fail. Restoring
   the fixed codes made the focused privacy suite pass 78/78.
5. The final implementation passed typecheck, all 859 tests, and the production
   build.

Independent reviewer proof in a disposable worktree should at minimum:

1. Check out the reviewed head, then replace `src/core/proxy.ts`,
   `src/core/tracker.ts`, and `src/core/transform.ts` with their base versions
   from `c8e75344503b95b3432d6b3deb2bf39972dc516d`.
2. Run
   `pnpm exec vitest run tests/proxy-usage.test.ts tests/tracker.test.ts -t 'client-only|fixed transform error|fixed upstream error|legacy host|malformed request|legacy raw body|fixed proxy error'`.
   The private-marker, raw-body, environment, or fixed-error guards must fail.
3. Restore those three files from the reviewed head and repeat the focused
   command; it must pass. Confirm current `src/node.ts` contains no 4xx body
   logger or sidecar writer and current `src/sessions.ts` only reads legacy paths.
4. Confirm the tracked worktree is clean, then run
   `pnpm run typecheck && pnpm test && pnpm run build`, using the pinned npx pnpm
   fallback when pnpm is off PATH. It must pass.

## Coder dispute (if any)

Empty.

## Known gaps

- Older event rows and sidecar files may already contain request data. This
  correction does not silently delete owner data; the existing cleanup path
  remains available.
- The short request hash, route, model id, status, timing, counts, and event
  timestamp remain intentional diagnostics. Raw prompts, upstream error text,
  caller email/current-date values, and host/workspace identity do not.
- No live model call, package install, push, merge, or paused one-port routing
  work is authorized by this review.

## Reviewer comments

- R1 (2026-07-11T04:12:50Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-telemetry-privacy-r1`.
  - Reviewed SHA: `0db62b16880070eac05b022265848aa6fbb90d52`.
  - Base SHA: `c8e75344503b95b3432d6b3deb2bf39972dc516d`.
  - `guard_confirmed: true` — the reviewer restored the base proxy, tracker,
    and transform and observed all seven targeted privacy guards fail with
    private request, response, environment, parse, or exception markers present;
    restoring the reviewed head made all seven pass.
  - The reviewer confirmed that Node no longer logs or writes 4xx bodies, that
    session code only reads legacy sidecars for cleanup, and that error responses
    still reach the client unchanged.
  - The reviewed head passed typecheck, all 859 tests across 51 files, and the
    production build.
  - Verdict: **accepted**.
  - Material comments: none. One non-blocking diff-noise note identified an
    unused catch binding in an unrelated response-measurement guard; it has no
    behavioral, typecheck, test, or build effect and is not part of this finding.

The JSON envelope exited zero and matched the required schema and both pinned
SHAs. Six ancillary `rtk`/no-op Bash attempts were denied; none was a required
revert, focused guard, restore, inspection, or final gate command. The tracked
review worktree was clean after restoration; its only untracked entry was the
temporary `node_modules` symlink. Acceptance does not authorize installation,
live product calls, push, merge, or paused one-port routing work.
