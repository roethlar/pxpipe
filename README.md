# pxpipe

pxpipe is a local proxy that can reduce selected Anthropic request context by
replacing exact text spans with PNG images. Model responses are streamed
unchanged.

This fork is deliberately conservative: each changed span must keep its original
API container, and a complete cache-aware measurement must prove the whole
candidate will be cheaper. An uncertain span stays text. Any candidate-wide
uncertainty forwards the original request bytes.

## What it changes

For Anthropic Messages requests, two kinds of text may be eligible:

- an exactly recognized project-guidance span in Claude Code's opening user
  context; and
- large, successful, plain-prose `tool_result` text.

An accepted image occupies the exact source span inside the original user block
or `tool_result`. Text before and after it stays in place. pxpipe does not add
labels, pointers, summaries, manifests, instructions, paging notices, or other
model-readable prose. It does not reflow, trim, normalize, or truncate the
source.

These parts always remain native text:

- system content and Claude Code host metadata, including email and date fields;
- tool definitions;
- ordinary conversation text and the current request;
- error results, recognized structured data, logs, precision-sensitive patterns,
  terminal control sequences, unsupported shapes, and any text the renderer
  cannot preserve exactly.

An unsafe or unrenderable source span stays text; another independent safe span
may still be considered. Before forwarding any changed Anthropic request,
pxpipe checks the complete candidate for the observed system-attachment ordering
rule and asks the provider to count the complete original request, original
cacheable prefix, candidate request, and candidate prefix. Compression proceeds
only when that candidate clears both a 10% and a 256-effective-token safety
reserve. Missing or failed measurements, an invalid system-attachment order, or
an uneconomic complete candidate restores the complete original body.

OpenAI Chat Completions and Responses requests are byte-for-byte pass-through.
That includes Codex/Sol and Grok traffic. Their routing and telemetry still work,
but pxpipe does not rewrite those request bodies or claim savings for them.
Selecting Sol or Grok in the dashboard does not change that behavior.

Anthropic history is never collapsed, moved, or wrapped in a synthetic message.
An eligible `tool_result` span can still be replaced in place even when it is in
an older user message; its containing message, role, block, and surrounding text
do not move.

## Install this fork locally on macOS

The public `npx pxpipe-proxy` command installs the published release, not this
fork. The corrected fork branch is not published yet, so do not install it from
a remote clone until its final commit is pushed. From the reviewed local
checkout, build a verified per-user service bundle directly into a stable
directory:

```bash
npx -y -p pnpm@10.21.0 pnpm install --frozen-lockfile
npx -y -p pnpm@10.21.0 pnpm run package:macos-local -- --output "$HOME/Dev/pxpipe-deploy"
"$HOME/Dev/pxpipe-deploy/install.sh"
```

The package builder requires a clean source tree, runs type checking, tests, and
the production build, and writes the archive, checksum manifest, and installer
directly to `~/Dev/pxpipe-deploy`. It refuses output under `/private` or inside
the source worktree.

The installer verifies the adjacent archive and checksum, installs under the
current user, and starts a login service on `127.0.0.1:47821`. It uses no sudo,
public package registry, or Cloudflare deployment. Node 18 or newer is required.
The installer preconfigures Fable, Sol, and Grok in the persistent startup
scope; only the safe Anthropic path currently rewrites request bodies. A
dashboard change is runtime-only unless it matches that saved startup scope.

Start Claude Code through the local service:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:47821 claude
```

The dashboard is at <http://127.0.0.1:47821/>. Rebuild the bundle and rerun the
installer to update. Uninstall the service and program while preserving logs and
events with:

```bash
"$HOME/Dev/pxpipe-deploy/install.sh" --uninstall
```

Installation and local health checks do not call any model.

## Codex and Grok subscription routing

Codex and Grok request bodies are safe pass-through, but the installed service
does not yet provide the promised one-port subscription routing. The rejected
multi-terminal workaround is not a supported setup. The already approved
follow-on must make one saved client configuration sufficient for plain
`codex` and plain `grok`; it remains paused until this correction is installed
and passes its local checks.

## Savings and telemetry

The dashboard and `~/.pxpipe/events.jsonl` record signed, cache-aware results.
A request receives a savings counterfactual only when Anthropic compression
actually ran and every required full-request and prefix measurement succeeded.
Negative results remain visible; they are never clamped or hidden.
New rows keep hashes, counts, status, timing, and usage—not request bodies,
upstream error bodies, caller email/date values, workspace paths, or exception
text.

The corrected design has not run its separately authorized live A/B matrix, so
this README makes no current end-to-end savings claim. Historical evaluations
under [`eval/`](eval/) describe earlier renderers and should not be treated as
measurements of this corrected default.

## Library use

The renderer is available independently:

```ts
import { renderTextToImages } from "pxpipe-proxy";

const { pages } = await renderTextToImages(text);
```

The exported Anthropic transform cannot perform the authenticated provider
measurements required for admission, so a standalone transform call returns the
original request. Use the local proxy for admitted compression. The exported
OpenAI Chat and Responses transforms also return the original bytes by design.

## Development

```bash
pnpm install
pnpm run typecheck && pnpm test && pnpm run build
```

The package manager is pnpm. Do not create an npm lockfile.

## Limitations

- Images are lossy for model recall even when the source was rendered exactly.
  Recognized precision-sensitive patterns stay text, but the heuristic cannot
  identify every exact value, and any detail inside an eligible image can still
  be misread.
- Candidate rendering and up to four provider token-count calls add latency
  before an accepted Anthropic request is forwarded.
- OpenAI-compatible requests currently receive routing and telemetry only; they
  receive no context compression.
- The supported package and installer are local macOS service tooling. They do
  not publish, deploy, push, or make live model calls.
- Older releases may already have raw 4xx samples in `~/.pxpipe/events.jsonl`
  or `~/.pxpipe/4xx-bodies/`. This release creates no new samples and does not
  silently delete existing owner data.

Technical telemetry fields and fallback reasons are documented in
[`docs/TRANSFORM_INFO.md`](docs/TRANSFORM_INFO.md).

## License

MIT.
