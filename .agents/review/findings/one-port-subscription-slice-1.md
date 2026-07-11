# one-port-subscription-slice-1: Core reserved subscription router

**Severity**: HIGH — this route owns subscription credentials and destination
selection for Codex and Grok
**Status**: In Review
**Branch**: `fix/provenance-safe-compression`
**Commit**: `e11154ec883301e60d4d7642c2d7546ed2050fca` (base
`5ad480d18a63fdba2a37640c32bdc9e55f3d6afe`)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, approved after Claude R4 and a
separate clean audit. This is Slice 1 only: pure/core reserved routing. Raw Node
request-target validation and environment wiring remain Slice 2; installer and
client configuration remain Slice 3.

## Evidence and predicted failures

Before this slice, bare OpenAI-compatible paths could be heuristically routed but
there was no fixed local namespace separating Codex from Grok. The core also
resolved generic gateway configuration eagerly, had an incomplete hop-by-hop
filter, reconstructed queries through `URL.search`, and allowed Fetch redirects.
That could break `/responses/compact` or Grok auxiliaries, lose a trailing `?`,
drop or leak credential metadata, let generic keys/gateway headers alter a
subscription request, or follow subscription metadata outside the fixed vendor.

## What changed

- Added a pure fail-closed classifier for the exact Codex Responses/compact/
  models and Grok Responses/models/settings/login/subagent routes.
- Added independent HTTPS base validation and exact serialized-query extraction.
- Routed the reserved namespace before generic configuration, compression,
  dashboard settings, API-key replacement, or gateway injection.
- Preserved POST bodies byte-for-byte with native OpenAI telemetry and zero
  images/savings/probes; auxiliary GETs invent no body or transform record.
- Completed fixed and `Connection`-nominated hop-by-hop filtering in both
  directions. A nominated authorization/account/X-XAI/X-Grok credential fails
  locally instead of forwarding a partial credential set.
- Restricted model telemetry to an own top-level string, kept route selection
  path-only, used manual redirect mode, rejected followable vendor redirects
  locally, and preserved non-followable 304 cache responses.
- Deferred hostile generic configuration errors until generic traffic so either
  reserved vendor remains independent of generic and sibling-vendor settings.

## Files changed

- `src/core/subscription-routing.ts`
- `src/core/proxy.ts`
- `tests/subscription-routing.test.ts`

## Coder guard proof

With the focused suite initially green:

1. Changing the reserved prefix so no route classified made 56 of 77 focused
   tests fail.
2. Disabling the reserved nominated-credential rejection made the three new
   account/X-XAI/X-Grok zero-fetch tests fail; nominated authorization still
   failed through the missing-auth guard.
3. Restoring the old first-match model regex made the nested-before-top-level
   telemetry test fail (`nested-private` leaked instead of `top-level-safe`).
4. Removing `redirect: "manual"` made the redirect-mode guard fail; disabling
   local redirect rejection made the redirect status/location guard fail.
5. Treating 304 as a redirect made the auxiliary-cache passthrough guard fail.
6. Restoring every safeguard made the focused routing/gateway/isolation suite
   pass 106/106.

The committed source then passed typecheck, all 941 tests across 53 files, and
the production build. A separate read-only implementation audit found the final
diff clean and left the raw-target boundary explicitly to Slice 2.

## Independent reviewer proof

Claude should review exact intake and base SHAs, then in its disposable worktree:

1. Inspect every classifier/base/query branch and the reserved branch in
   `createProxy`; trace all headers, bodies, telemetry, errors, and destinations.
2. Temporarily restore only `src/core/proxy.ts` from the base while retaining the
   reviewed helper and tests. The focused integration suite must fail because
   reserved requests fall into generic routing.
3. Restore the reviewed proxy and run
   `tests/subscription-routing.test.ts`, `tests/gateway.test.ts`, and
   `tests/request-isolation.test.ts`; all 106 tests must pass.
4. Independently perturb the nominated-credential, own-top-level-model,
   redirect-manual/fail-closed, or 304 exception guard and confirm its named test
   fails; restore it and confirm the focused suite passes.
5. Confirm the tracked tree is clean and run
   `pnpm run typecheck && pnpm test && pnpm run build` with the pinned npx pnpm
   fallback when needed.

No live model/subscription call, web access, push, merge, packaging, installation,
or Node raw-target work is authorized by this review.

## Reviewer comments

Pending Claude R1.

