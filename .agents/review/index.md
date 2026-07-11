# Review status — provenance-safe compression slices

Workflow: slice-adapted `reviewloop` (see AgentGovernanceBootstrap
`.agents/playbooks/reviewloop.md`). Atomic unit here is **one implementation
slice ↔ one commit ↔ one verdict**; the independent reviewer named in each
slice record performs its guard proof in a disposable worktree at the slice
head SHA.
Per-slice detail: `.agents/review/findings/slice-<n>.md` and the named
context-correction records below.

Plan under review: `docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` (approved
2026-07-10). Branch: `fix/provenance-safe-compression`, base `b1f5a01`.

## Legend
- `[ ]` Open (slice committed; review not yet dispatched)
- `[~]` Pending review / reopened
- `[x]` Verified (accepted verdict recorded; merge stays owner-gated)
- `[!]` Contested — awaiting owner adjudication

## Slices

| ID      | Commit    | Scope (one line)                                        | Status |
|---------|-----------|---------------------------------------------------------|--------|
| slice-1 | `1d25d57` | Lossless Claude context partitioner + fixtures          | `[x]` closed via slice-3 chain (guards confirmed at head) |
| slice-2 | `fbf9b0c` | Role-bound project-guidance transform, shared boundary  | `[x]` accepted r3; fixes `371322d`, `4dca949` |
| slice-3 | `2334b98` | Vouched runtime metadata tail (userEmail/currentDate)   | `[x]` accepted r3; fixes `ee992d3`, `c3e8744` |
| slice-4 | `525cb5b` | Independent tool bucket, telemetry, host wiring         | `[x]` accepted r1, zero comments |
| slice-5 | `162a00f` | Docs, migration note, eval harness                       | `[x]` accepted r3 at `fd548c8`; Claude guard confirmed |
| local-package | `eab46e6` | Loopback-only macOS package and installer             | `[x]` output correction accepted r2 at `2d683da` |
| subscription-plan | `5499612` | No-key local Fable, Sol, and Grok routing plan       | `[x]` accepted r3; implementation owner-gated |
| subscription-routing | `80172ae..dfeb07f` | Local no-key Codex and Grok routes          | `[x]` accepted r1 at `9ef32c5`; Claude guards confirmed |
| subscription-model-persistence | `7b7ac1c..6cc440c` | Save all three installed model selections | `[x]` accepted r1 at `7416c94`; installed from `3e07e08` |
| one-port-subscription-plan | `2aeca41` | Persistent one-service Codex and Grok plan, exact pass-through amendment | `[x]` accepted r4 at `e882aff`; implementation authorized |
| one-port-subscription-slice-1 | `e11154e` | Exact core Codex/Grok reserved routing and pass-through | `[x]` accepted r1 at `9da6660`; Claude guards confirmed |
| one-port-subscription-slice-2 | `5afc19a` | Raw Node routing and hostile-environment isolation | `[x]` accepted r1 at `07441c2`; Claude guards confirmed |
| one-port-subscription-slice-3 | `44c121e` | Transactional one-port installer and exact client configuration | `[x]` accepted r1 at `9923abd`; Claude guards confirmed |
| one-port-subscription-slice-4 | `c39745d` | Simple release instructions and offline Codex/Grok parser validation | `[x]` accepted r1 at `8c9180b`; Claude guards confirmed |
| context-hijack-correction-plan | `5daab97` | Remove context rewriting, invalid requests, and negative returns | `[x]` accepted r3 at `bcecfd0`; implementation owner-gated |
| context-correction-slice-1 | `a0386b6` | Shared no-hijack, structure, admission, accounting, and Node breaker | `[x]` accepted r1 at `717464e`; Claude guard confirmed |
| context-correction-slice-2 | `5b98406` | Anthropic exact in-place project and tool-result compression | `[x]` accepted r1 at `1ec9f28`; Claude guard confirmed |
| context-correction-slice-3 | `de5d189` | Exact-native OpenAI Chat, Responses, Codex/Sol, and Grok | `[x]` accepted r1 at `a4a456a`; Claude guard confirmed |
| context-correction-slice-4 | `eb6c70d` | Terminal-control atomicity, role order, and request isolation | `[x]` accepted r1 at `9309e15`; Claude guard confirmed |
| context-correction-telemetry-privacy | `a1e3bc4` | Stop persisting private requests, errors, and host identity | `[x]` accepted r1 at `0db62b1`; Claude guard confirmed |
| context-correction-slice-5 | `86eb64e` | Public contract, migration, and local release documentation | `[x]` accepted r1 at `f58b34f`; Claude guard confirmed |
| context-correction-public-contract | `91c72e7` | Installed help, dashboard, renderer docs, and demo safety copy | `[x]` accepted r1 at `5d557eb`; Claude guard confirmed |
