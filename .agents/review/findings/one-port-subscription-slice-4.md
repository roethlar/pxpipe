# one-port-subscription-slice-4: owner release and offline client validation

**Severity**: HIGH — the release check must not expose stored login data, run a
model request, trust substituted client bytes, or leave a client process behind
**Status**: Accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `c39745d17032db3d315881b65f3bd64c2108d47b` (base
`fbdddacf59ea27df4a5201db34a97cce0df9242c`)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, Slice 4. Slices 1–3 are accepted.
Packaging the exact reviewed head, installation, and real offline parser checks
remain after this review. A live subscription or model request remains a
separate owner gate.

## Evidence and predicted failures

The installer can now configure plain `codex` and plain `grok`, but accepting
that result without exercising each installed parser could leave either client
unable to start. Running the launchers directly against the owner home could
read credentials, contact a service, rewrite owner files, create the default
Grok socket, fork a background process, or execute substituted bytes. An
unbounded check could also retain arbitrary output or hang indefinitely.

## What changed

- Added one argument-free developer command, `pnpm validate:macos-clients`,
  which loads the checksum-protected 0600 installer receipt and requires the
  installed config hashes and modes recorded there.
- Resolve the Codex native Mach-O behind its Node package launcher and the
  versioned Grok Mach-O without executing either launcher. Package metadata,
  architecture, modes, hashes, real targets, and every resolved source are
  pinned and rechecked.
- Copy those exact executables and byte-identical TOML into a fresh private
  child under `~/.pxpipe-s`, with an isolated home, empty working directory,
  minimal environment, and a Grok socket path capped at 90 UTF-8 bytes before
  any mutation.
- Run only fixed version and parser arguments through `sandbox-exec`. The
  profile denies network, real-home reads, outside writes, fork, and every
  executable except the staged client. Parser output goes directly to the
  operating-system discard sink; version output has a 512-byte combined cap;
  every child has a 15-second kill limit.
- Recheck all staged and installed hashes and modes around every invocation,
  reject writes to the empty working directory, remove the private child and
  socket on every outcome, and never report command output.
- Replaced the old multi-terminal owner instructions with one package command,
  `./install.sh`, plain `codex`, and plain `grok`. The historical harness plan
  remains explicitly superseded.

## Files changed

- `src/macos-client-parser-validation.ts`
- `tests/macos-client-parser-validation.test.ts`
- `package.json`
- `README.md`

## Coder guard proof

Each new protection was deliberately weakened in isolation, the named test was
observed red, and the protection was restored:

1. Removing fork denial, changing either fixed parser command, or relaxing the
   90-byte socket budget broke the matching profile/argument guard.
2. Buffering parser output, raising the version-output cap, and delaying the
   timeout each broke the production child-runner guards. Restored runs prove
   operating-system discard, a combined cap, SIGKILL, literal arguments, an
   exact environment, and no surviving child.
3. Removing the post-invocation staged-file check let a version run reach the
   next invocation after changing the copied TOML. Restored behavior stops
   after the first call; executable mutation is rejected the same way.
4. Parsing the receipt as a bare payload, weakening strict ancestry, failing to
   recheck a Codex vendor symlink, and retaining an unsafe directory each made
   its focused guard fail before restoration.

Final coder verification at the exact implementation commit: 37 focused tests,
typecheck, all 1,149 tests across 58 files, production build, built-command
version smoke check, and `git diff --check` passed. A separate read-only audit
also found no remaining material issue and parsed both generated sandbox
profiles with an inert local executable. It ran no client or network request.

## Independent reviewer proof

Claude must review the pinned base and head in a disposable worktree under
`~/Dev`, with pxpipe bypassed and without running Codex, Grok, the installer, the
packager, or any product/network request:

1. Trace receipt loading, native resolution, staging, sandbox construction,
   fixed commands, source rechecks, failure precedence, timeout, and cleanup.
2. Independently remove parser-output discard or the combined version cap. The
   exact bounded-runner guard must fail, then pass restored with no child left.
3. Independently remove the staged-file recheck after a child. The mutation
   guard must reach a second invocation, then stop after one when restored.
4. Independently weaken one real-target or receipt-envelope pin. Its named race
   or receipt guard must fail, then pass restored.
5. Independently remove fork denial or relax the private socket/root rule. The
   matching sandbox guard must fail, then pass restored; parse the restored
   profiles only with an inert local executable.
6. Run the focused file, typecheck, all tests, production build, shell/package
   syntax checks, and confirm no tracked or temporary mutation remains.

No package publication to `/Users/michael/Dev/pxpipe-deploy`, installation,
real client command, live subscription/model call, push, or merge is authorized
by this review.

## Known gaps

- The staged real Codex and Grok binaries have not yet run under the sandbox;
  this happens only after acceptance and installation.
- Package digest, installed source, one exact loopback listener, dashboard
  health, and loaded LaunchAgent checks remain the post-review release steps.
- No live subscription/model request is part of this slice.

## Reviewer comments

- R1 (2026-07-11T11:43:02Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-one-port-slice4-r1`.
  - Reviewed SHA: `8c9180b82cbff37eba3e2dd5561422dd497720f8`.
  - Base SHA: `fbdddacf59ea27df4a5201db34a97cce0df9242c`.
  - `guard_confirmed: true`.
  - Verdict: **accepted**; no material finding.
  - Output-cap proof: weakening the combined version-output limit made the
    exact cap guard fail. Restoration passed and left no child process.
  - Staged-copy proof: removing the post-run recheck let a mutation reach a
    forbidden second invocation. Restoration stopped after the first call.
  - Native-target proof: removing the Codex architecture-package symlink
    recheck let a retargeted candidate succeed. Restoration rejected it.
  - Sandbox proof: removing fork denial broke the exact profile guard.
    Restoration passed; both Codex and Grok profiles then parsed and ran with
    `/usr/bin/true` under the real macOS sandbox, including the bounded private
    Grok socket rules.
  - Final reviewer gate: 37 focused tests, typecheck, all 1,149 tests across 58
    files, production build and version smoke, both shell syntax checks,
    packager syntax, and diff check passed.
  - Final tracked status was clean; only the pre-existing review-scaffolding
    `node_modules` symlink was untracked.

The JSON envelope exited zero after 68 turns, matched the required schema,
returned both pinned SHAs exactly, and reported no permission denial, web
search, or fetch. Claude ran no installer, packager, real client, service,
credential read, or product request beyond the review itself.
