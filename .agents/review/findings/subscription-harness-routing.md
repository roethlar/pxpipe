# subscription-harness-routing: Local subscription routing

**Severity**: N/A — owner-approved implementation slice, not a defect finding
**Status**: Verified — live smoke, installation, and push remain owner-gated
**Branch**: `fix/provenance-safe-compression`
**Commits**: `80172ae` through `dfeb07f`

## Plan authority

`docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md` records the independently accepted
plan and the owner's later approval to implement its code slice. Live
subscription calls, installation, and push remain separate owner gates.

## What the slice claims

- Plain POST `/responses` reaches the configured OpenAI service and receives
  the existing Responses compression for an opted-in Sol model.
- Authenticated plain `/models` paths and exact `/v1/settings` reach the
  configured OpenAI service without changing their path, query, or login
  headers.
- Grok's existing `/v1/models` and `/v1/responses` routes remain direct and
  unchanged.
- Other methods on plain `/responses`, unauthenticated model paths, Anthropic
  authentication, and settings lookalikes stay on the generic service.
- README commands use stored subscription login, explicitly opt in the three
  requested models, isolate each provider, and distinguish manual examples
  from the separately gated acceptance smoke.

## Files changed

- `src/core/proxy.ts` — narrow direct-route recognition.
- `tests/gateway.test.ts` — exact paths, queries, login headers, authentication,
  method, and lookalike routing.
- `tests/proxy-usage.test.ts` — Sol Responses compression and positive image
  count.
- `README.md` — no-key manual Codex and Grok routing commands.

## Guard proof

- Removing plain `/responses` and `/models` recognition made four focused tests
  fail; restoration returned all 52 then-current focused tests to green.
- Removing exact `/v1/settings` classification made its focused test fail while
  the lookalike cases stayed green; restoration returned all 52 focused tests
  to green.
- The authenticated GET `/responses` test failed against the initial
  implementation, then passed after `aa1102e` limited the plain route to POST.
- Temporarily removing the established Grok `/v1/models` and `/v1/responses`
  classifications made both new direct-route tests fail; restoration returned
  the gateway suite to green.

## Pre-review audit adjudication

- **Adopted** in `aa1102e`: plain `/responses` must be POST-only.
- **Adopted** in `ea8671d`: pin direct Grok model and response routes.
- **Adopted** in `7302ff1`: remove the smoke-local config file rather than rely
  on a non-stopping shell test.
- **Adopted** in `bc8a139`: copy optional user and locale fields only when they
  are defined; the helper passed both Bash and Zsh probes.
- **Clarified** in `dfeb07f`: README commands are manual connectivity examples,
  not the stricter acceptance smoke. The live smoke remains owner-gated.
- The installed bundle still records source `102b983`. This is expected until
  review acceptance; rebuilding and installing before review would put an
  unaccepted binary into the login service.

## Verification

- Focused final suites: 55 passed.
- `pnpm run typecheck`: passed.
- `pnpm test`: 818 passed.
- `pnpm run build`: passed; `--version` reports
  `0.8.0-provenance-safe.1`.
- No real credential was read or logged. No model request, installation, or
  push occurred during implementation verification.

## Known gaps

- No live Fable, Sol, or Grok smoke has run.
- The reviewed bundle has not yet been regenerated or installed.
- The larger provenance A/B matrix remains separately owner-gated.

## Reviewer comments

- Reviewer: Claude Code 2.1.206 / Sonnet 5 (`claude -p`, structured output),
  run with pxpipe bypassed in a disposable worktree under `~/Dev`.
- Reviewed SHA: `9ef32c5e3348d34a3d42815353895fdc8e073dfb`;
  base SHA: `b48e84bec344cdb3790a716b44df4f8baf27bafb`.
- `guard_confirmed: true`.
- Verdict: **accepted** (2026-07-10 23:36 UTC), no material findings.
- Comments (verbatim):
  1. "No material issue found. Reviewed git diff b48e84b..9ef32c5
     (src/core/proxy.ts, tests/gateway.test.ts, tests/proxy-usage.test.ts,
     README.md, .agents/review/*) against
     docs/LOCAL_SUBSCRIPTION_HARNESS_PLAN.md and the finding doc; the
     implementation matches the chosen design table exactly (plain POST
     /responses, authenticated plain/v1 /models, exact authenticated
     /v1/settings, existing Grok /v1/models and /v1/responses left
     untouched)."
  2. "Guard 1 (src/core/proxy.ts:515-531, plain /responses and /models
     recognition): reverted isOpenAIResponsesPath and isModelsPath to drop the
     plain-path branches — 3 tests/gateway.test.ts cases and 1
     tests/proxy-usage.test.ts case failed exactly as predicted (plain
     /responses and both /models variants routed to the Anthropic stub instead
     of OpenAI, and the Sol transform test lost its upstream match). Restored
     via git checkout; git diff against 9ef32c5 was empty and the 4 tests
     passed again."
  3. "Guard 2 (src/core/proxy.ts:532, exact /v1/settings): forced
     isSettingsPath to false — the positive 'routes authenticated exact
     /v1/settings' test failed (routed to Anthropic stub) while all 4 lookalike
     cases (/v1/settings, /v1/settings/, /v1/settings/child, /v1/settingsish)
     stayed correctly generic and green. Restored cleanly; all 5 tests passed."
  4. "Guard 3 (src/core/proxy.ts:534, POST-only gate on plain /responses):
     removed the 'method === POST &&' guard — the authenticated GET /responses
     negative test failed (request wrongly routed to the OpenAI stub instead
     of staying on the generic upstream). Restored cleanly; test passed."
  5. "Guard 4 (src/core/proxy.ts:528-537, established Grok /v1/models and
     /v1/responses classification): dropped '/v1/models' from isModelsPath and
     dropped the '/v1/responses' exact/prefix branches — both named 'routes
     authenticated Grok ... to its configured upstream unchanged' tests (GET
     /v1/models and POST /v1/responses) failed, routing to the Anthropic stub
     instead of the Grok-configured upstream. Restored cleanly; both tests
     passed."
  6. "After restoration, working tree byte-diff against 9ef32c5 (git diff
     9ef32c5 -- .) was empty for all four mutation cycles — no residual drift
     between guard proofs."
  7. "pnpm run typecheck: clean, no errors. pnpm test: 817/818 passed; the sole
     failure (tests/provenance-ab-collect.test.ts 'validates the selected
     source before prepare-only can succeed', line 408) is a pre-existing,
     diff-unrelated environmental flake — confirmed by checking out base
     commit b48e84b (untouched file, untouched
     eval/provenance-ab/run-variant.sh) and reproducing the identical failure
     there; likely an ambient git-repo-detection quirk for a tmp dir in this
     sandbox, not something this slice introduced. pnpm run build: clean,
     emitted dist/, and the --version smoke check printed
     0.8.0-provenance-safe.1 matching the finding doc's claim. Note: the
     sandbox initially had no pnpm on PATH and scripts/build.mjs shells out to
     `pnpm exec tsc` (failing silently, exit 1, no stderr, since spawnSync
     ENOENTs with stdio:'inherit'); pnpm@10.21.0 was already fully cached by
     npm (from an unrelated prior session) and was installed with `npm install
     -g pnpm@10.21.0 --offline`, so no network access occurred and no
     dependency versions changed."
  8. "git status is clean at the reviewed head; the only ignored paths present
     are node_modules/ and dist/ (build output), both covered by .gitignore —
     no stray tracked or untracked artifacts."
  9. "Reviewed the README.md clean-environment shell helper
     (pxpipe_clean_env, README.md:124-133) by running it standalone in both
     bash and zsh with OPENAI_API_KEY/ANTHROPIC_API_KEY/an arbitrary ambient
     var exported: the resulting child environment contained only HOME, PATH,
     TMPDIR (forced), the defined optional fields (TERM, LANG, LOGNAME, USER;
     SHELL/LC_ALL also pass through when defined), and the caller's explicit
     routing vars — no ambient key or stray var leaked through, matching the
     plan's allowlist-only requirement."
  10. "Cross-checked the documented Codex and Grok manual commands
      (README.md:136-187) against the plan: ports 47832 (Sol, upstream
      https://chatgpt.com/backend-api/codex) and 47833 (Grok, upstream
      https://cli-chat-proxy.grok.com) match;
      ANTHROPIC_UPSTREAM=http://127.0.0.1:9 fail-closed pattern matches; all env
      var names (PXPIPE_CONFIG, PXPIPE_MODELS, PXPIPE_LOG,
      ANTHROPIC_UPSTREAM, OPENAI_UPSTREAM, HOST, PORT) match src/node.ts's
      actual reads; the Codex custom-provider flags (base_url,
      wire_api=responses, requires_openai_auth=true,
      supports_websockets=false, zero retries, --ignore-user-config
      --ephemeral) and the Grok flags (--permission-mode plan, --max-turns 1,
      --no-subagents, --disable-web-search, --no-memory) match the plan's
      per-arm requirements; the section is explicitly and correctly
      distinguished from the separately owner-gated acceptance smoke,
      consistent with commit dfeb07f's adjudication recorded in the finding
      doc. No code was installed, packaged, or pushed; no model call was made;
      only the reviewer's disposable worktree was touched."

The coder worktree's complete gate passed all 818 tests both before dispatch
and at the final implementation head. The reviewer's one failure reproduced
unchanged at the pinned base in its isolated environment and does not reopen
this slice.
