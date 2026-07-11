# context-correction-slice-4: Incident follow-on guards

**Severity**: HIGH — terminal controls could let one unsafe text part keep a
printable sibling eligible for imaging, while future order or shared-state
regressions could recreate the reported Anthropic 400 or leak one model's
request identity into the next.
**Status**: Verified — independently accepted
**Branch**: `fix/provenance-safe-compression`
**Commit**: `eb6c70d20f8e2d11fee31ca8884460247399a49f` (base: parent
`acf04d08d61fea5db361658ce2ebdd54eb0a21a1`)

## Plan authority

`docs/CONTEXT_HIJACK_CORRECTION_PLAN.md`, approved and independently accepted
through r3. This record covers implementation Slice 4 only. Documentation,
packaging, installation, live calls, push, and merge are out of scope.

## Evidence

- The exact renderer already rejected an individual ESC/C1/C0-bearing string
  because those controls were reported as missing glyphs.
- A multipart `tool_result` was not atomic at that safety boundary: the unsafe
  part stayed text, but an ordinary prose sibling was independently rendered and
  replaced with images. Five CSI/OSC/C1/C0 fixtures reproduced that partial
  transformation before the correction.
- The installed incident contained a literal non-directive `system` attachment;
  inserting synthetic history after it produced the provider 400 recorded in the
  plan. Slices 1–3 removed that rewrite, but the exact captured and mixed-hook
  ordering needed a direct regression fixture.
- Proxy model, body, and request-hash variables are request-local and there is no
  transformed-request cache. The reported stale-model suspicion therefore called
  for a sequential guard, not speculative cache or ordering code.

## Predicted observable failure

Without the terminal preflight, a result containing a color/cursor/control
sequence in one text part can still have a neighboring printable part converted
to an image, changing only part of one terminal container. Without the order and
request-isolation guards, a future history or shared-state change could again put
a synthetic user after a normal system message, reorder hook attachments, report
the wrong model/hash, or forward bytes from an earlier request.

## What

Every exact project or tool-result render now rejects terminal control bytes
before drawing. A `tool_result` is scanned as one container, so any controlled
text part leaves every sibling text part native. The safe fallback is recorded as
`terminal_control` without retaining source text. New incident fixtures pin
literal system/hook order and final validation, and one proxy instance is driven
through sequential Sonnet, Fable, Sol, and Grok requests to pin per-request bytes,
models, ordering, and hashes.

## Approach

`src/core/transform.ts:2289-2312` conservatively recognizes every C0 control
except LF plus DEL/C1 controls, covering ESC-prefixed and 8-bit CSI/OSC forms.
The helper is applied defensively at the exact renderer and before any per-part
tool-result staging. `src/core/tracker.ts` now persists every positive safe
passthrough reason, including the new terminal reason. No request cache or order
rewrite was added: the new tests preserve and verify the already-correct
request-local and provider-validation paths.

## Files changed

- `src/core/transform.ts` — terminal-control preflight for project spans and
  complete tool-result containers; explicit safe-fallback reason.
- `src/core/tracker.ts`, `tests/tracker.test.ts` — source-free persistence of all
  positive passthrough-reason counters.
- `tests/ansi-safety.test.ts` — CSI SGR, OSC/BEL, OSC/ST, C1 CSI, and C0 backspace
  fixtures for single and multipart results plus an ordinary-prose control.
- `tests/anthropic-incident-order.test.ts` — captured literal-system order,
  mixed string/block hook attachments, and invalid synthetic-user rejection before
  any token probe.
- `tests/request-isolation.test.ts` — sequential Sonnet/Fable/Sol/Grok exact body,
  marker order, model, route, and request-hash isolation through one proxy.

## Guard proof

Coder proof before the implementation landed:

1. With all three new test files present but the base source still active,
   `tests/ansi-safety.test.ts` passed the five single-string native cases and the
   ordinary-prose control, but failed all five multipart cases because the safe
   sibling was still imaged. After requiring the new `terminal_control` reason,
   ten cases failed and only ordinary prose passed.
2. A terminal-only tracker fixture failed because the base serializer omitted the
   reason. The production correction made all eleven ANSI cases and both tracker
   reason cases pass.
3. A temporary fault that skipped `system` role-order validation made the exact
   incident rejection test fail with `{ valid: true }`; restoration made both
   order tests pass.
4. A temporary fault that reused one model label for every proxy event made the
   sequential four-model isolation test fail; restoration made it pass.
5. The restored implementation passed the canonical typecheck, all 858 tests, and
   production build.

Independent reviewer proof in a disposable worktree should at minimum:

1. Check out the reviewed head, then replace `src/core/transform.ts` and
   `src/core/tracker.ts` with their base versions from
   `acf04d08d61fea5db361658ce2ebdd54eb0a21a1`.
2. Run
   `pnpm exec vitest run tests/ansi-safety.test.ts tests/tracker.test.ts -t 'terminal-control|terminal control|complete multipart'`.
   The multipart atomicity and terminal-only telemetry guards must fail.
3. Restore both files from the reviewed head and repeat the focused command; it
   must pass. Also run `tests/anthropic-incident-order.test.ts` and
   `tests/request-isolation.test.ts` at the reviewed head.
4. Confirm the worktree is clean, then run
   `pnpm run typecheck && pnpm test && pnpm run build` using the pinned npx pnpm
   fallback when pnpm is off PATH. It must pass.

## Coder dispute (if any)

Empty.

## Known gaps

- The role-order and request-isolation behavior was already correct after prior
  slices, so this slice adds guard coverage rather than speculative production
  state or reordering logic. Their fault-injection proofs demonstrate that the
  fixtures detect the regressions they name.
- OpenAI-compatible context remains deliberately native. No same-container image
  representation exists there yet.
- Documentation, migration text, package creation, installation, and local
  no-network captures belong to Slice 5.
- No live model call, subscription smoke, package install, push, merge, or paused
  one-port routing work is authorized by this review.

## Reviewer comments

- R1 (2026-07-11T03:44:57Z): Claude Code 2.1.207 / Sonnet 5, structured
  output, pxpipe bypassed, disposable worktree
  `/Users/michael/Dev/pxpipe-review-context-correction-s4-r1`.
  - Reviewed SHA: `9309e15c2c4cc1b4398e16e59591530d1a7a55f8`.
  - Base SHA: `acf04d08d61fea5db361658ce2ebdd54eb0a21a1`.
  - `guard_confirmed: true` — the reviewer independently restored the base
    transform/tracker, observed the multipart terminal-container and
    terminal-only telemetry guards fail for the expected reasons, restored the
    reviewed head and observed them pass, ran the role/order and sequential
    four-model isolation guards, and completed typecheck, all tests, and the
    production build.
  - Verdict: **accepted**.
  - Comments: none.

The JSON envelope exited zero, matched the required schema, and returned both
pinned SHAs exactly. Four ancillary compound/diagnostic Bash attempts were denied
by the review allowlist; none was a required revert, focused guard, restore, or
final gate command. The disposable worktree was tracked-clean after restoration;
its only untracked entry was the temporary `node_modules` symlink. Acceptance does
not authorize installation, live product calls, push, merge, or the paused routing
work.
