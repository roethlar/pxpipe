# one-port-codex-alias: exact installed architecture-package identity

**Severity**: MEDIUM — installation succeeds safely, but the required offline
Codex parser check stops before execution when it misidentifies the signed npm
alias package
**Status**: Accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `129ef35fd7ea5918f09104cc42346eb8033cd78d` (base
`100121e5320d60103fce25b86f851366fed969eb`)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, Slice 4 offline parser validation.
The corrected reviewed service at `e5c4ed6` is installed and healthy; neither
real client parser ran before this validation stopped.

## Evidence and predicted failure

The first real offline parser check failed before spawning either staged client:

`@openai/codex-darwin-arm64 package metadata does not match the expected identity`

Machine-local public package metadata shows why. The root Codex package is
`@openai/codex` version `0.144.1` and declares
`@openai/codex-darwin-arm64 = npm:@openai/codex@0.144.1-darwin-arm64`.
The aliased package directory is named `@openai/codex-darwin-arm64`, but its own
manifest correctly says name `@openai/codex`, version
`0.144.1-darwin-arm64`, operating system `darwin`, and CPU `arm64`. The initial
synthetic fixture instead assumed the directory alias was the internal package
name and reused the root version.

The observable failure is that the required no-network validation cannot reach
Codex's configuration parser even though the installed native binary has the
expected signed layout.

## What changed

- The root package must bind the current architecture alias to exactly
  `npm:@openai/codex@<root-version>-darwin-<architecture>`.
- The aliased package must identify itself as `@openai/codex`, use that exact
  suffixed version, and contain only the matching `darwin` operating-system and
  CPU entries.
- The existing self-contained root vendor layout remains supported without an
  alias. Native architecture, executable safety, hash, version output, and
  source/target rechecks remain unchanged.

## Files changed

- `src/macos-client-parser-validation.ts`
- `tests/macos-client-parser-validation.test.ts`

## Coder guard proof

- Inverting the exact root alias comparison made the new alias-binding test turn
  red; restoring it returned the focused file green.
- Separate guards reject a wrong internal name, missing architecture suffix,
  wrong operating system, and wrong CPU before any sandbox runner call.
- The direct embedded layout and architecture-package symlink-retarget guard
  remain green.

Final coder verification: 43 focused parser-validation tests, typecheck, all
1,157 tests across 58 files, production build, built-command version smoke, and
diff check passed. No real client, package, install, credential, or network
action was used by this fix.

## Independent reviewer proof

Claude must review the pinned base and head in a disposable worktree under
`~/Dev`, with pxpipe bypassed and no package, installer, service, client,
credential, web, or other network action:

1. Trace the installed Codex root-to-alias-to-native chain and confirm every
   accepted version, name, platform, architecture, target, and hash is bound.
2. Independently weaken the root alias or suffixed-version proof. Its exact
   focused guard must fail, then pass restored.
3. Independently weaken one OS/CPU constraint. Its guard must fail before a
   sandbox runner call, then pass restored.
4. Confirm the direct embedded layout and symlink-retarget rejection remain
   green.
5. Run the focused file, typecheck, all tests, production build, both installer
   shell syntax checks, packager syntax, and diff check. Restore every mutation
   and leave tracked status clean.

No new package publication, installation, real client command, live
subscription/model request, push, or merge is authorized by this review.

## Known gaps

- The corrected resolver has not yet run against the real staged Codex binary;
  that is the immediate post-acceptance check.
- A future Codex packaging-layout change intentionally fails closed and requires
  new evidence rather than a permissive fallback.

## Reviewer comments

- R1 (2026-07-11T12:19:11Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-codex-alias-r1`.
  - Reviewed SHA: `6912f533bf364f19b90d4a9100b4e9dc3841d202`.
  - Base SHA: `100121e5320d60103fce25b86f851366fed969eb`.
  - `guard_confirmed: true`.
  - Verdict: **accepted**; no material finding.
  - Chain proof: the root optional dependency binds the alias; the aliased
    package binds the internal name, suffixed version, OS, and CPU before the
    existing Mach-O, staging, version, and source-target proofs.
  - Alias proof: replacing exact equality with a prefix let a wrong suffix
    resolve. Restoration rejected it and returned all focused tests green.
  - CPU proof: removing the exact CPU comparison let the wrong platform reach
    the synthetic runner. Restoration rejected it before any runner call.
  - Direct embedded layout and symlink-retarget rejection remained green.
  - Final reviewer gate: 43 focused tests, typecheck, all 1,157 tests across 58
    files, production build and version smoke, both shell syntax checks,
    packager syntax, and diff check passed.
  - Final tracked status was clean; only the pre-existing review-scaffolding
    `node_modules` symlink was untracked.

The JSON envelope exited zero after 48 turns, matched the required schema,
returned both pinned SHAs exactly, and reported no permission denial, web
search, or fetch. Claude ran no package, installer, service, client, credential,
or product request beyond the review itself. It also noted that the canonical
checkout's untracked governance controls are not present in this branch's
tracked history; that pre-existing worktree fact is unrelated to this diff.
