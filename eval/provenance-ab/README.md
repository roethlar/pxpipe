# Provenance-safe compression — live A/B matrix harness

Records the credentialed live evaluation required by
`docs/PROVENANCE_SAFE_COMPRESSION_PLAN.md` §7 before the provenance-safe
defaults may ship in a release. Unit tests prove request *structure*; only
cold live calls can test Anthropic's classifier and model-level injection
defenses.

> **Owner gate.** Every script here makes real, billed Anthropic calls and
> exercises safety classifiers. Do not run any stage without an explicit
> owner go — plan approval is not run authorization.

## Files

- `variant-proxy.mjs` — loopback proxy wiring `createProxy` from the selected
  worktree's built `dist/` with explicit per-variant transform overrides;
  logs redactable TrackEvents to a per-run `events.jsonl`. The stock Node entrypoint
  deliberately exposes no per-bucket config, so the matrix gets its own host.
- `run-variant.sh` — one cell = one variant × one workspace × N cold
  replicates, each a fresh proxy + one `claude -p` session. Stops the cell on
  the first safety flag (plan §7.1: don't spend calls proving a known-bad
  cell).
- `collect.mjs` — folds run dirs into `matrix.jsonl` + a summary table.
Rows carry identifiers, outcome enums, refs/hashes, and aggregate token
counts only. Each run also gets `metadata.json`: redacted fingerprints for the
source, patch, and built proxy plus an operator-assessment form. Fill every
assessment field after inspecting the local turn; collection fails closed
while any is blank.

The runner rebuilds the selected source tree before the first call and records
the resulting proxy fingerprint. `--prepare-only` performs that validation and
build without making a model call. Untracked source or missing model evidence
is rejected rather than recorded as a clean result.

Before stopping a replicate's proxy, the runner closes it to new work and waits
for every accepted request's event record to be written, including delayed
safety and usage data. The proxy then appends a terminal count record. Early-stop
and collection both reject a missing or inconsistent terminal record. Event logs
are strict JSONL: every row must be a complete newline-terminated JSON object;
missing, truncated, or malformed evidence fails the run.

## What a row records (redacted by design)

variant, workspace, replicate; requested and served models (served read from
the `claude -p` JSON `modelUsage`); `stop_reason`s and `safety_flagged`;
unexpected served-model switch; task outcome; `context_mode`, project/tool/
runtime dispositions, refs, and image counts; `cache_prefix_sha8` /
`cache_boundary_kind`; input / cache-create / cache-read / output token sums.
An undated requested alias may resolve to a dated instance of the same model;
an explicitly dated request must be served by that exact dated identifier.

**Never committed:** raw prompts, transcripts, rendered PNGs, or repository
text. `runs/` is gitignored; only `matrix.jsonl` and a `SUMMARY.md` belong in
a results commit.

## Variants (plan §7.1 Stage A)

| Variant | How it runs |
|---|---|
| `OFF` | `variant-proxy.mjs` with `compress: false` (clean baseline, still logs usage) |
| `LEGACY` | pinned worktree at plan base `b1f5a01`, its own build: `--legacy-dir` |
| `PROJECT` | disposable worktree with the runtime tail neutralized (below) |
| `PROJECT_RUNTIME` | `variant-proxy.mjs`, no overrides — core defaults are the chosen design |
| `TOOLS` | `variant-proxy.mjs`: `compressProjectGuidance: false, compressTools: true` |
| `BOTH` | `variant-proxy.mjs`: `compressTools: true` (project stays on) |

`PROJECT` (project pages with the runtime tail forced native) is not
expressible as a public option: the runtime relocation is unconditional once
its exact captured shape is recognized, and the plan keeps it that way rather
than shipping a permanent experiment knob (§4.6). To run that cell, create a
disposable worktree, make `applyRuntimeMetadataTail` return
`{ request: req, applied: false, chars: 0 }` unconditionally (one line at the
top of the function in `src/core/transform.ts`), build there, and drive it
with `--variant LEGACY --legacy-dir <that worktree>` semantics (record it as
`PROJECT` by also passing `--record-variant PROJECT`). The metadata records the
patched worktree's commit, dirty state, patch hash, and the hash of the proxy
build that actually runs. The patch must never land on a shipping branch.

Before collecting a run, fill its `metadata.json` assessment with only these
redacted judgments: whether project guidance looked legitimate; whether the
live request stayed distinguishable; whether an injection loop was absent,
suspected, or sustained; and whether the task completed, errored, was blocked,
or remained unclear. Do not paste model output into the metadata file.

## Procedure

Stage A (bucket isolation): for each variant × {empty repo,
AgentGovernanceBootstrap}, ≥3 cold replicates of the same benign task:

```bash
npm run build
bash eval/provenance-ab/run-variant.sh --variant PROJECT_RUNTIME --workspace empty --replicates 3
bash eval/provenance-ab/run-variant.sh --variant PROJECT_RUNTIME --workspace agb \
     --workspace-dir ~/Dev/AgentGovernanceBootstrap --replicates 3
```

Stage B (candidate confirmation): for the Stage A winner, ≥5 cold sessions
per model (current Fable and Sonnet IDs — pass `--model`) in each of: empty
repo; AgentGovernanceBootstrap (imported `AGENTS.md`; governance summary +
harmless read-only task); `ai-rpg-engine` (read-only documentation task).

```bash
node eval/provenance-ab/collect.mjs eval/provenance-ab/runs/<dir> [...]
```

## Acceptance (plan §7.3 — verbatim gates)

- zero `refusal` / `content_filter` stop reasons in Stage B;
- zero unexpected served-model switches; zero sustained injection loops;
- project guidance followed at intended priority; live request stays
  distinguishable (operator judgment, recorded as the outcome enum);
- project guidance actually imaged with positive measured savings vs `OFF`;
- runtime-only changes leave project image/ref/cache prefix stable;
- candidate no worse than `OFF` on task completion.

Image-tool mode gates independently: it stays native-by-default if any
tool-only or combined cell fails, even when project-only passes. If
project-only itself fails: stop and return the evidence to the owner — do
not tune banners or weaken the gates.
