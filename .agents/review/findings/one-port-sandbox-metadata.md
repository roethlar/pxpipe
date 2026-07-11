# one-port-sandbox-metadata: metadata-only path resolution

**Severity**: MEDIUM — both real parser commands remain network-isolated, but
Codex cannot resolve its private home and absent system-policy root under the
initial sandbox profile
**Status**: Accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `04861f204c965e353a9ccea03d4d4fbc312d5d3b` (base
`8d7ba3ee871c3b1053b188d0f68938229748051a`, the branch's merge-base with
`origin/main` at dispatch)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, Slice 4 sandboxed offline parser
validation. Exact source `6912f53` is installed and healthy. No live model or
subscription request ran.

## Evidence and predicted failure

`src/macos-client-parser-validation.ts:799-838` constructs the Codex sandbox
and runs the fixed `--version` and `features list` commands. At the prior
accepted checkpoint, `src/macos-client-parser-validation.ts:512-530` allowed
private-child contents but omitted metadata checks needed to resolve the path
leading to that child and the absent system-policy root. The exact correction
is at `src/macos-client-parser-validation.ts:512-535`; its scope guards are at
`tests/macos-client-parser-validation.test.ts:205-228` and `:677-689`.

After the Codex package-alias correction, the real sandboxed validation reached
the staged native clients. Codex's version command returned the exact expected
version on stdout but one bounded stderr warning because it could not resolve
the isolated home path. Grok's version was clean. Continuing diagnostically
without reporting output showed `codex features list` exiting 1 while loading
configuration; only safe classifications were retained: the error was UTF-8,
bounded, referenced configuration/path resolution, and reported operation not
permitted. Parser output remained undisclosed.

The sandbox allowed all data beneath the private check child but no metadata on
the real path components leading to it. It also denied the existence check for
Codex's hard-coded `/etc/codex` policy root, which is absent on this Mac. The
observable failure is that the required offline parser check rejects a valid
installed configuration before it can finish.

The local macOS system sandbox profile uses `file-read-metadata` plus
`file-test-existence` for standard symlink/path resolution. A diagnostic profile
using only that operation for the private child's ancestors, literal `/etc`,
and the ancestors of `/private/etc/codex` made all four fixed real commands exit
zero: both version checks, `codex features list`, and the private-socket Grok
inspection. Network, fork, other executables, real-home contents, system-policy
contents, and parser output remained denied.

## What changed

- Validate that the private check root is a strict owner-home descendant before
  constructing any profile.
- Allow only metadata and existence checks through `path-ancestors` for that
  private root, literal `/etc`, and the normalized absent `/private/etc/codex`
  root.
- Keep data reads limited to the existing private check child, staged
  executable, root path lookup, and immutable runtime paths. No real-home
  subpath, `/etc` subpath, or outside write scope was added.

## Files changed

- `src/macos-client-parser-validation.ts`
- `tests/macos-client-parser-validation.test.ts`

## Coder guard proof

- Removing the exact metadata/existence rule made the focused profile guard turn
  red; restoration returned all 43 focused tests green.
- Tests pin the exact rule and reject broader real-home data/subpath or `/etc`
  content scopes.
- Before source mutation, the exact proposed rule was independently exercised
  in a disposable real validation child. All four staged client commands passed
  with zero retained output; removing it reproduced the bounded Codex failures.

Final coder verification: 43 focused parser-validation tests, typecheck, all
1,157 tests across 58 files, production build, built-command version smoke, and
diff check passed.

## Independent reviewer proof

Claude must review the pinned base and head in a disposable worktree under
`~/Dev`, with pxpipe bypassed and no package, installer, service, real client,
credential, web, or other network action:

1. Trace every sandbox rule and confirm the addition grants only path metadata
   and existence checks for exact ancestors, never real-home/system contents,
   sibling descendants, network, fork, another executable, or outside writes.
2. Remove the exact new rule. Its focused profile guard must fail, then pass
   restored.
3. Broaden the rule to a real-home or `/etc` subpath/data allowance. The scope
   guard must fail, then pass restored.
4. Parse and run the restored Codex and Grok profiles only with an inert local
   executable under real `sandbox-exec`.
5. Run the focused file, typecheck, all tests, production build, both installer
   shell syntax checks, packager syntax, and diff check. Restore every mutation
   and leave tracked status clean.

No new package publication, installation, real client command, live
subscription/model request, push, or merge is authorized by this review.

## Known gaps

- The production validator has not rerun with this committed rule; that is the
  immediate post-acceptance check.
- If `/etc/codex` later exists, its contents remain denied and validation fails
  closed until that distinct managed-policy case is explicitly designed.

## Reviewer comments

- Pre-R1 (2026-07-11): dispatch at head `d8b0773` with prior accepted
  checkpoint `0325c79` as base was stopped before verdict and discarded. The
  review playbook requires the branch merge-base, so no result from that run
  can be accepted.
- Pre-R1 retry (2026-07-11): a prompt carrying an incorrect expanded head SHA
  was stopped before verdict and discarded. No result was accepted.
- R1 (2026-07-11T12:54:03Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-sandbox-metadata-r1`.
  - Reviewed SHA: `33bb29ec398dcc2176c6195f1bfb6093d4da641a`.
  - Base SHA: `8d7ba3ee871c3b1053b188d0f68938229748051a`.
  - `guard_confirmed: true`.
  - Verdict: **accepted**; no material finding.
  - Claude isolated the code change to `04861f2`; the later review commits were
    documentation only.
  - Rule trace confirmed metadata and existence checks only. Real sandbox
    probes denied ancestor listing, contents, siblings, network, fork, other
    execution, and outside writes. The absent policy root resolved as absent;
    no fixture remained afterward.
  - Removing the exact rule made the focused guard fail 42/43; restoration made
    it pass 43/43 with a byte-clean source diff.
  - Broadening to owner-home data made the scope guard fail; restoration made
    it pass with a byte-clean source diff.
  - Both restored profiles parsed and ran only `/usr/bin/true` under the real
    macOS sandbox. No Codex, Grok, staged client, service, or model ran.
  - Focused tests, typecheck, all 1,157 tests, build, both installer syntax
    checks, packager syntax, and diff check passed. Tracked status was clean.
