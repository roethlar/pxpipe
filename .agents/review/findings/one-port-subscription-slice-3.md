# one-port-subscription-slice-3: transactional installer and client configuration

**Severity**: HIGH — installation must not lose owner configuration, strand a
mixed service/client state, or route subscription traffic through unverified
local files
**Status**: Accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `44c121e438435582a63f07823dd521af013d9bde` (base
`0ae2263ccf117ad384b1220c9a333b1f36c44f91`)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, Slice 3. The exact reserved router
and raw Node boundary are accepted in Slices 1 and 2. Owner-facing packaging,
installation, parser validation, and any live subscription call remain Slice 4
or separately owner-gated work.

## Evidence and predicted failures

Before this slice, the supported local package could not safely make plain
`codex` and plain `grok` use one installed service. A simple text substitution
could overwrite comments or owner settings; a partial service/config update
could leave clients aimed at the wrong or absent process; a crash could lose
the prior state; and a package or loaded-service mismatch could execute or trust
bytes other than those reviewed. The observable failures are lost TOML bytes,
an unusable client, a second or stale listener, unrecoverable installer state,
or subscription credentials reaching a different local program.

## What changed

- Added a strict TOML parser/editor for only the approved Codex and Grok keys.
  It preserves every unrelated byte, BOM, line ending, comment, spacing, mode,
  and final-newline choice. Its receipt binds parsed identity, exact source and
  applied spans, order, offsets, and whole-owner-file provenance; ambiguous or
  changed ownership fails without mutation.
- Added a private hard-link installer lock, preparing/ready/committed/conflicted
  journal, eight-resource snapshots, exact receipt identities, reverse rollback,
  crash replay, durable conflict recording, and surgical uninstall. Safe owner
  edits survive; managed edits, symlinks, unsafe ownership, and third identities
  fail closed.
- Added one runnable installer application that validates the immutable package,
  pinned legacy installation, current link/release tree, exact LaunchAgent, log
  files, loaded launchd path/program/arguments/environment, one PID, exact
  `127.0.0.1` listener, health endpoint, and prior port before any mutation.
- The service plist contains only loopback host, the selected install-time port,
  all three installed models, and the two fixed subscription upstreams. It does
  not inherit API keys, provider, gateway, or Node-injection settings.
- Added a stable visible `install.sh` over immutable retained generations. A
  serialized publisher captures one reviewed launcher, rejects unsafe output
  paths and links, recovers interrupted pointer/launcher handoffs, and preserves
  an old-or-new usable command. Launchers execute already-verified bootstrap and
  installer bytes, and pin the verified helper, manifest, and archive hashes
  through extraction.

## Files changed

- `src/macos-local-config.ts`
- `src/macos-local-installer.ts`
- `src/macos-local-install-app.ts`
- `deploy/macos-local/install.sh`
- `deploy/macos-local/generation-install.sh`
- `scripts/build.mjs`
- `scripts/package-macos-local.mjs`
- `package.json`
- `pnpm-lock.yaml`
- `tests/macos-local-config.test.ts`
- `tests/macos-local-installer-state.test.ts`
- `tests/macos-local-install-app.test.ts`
- `tests/macos-local-installer.test.ts`

## Coder guard proof

Every new behavioral family was turned red by temporarily removing its matching
protection, then restored green. Representative proofs included:

1. Reordered/equal-offset and separator-rebinding TOML spans corrupted owner
   structure under the old verifier; the final verifier rejects both while
   accepting and preserving a legitimate prepended owner comment.
2. A handled receipt failure after rename was incorrectly accepted as committed;
   completed state compensation was repeated after snapshot cleanup; unsafe
   third paths escaped durable conflict; and a redundant path chmod followed a
   substituted link. Each named core guard failed before its correction.
3. A foreign loaded launchd job, wildcard/IPv6 listener, and retained legacy old
   port passed earlier service checks. Exact loaded-job, IPv4 loopback, PID, and
   old-port guards now reject or drain them.
4. Mutable launcher rereads, unsafe generation links, ambient Node cache flags,
   concurrent publishers, publisher death, post-verification bootstrap/helper
   replacement, and a paired manifest/archive replacement each reproduced the
   predicted failure before restoration.

Final verification from a detached worktree under `~/Dev` at the exact staged
tree: typecheck, all 1,112 tests across 57 files, production build, and built-CLI
version smoke check passed. The four focused installer files contain 174 passing
tests. Shell and package-script syntax and `git diff --check` also passed.

## Independent reviewer proof

Claude must review the pinned base and head in a disposable worktree under
`~/Dev`, with pxpipe bypassed and no live model/product request:

1. Trace install, reinstall, uninstall, handled failure, process death, and
   conflicted recovery across all eight journaled resources and both receipt
   identities. Confirm the receipt never authorizes a mixed state.
2. Independently perturb one source-span ownership/order guard. The separator
   exploit test must fail; restore it and confirm legitimate unrelated prepend
   and relocation cases remain green.
3. Independently perturb one rollback durability guard, preferably completed
   state compensation or receipt-after-rename handling. Confirm the named test
   fails, restore it, and confirm snapshots/conflicts remain recoverable.
4. Independently weaken loaded-job identity or old-port draining. Confirm its
   app guard fails while the managed files stay exact, then restore it.
5. Independently restore pathname execution or remove the captured bundle-hash
   pins. The post-verification replacement guard must fail, then pass restored.
6. Run the four focused installer files, typecheck, all tests, and production
   build. Confirm no tracked or temporary mutation remains.

No package publication to the owner's deploy directory, installation, client
command, live subscription/model call, push, merge, or Slice 4 action is
authorized by this review.

## Coder adjudication

One audit suggestion was declined as out of scope: direct manual execution of
the hidden `.pxpipe-installer.mjs` with `node` is not a supported entry point and
cannot prevent Node preload processing before JavaScript starts. The supported
root and generation shell path clears every modeled Node injection/cache variable
before its first Node process, verifies the generation, and runs only captured
bytes. Claude should reopen this only if the approved `./install.sh` path can
reach the same failure.

## Known gaps

- Plain fsync does not claim abrupt power-loss ordering beyond the plan.
- The plan's explicitly acknowledged final non-cooperating owner-editor race
  remains; every observable pre/post-write identity change fails closed.
- Slice 4 packaging to the durable directory, installation, sandboxed client
  parser checks, and listener validation have not run.

## Reviewer comments

- R1 (2026-07-11T10:50:03Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-one-port-slice3-r1`.
  - Reviewed SHA: `9923abd4742153841b94f0e6a99390d40f0683c8`.
  - Base SHA: `0ae2263ccf117ad384b1220c9a333b1f36c44f91`.
  - `guard_confirmed: true`.
  - Verdict: **accepted**; no material finding.
  - TOML proof: weakening insertion-order validation let a pure root-key reorder
    pass an isolated proof; restoration rejected it and all 39 config tests
    passed.
  - Transaction proof: moving receipt durability from parent fsync to rename
    made the handled-boundary guard report `changed`; restoration rolled back
    correctly and all 44 state tests passed.
  - Service proof: bypassing prior-port draining removed all expected old-port
    polls; restoration returned all 64 app tests green.
  - Package proof: bypassing the captured manifest hash accepted a semantically
    identical but byte-different manifest in an isolated proof; restoration
    rejected it and all 27 package tests passed.
  - Final reviewer gate: 174 focused installer tests, typecheck, all 1,112
    tests across 57 files, production build, and version smoke check passed.
    Tracked status was clean; only the pre-existing `node_modules` symlink was
    untracked.

The JSON envelope exited zero after 107 turns, matched the required schema,
returned both pinned SHAs exactly, and used no web search or fetch. Seven
ancillary shell forms were denied by the review environment; no required proof
or final gate was lost, and the attempted `/tmp` helper-script command created
no artifact. The reviewer reported that corepack made one incidental fetch of
the pinned pnpm 10.21.0 tool because `pnpm` was initially off PATH; it fetched no
project dependency and contacted no product/model endpoint beyond the Claude
review itself. This tooling-bootstrap deviation did not alter the reviewed tree
or the guard evidence. Future dispatches should use the recorded npx pnpm
fallback directly.

One inert exported helper, `installerEntryPath`, was noted as unused and
untested. Claude correctly treated it as non-blocking because it has no caller
or reachable behavior; removing dead code is not part of this slice's accepted
contract.
