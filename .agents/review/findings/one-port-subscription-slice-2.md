# one-port-subscription-slice-2: Node raw-target and environment boundary

**Severity**: HIGH — this boundary must prevent normalized paths or hostile
ambient settings from changing a subscription credential destination
**Status**: In Review
**Branch**: `fix/provenance-safe-compression`
**Commit**: `5afc19af853f0cb26dae70d76c12df9059027a64` (base
`9efbbf44beb735b56ed5bf80424afde04b027ec9`)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, Slice 2. The core reserved router
was accepted in Slice 1. Transactional client configuration and installation
remain Slice 3; packaging and installed-flow validation remain Slice 4.

## Evidence and predicted failures

The Node host previously constructed WHATWG URLs before validating the raw
request target. Dot segments, encoded dots, backslashes, absolute forms, and
same-scheme relative forms can normalize into, out of, or between reserved
namespaces. Client-controlled Host/X-Forwarded-Proto text could also move a
valid reserved path into generic routing. Unknown providers, malformed gateway
headers, and the eager startup log could terminate the service before a valid
reserved request. A whitespace OpenAI key could create `Authorization: Bearer`.

## What changed

- Added a pure raw-target validator that isolates absolute-form authorities,
  models the WHATWG dot/backslash and same-scheme rewrites, and fail-closes
  reserved-looking absolute, traversal, malformed/encoded separator/percent,
  fragment, empty, duplicate, non-leading, and prefix-lookalike targets.
- Ran that validator before dashboard or Web Request construction. Node-parser
  rejections remain local 400s; application-reachable unsafe targets receive a
  fixed JSON 404. Both paths perform zero fetches.
- Constructed dashboard and proxy URLs against a fixed local origin so Host and
  X-Forwarded-Proto cannot affect route classification.
- Read the fixed Codex/Grok upstream environment values and passed them to the
  core independently. Blank OpenAI keys normalize to unset while nonblank values
  remain byte-for-byte unchanged.
- Converted unknown/malformed generic provider, gateway base, and gateway
  header settings into the existing deferred generic configuration error. The
  startup logger now warns instead of terminating; reserved traffic remains live.
- Added real child-process/raw-socket coverage plus a native Node client wire
  trap for exact query order, spelling, duplicates, empty values, `+`, percent
  case, and a bare trailing question mark. All traps are loopback-only.

## Files changed

- `src/node-target.ts`
- `src/node.ts`
- `tests/node-subscription-boundary.test.ts`

## Coder guard proof

With the focused boundary/core suite green at 113/113:

1. Bypassing the pre-URL raw guard made the absolute-form trap route upstream
   and return 200 instead of the required local 404.
2. Restoring the client-controlled Host URL bridge sent the Host-injection case
   to `api.anthropic.com/ordinary/_pxpipe/...` instead of the fixed Codex base.
3. Passing a whitespace OpenAI key through unchanged emitted
   `Authorization: Bearer`; restoring blank-to-unset preserved absent or caller
   authorization correctly.
4. Restoring eager failure for an unknown provider made the child exit before
   listen; the deferred version kept the reserved route live and generic traffic
   on its fixed local configuration error.
5. Removing a bare trailing `?` in the bridge changed the native wire request
   line and failed the exact-query test.
6. Removing same-scheme-relative isolation made
   `http:_pxpipe/codex/../grok/...` validate as safe; the restored guard rejects
   literal, encoded-dot, and backslash variants. Node's HTTP parser independently
   rejects those wire forms with local 400 and zero fetches.

After restoration, typecheck, all 948 tests across 54 files, the production
build, and the built-version smoke check passed. Two read-only audits drove the
Host/origin, backslash/lookalike, hostile-setting, wire-query, gateway-validation,
and same-scheme fixes. The final audit accepted the stable file hashes
`cdff546e...`, `17d252a0...`, and `840c671a...` with no remaining finding.

## Independent reviewer proof

Claude should review the exact intake and base SHAs in a disposable worktree:

1. Trace every raw target through `validateRawRequestTarget`, dashboard routing,
   `toWebRequest`, and the Slice 1 classifier. Confirm no accepted serialization
   can normalize into, out of, or between reserved vendors.
2. Temporarily bypass the Node raw guard. The raw-socket attack test must fail
   by performing an upstream fetch; restore and confirm local 404/400 plus zero
   fetches.
3. Temporarily restore the old Host-concatenating URL bridge. The Host injection
   destination trap must fail; restore and confirm both Host and
   X-Forwarded-Proto cases reach only the fixed vendor.
4. Independently perturb blank-key normalization, deferred generic settings, the
   same-scheme candidate, or bare-`?` preservation. Its named child/socket/wire
   guard must fail; restore and pass all seven Node boundary tests.
5. Run the focused boundary/core suite, typecheck, all tests, and production
   build. Confirm the tracked worktree is clean after every temporary mutation.

No live model/subscription call, web access, push, merge, packaging,
installation, or Slice 3 work is authorized by this review.

## Reviewer comments

Pending Claude R1.
