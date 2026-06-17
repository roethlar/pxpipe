# Changelog

All notable changes to pxpipe are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) (pre-1.0: minor = features /
behavioral changes, patch = fixes).

## 0.3.1 — 2026-06-17

### Changed
- **Demo:** the side-by-side A/B clip moved to Google Drive (the committed copy
  was too low-res to read). The README keeps the preview thumbnail and links out
  to the video; the 8.9 MB video binary is no longer in the package/repo tree.

## 0.3.0 — 2026-06-17

Render-sizing overhaul, dashboard transparency, honest savings accounting, and a
multi-agent code review with five confirmed fixes. Reviewed at extra-high recall
(10 finder angles → verify → sweep).

### Changed
- **Render page ceiling raised to ~1932×1932.** Fable 5 / Opus 4.8 accept images
  up to 2576 px long edge / 4784 visual tokens, but a request with >20 images
  (pxpipe always sends many) is held to the stricter ≤2000 px/side rule — so the
  real ceiling is ~1932×1932 (1928×1928 = 69×69 = 4761 tokens). `MAX_HEIGHT_PX`
  1568→1932; dense tool/history pages now `DENSE_CONTENT_COLS=384` /
  `DENSE_CONTENT_CHARS_PER_IMAGE=92160` (1928×1928 full page) — fewer image
  blocks at the same OCR-validated 5×8 cell. The static slab is unchanged
  (313 cols / 1573×1280). Pages never trip a server-side downscale. Note: the
  larger per-page density uses the validated 5×8 cell and stays within
  Anthropic's pixel/token limits, but OCR legibility at this page size has not
  been independently re-eval'd (revert = the four render constants).
- **Opus is OFF by default.** Production scope defaults to **Fable-5 only**;
  Opus 4.8/4.7 are opt-in (they read imaged content at a measurable tax — see
  FINDINGS.md). Opt in via `PXPIPE_MODELS` or the dashboard chips.
- **Honest savings accounting.** Per-turn/session savings are the real
  `baseline_eff − actual_eff` with **no ≥0 floor** — a net-losing turn (e.g. a
  cache_create-heavy image rewrite) now reports the real loss instead of a
  fabricated 0. (Dashboard renders negatives explicitly.)

### Added
- **Dashboard "how your context works" panel** — per-request token flow
  (as-text → real) + the exact-char breakdown of what became images + a gallery
  of every rendered page, reached via a **"view"** link on each recent-requests
  row.
- **Flexible "compress models" chips** — the toggle set is the union of a model
  catalog (Fable 5, Opus 4.8/4.7, Sonnet 4.6, Haiku 4.5), the `PXPIPE_MODELS`
  env scope, and the currently-active scope, so any env-enabled model stays
  toggleable (off ↔ on). Runtime-only override of the compress scope.
- **Demos** — `demo/cost-ab/` (cost A/B on a real coding task) and
  `demo/effective-context/` (recall-at-scale needle test), each with a model
  arg: defaults to Fable, `a.sh opus` to override. Plus `eval/ab/` token-savings
  scripts.

### Fixed (from the code review)
- **Tool_result over-truncation (regression):** the paging/break-even gate and
  `truncateForBudget` predicted against the slab geometry (313 cols / 159 rows)
  while the dense renderer emits 384 cols / 240 rows — so large tool_results
  were truncated far earlier than the 10-image cap required, silently dropping
  output that would have rendered. The gate, paging budget, and image-count
  estimate now price the same page the renderer produces.
- **Garbled session headline:** a net-losing session showed "-7% fewer tokens";
  now phrased honestly as "N% more tokens".
- **Context-map "view" mis-resolution:** `contextHistory` capped at 30 while the
  recent table showed 50 rows, so older rows' "view" links silently showed the
  *latest* request's breakdown. Caps aligned; an evicted/unrecorded request now
  shows an explicit "no longer available" message instead of wrong data.
- **Multi-col token cap:** the multi-col width ceiling now respects the 4784
  visual-token limit at full page height (was bounded only by the 2000 px side
  limit, which could produce a 4968-token page that the API rejects).
- **Doc/code contradictions:** `baseline.ts` and caller comments no longer claim
  a ≥0 clamp the code intentionally doesn't apply.

### Docs
- Rewrote `docs/RENDER_SIZING.md` and updated `docs/TRANSFORM_INFO.md`,
  `README.md`, and in-code comments for the new ceiling and limits.
