# one-port-launchd-transition: bounded launchd startup retry

**Severity**: MEDIUM — a valid local update rolls back safely but cannot install
while launchd briefly retains a PID before reporting the job as running
**Status**: Accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `c1521f8cbf963a7f9a29b896310345a451187a89` (base
`50f13d432c7c54ec4d4fa937713e1083a9dd3514`)

## Plan authority

`docs/ONE_PORT_SUBSCRIPTION_ROUTING_PLAN.md`, Slice 4 local installation and
validation. The exact previously reviewed package was built successfully before
this machine-local installer failure appeared.

## Evidence and predicted failure

The exact package from reviewed head `8c9180b` was installed twice on 2026-07-11.
Both attempts failed at `src/macos-local-install-app.ts` in
`verifyServiceOwnsListener` with `launchctl returned inconsistent running-state
output`, then restored the exact prior `59e2b9a` release, service, config hashes,
modes, and receipt absence. After each rollback the same job settled to
`state = running`, one PID, and one exact `127.0.0.1:47821` listener.

The old branch rejected any non-running launchd state that still carried a PID,
even though the surrounding bounded startup loop already retries a missing job
or listener. On this Mac, launchd can retain the PID during its normal
non-running transition. The observable failure is a safe but repeatable install
rollback, so the owner cannot reach the reviewed service.

## What changed

The startup loop now retries a non-running state for the same existing 15 by 100
millisecond budget whether or not launchd still reports a PID. It accepts
nothing from that transitional sample. Success still requires a later complete
managed-job identity with `state = running`, a present PID, that same sole PID
from the selected-port query, and exact IPv4 loopback binding. A persistent
non-running state still exhausts the bound and rolls every resource back.

## Files changed

- `src/macos-local-install-app.ts`
- `tests/macos-local-install-app.test.ts`

## Coder guard proof

- Added one transition sample with `state = spawn scheduled` plus a PID followed
  by a valid running sample. Restoring the old immediate throw made this exact
  test fail with the same live installer error; removing the throw made it pass
  and produce a cohesive installed state.
- Added a persistent transition fixture. More samples than the 15-poll budget
  still fail with `installed pxpipe job did not acquire its selected port` and
  restore a cohesive absent state.
- All existing foreign loaded-job, duplicate/wrong PID, listener ownership,
  exact binding, rollback, and recovery tests remain green.

Final coder verification: 66 focused installer-app tests, typecheck, all 1,151
tests across 58 files, production build, built-command version smoke check, and
diff check passed. A separate read-only audit confirmed that the change retries
only the transition and does not weaken the final identity/listener proof.

## Independent reviewer proof

Claude must review the pinned base and head in a disposable worktree under
`~/Dev`, with pxpipe bypassed and no installer, package, service, client,
credential, web, or other network action:

1. Trace the startup loop and confirm no transitional state or PID can be
   accepted before a final `running` sample and the two exact listener proofs.
2. Independently restore the removed immediate throw. The new one-transition
   guard must fail with the live error; remove it again and confirm green.
3. Increase the persistent fixture beyond the budget and confirm it still fails
   closed and restores cohesive absence.
4. Run the 66-test installer-app file, typecheck, all tests, production build,
   both installer shell syntax checks, packager syntax, and diff check. Restore
   every mutation and leave tracked status clean.

No new package publication, installation, real client command, live
subscription/model request, push, or merge is authorized by this review.

## Known gaps

- The corrected installer has not run on the real service; that is the immediate
  post-acceptance check.
- The existing 1.5-second startup budget is unchanged. A slower valid startup
  still fails closed and rolls back.

## Reviewer comments

- R1 (2026-07-11T12:02:51Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-launchd-transition-r1`.
  - Reviewed SHA: `e5c4ed65416af4b4da0415345d437d85f71b9c30`.
  - Base SHA: `50f13d432c7c54ec4d4fa937713e1083a9dd3514`.
  - `guard_confirmed: true`.
  - Verdict: **accepted**; no material finding.
  - Trace proof: every transitional sample is discarded. Only a fresh later
    `running` sample supplies the PID used by both exact listener checks.
  - Red/green proof: restoring the immediate throw reproduced the real
    `inconsistent running-state output` failure. Removing it restored a
    cohesive successful install fixture.
  - Bound proof: increasing the persistent fixture from 20 to 500 samples still
    exhausted the 15-poll limit, failed closed, and restored cohesive absence.
  - Existing foreign/duplicate listener, wrong-binding, startup-absence,
    rollback, recovery, and legacy-adoption guards remained green.
  - Final reviewer gate: 66 focused tests, typecheck, all 1,151 tests across 58
    files, production build and version smoke, both shell syntax checks,
    packager syntax, and diff check passed.
  - Final tracked status was clean; only the pre-existing review-scaffolding
    `node_modules` symlink was untracked.

The JSON envelope exited zero after 43 turns, matched the required schema,
returned both pinned SHAs exactly, and reported no permission denial, web
search, or fetch. Claude ran no package, installer, service, client, credential,
or product request beyond the review itself.
