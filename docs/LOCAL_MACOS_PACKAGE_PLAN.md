# Local macOS package and installer

Status: **IMPLEMENTED AND ACCEPTED 2026-07-10**. The owner selected the
Node-based macOS service-package shape described in chat, required
loopback-only operation, and said to continue. After the first accepted
implementation, the owner corrected the delivery contract: generated install
artifacts must live in `~/Dev/pxpipe-deploy`, never under `/private`.

Checkpoint: implementation commit `eab46e6`; independent Claude Code 2.1.206 /
Sonnet 5 review accepted `aff8bf1` after reconfirming the localhost and
checksum guards, attacking archive traversal/link inputs, reproducing the full
803-test gate, and smoke-running the packed proxy on loopback. The verdict is
recorded at `c0af68d`. Generated bundles remain ignored local outputs. No real
LaunchAgent, model call, Cloudflare deployment, public release, merge, or push
was performed by this slice.

Output-location correction checkpoint: plan `6acbd1f`; implementation
`23b3618` plus pnpm forwarding fix `ca598a0`; Claude Code 2.1.206 / Sonnet 5
accepted reviewed head `2d683da` after independently proving the `/private`
guard, stable staging, symlink rejection, unrelated-file preservation, and
both pnpm command forms. Verdict recorded at `85126a5`. The complete bundle is
now generated only into `~/Dev/pxpipe-deploy`.

## Outcome

Produce a reproducible local bundle for the provenance-safe fork:

- a fork-distinct `pxpipe-proxy` package archive;
- an adjacent installer and machine-readable manifest;
- a per-user macOS LaunchAgent that starts at login and stays alive;
- an uninstall path; and
- no Cloudflare, public registry, sudo, global package install, or network
  exposure.

After installation, Claude Code is started with:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

## Evidence and constraints

- The existing `../pxpipe-deploy` artifact is not a native binary. It is an npm
  package archive plus a macOS LaunchAgent installer and still requires Node.
- The current build already bundles the runtime into `dist/node.js`. Runtime
  rendering uses the checked-in atlas and has no native canvas dependency.
- The old deploy installer defaults to `0.0.0.0`, installs globally through
  npm, and has stale update/model assumptions. Those behaviors are not copied.
- Package version `0.8.0` is already the public version. The fork package must
  use a valid prerelease version so `pxpipe --version` cannot be mistaken for
  the public build.
- Generated archives are reproducible outputs, not source. The builder requires
  an explicit stable output directory, rejects `/private` and paths inside the
  source worktree, and never defaults to an ignored worktree directory. The
  owner's current output directory is `~/Dev/pxpipe-deploy`.

## Design

### Fork identity

Set the package version to `0.8.0-provenance-safe.1`. The build continues to
inline `package.json`'s version and its existing smoke check must pass.

### Bundle builder

Add `scripts/package-macos-local.mjs` and package script
`package:macos-local`. It must:

1. refuse a dirty source tree;
2. run the repository's typecheck, tests, and build;
3. pack the runtime with pnpm;
4. name the archive with the prerelease version and full source commit;
5. verify the archive contains `package/bin/cli.js`,
   `package/dist/node.js`, and `package/package.json`;
6. extract it to a temporary directory and verify the bundled CLI reports the
   expected version; and
7. require `--output <stable-directory>` and atomically place
   `{archive,manifest.json,install.sh}` there, where the manifest records the
   complete source commit, version, archive name, and SHA-256 digest; and
8. reject output under `/private` or inside the source worktree.

The builder does not fetch, publish, push, install a service, or call a model.

### Installer

Add `deploy/macos-local/install.sh`. The generated bundle copies this exact
script beside the archive and manifest. It must:

- support macOS only and require Node 18+, `tar`, `shasum`, `curl`, and
  `launchctl`;
- accept no registry/package name and install only its adjacent verified
  archive;
- validate the manifest, archive name, SHA-256, package shape, package
  version, and source commit before changing the service;
- install without sudo or a global package manager under
  `~/Library/Application Support/pxpipe/`;
- use the existing `com.pxpipe.proxy` label so it safely replaces an older
  pxpipe LaunchAgent;
- hard-code `HOST=127.0.0.1` with no override; permit only a validated
  `PXPIPE_PORT` (default `47821`);
- use absolute Node and package paths, `RunAtLoad`, `KeepAlive`, private
  permissions, and logs under `~/Library/Logs/pxpipe/`;
- stage an update, preflight `--version`, switch the current release, start it,
  and poll the local dashboard;
- restore the prior release if the health check fails; and
- support `--uninstall`, removing the job and installed program while
  preserving logs and `~/.pxpipe/events.jsonl`.

The installer never edits shell profiles or Claude settings. It prints the one
`ANTHROPIC_BASE_URL` command the owner can use.

## Files

- `package.json` — prerelease identity and package command.
- `deploy/macos-local/install.sh` — local-only service installer.
- `scripts/package-macos-local.mjs` — verified bundle builder.
- `tests/macos-local-installer.test.ts` — sandboxed installer checks.
- `README.md` — short fork-build/install/run instructions.

## Verification

Automated tests must prove:

1. installation writes a LaunchAgent with only `127.0.0.1` and the selected
   port, starts it, and passes the health check;
2. bad ports, malformed manifests, wrong archive names, missing files, version
   mismatch, and digest mismatch fail before service replacement;
3. a healthy update switches releases;
4. a failed update restores the prior release;
5. uninstall removes the service/program but leaves logs and events;
6. the produced archive runs `--version` after isolated extraction; and
7. the package builder refuses dirty input.

For the new behavioral tests, reverse the relevant installer checks, observe
the focused tests fail, restore them, and observe them pass. Then run:

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run package:macos-local -- --output /Users/michael/Dev/pxpipe-deploy
```

Finally run the packed proxy from an isolated temporary directory on an unused
loopback port, poll its dashboard, terminate it cleanly, and dispatch a fresh
Claude review with an independent guard proof.

## Boundaries

- No Cloudflare configuration or deployment.
- No live Claude/model calls.
- No actual LaunchAgent installation during automated verification.
- No generated install artifact under `/private` or inside the source
  worktree.
- No main-project contribution, pull request, merge, release, or public
  publish.
- Pushing new commits to the fork requires a fresh explicit owner go.
