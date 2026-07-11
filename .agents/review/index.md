# Review status — provenance-safe compression slices

Workflow: slice-adapted `reviewloop` (see AgentGovernanceBootstrap
`.agents/playbooks/reviewloop.md`). Atomic unit here is **one implementation
slice ↔ one commit ↔ one verdict**; the independent reviewer named in each
slice record performs its guard proof in a disposable worktree at the slice
head SHA.
Per-slice detail: `.agents/review/findings/slice-<n>.md`.

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
| one-port-subscription-plan | `41fd638` | Persistent one-service Codex and Grok plan | `[~]` paused behind context correction |
| context-hijack-correction-plan | `489292a` | Remove context rewriting, invalid requests, and negative returns | `[~]` accepted r1; three LOW refinements pending r2 |
