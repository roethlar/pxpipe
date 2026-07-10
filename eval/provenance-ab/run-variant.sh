#!/usr/bin/env bash
# One matrix cell = one variant × one workspace × N cold replicates (plan §7.1).
#
#   bash eval/provenance-ab/run-variant.sh --variant PROJECT_RUNTIME \
#        --workspace empty --replicates 3 [--model claude-fable-5] \
#        [--prompt "..."] [--workspace-dir /path/to/repo] [--legacy-dir /path]
#        [--record-variant PROJECT] [--prepare-only]
#
# Each replicate is a COLD single-shot `claude -p` session through a fresh
# proxy with its own events.jsonl under eval/provenance-ab/runs/. Afterwards:
#   node eval/provenance-ab/collect.mjs eval/provenance-ab/runs/<dir>...
#
# OWNER GATE: makes real billed Anthropic calls and probes safety classifiers.
# Run only with an explicit owner go (separate from plan approval).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1   # -> repo root

VARIANT=""
WORKSPACE="empty"           # empty | dir (with --workspace-dir)
WORKSPACE_DIR=""
REPLICATES=3
MODEL="claude-fable-5"
PROMPT="Inspect this repository and report in plain prose: what it contains, what governance or instructions apply, and one observation. Make no changes."
LEGACY_DIR=""               # pinned worktree for --variant LEGACY (plan base b1f5a01)
RECORD_VARIANT=""            # label written to metadata; defaults to VARIANT
PREPARE_ONLY=0                # build and validate the source, then make no calls
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

while [ $# -gt 0 ]; do
  case "$1" in
    --variant)        VARIANT="$2"; shift 2 ;;
    --workspace)      WORKSPACE="$2"; shift 2 ;;
    --workspace-dir)  WORKSPACE_DIR="$2"; shift 2 ;;
    --replicates)     REPLICATES="$2"; shift 2 ;;
    --model)          MODEL="$2"; shift 2 ;;
    --prompt)         PROMPT="$2"; shift 2 ;;
    --legacy-dir)     LEGACY_DIR="$2"; shift 2 ;;
    --record-variant) RECORD_VARIANT="$2"; shift 2 ;;
    --prepare-only)   PREPARE_ONLY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

case "$VARIANT" in
  OFF|PROJECT_RUNTIME|TOOLS|BOTH) ;;
  LEGACY)
    [ -n "$LEGACY_DIR" ] || { echo "LEGACY needs --legacy-dir <pinned worktree at b1f5a01, built>" >&2; exit 2; } ;;
  PROJECT)
    echo "PROJECT (runtime native) is not config-expressible on this build; run it" >&2
    echo "from a disposable worktree with the one-line neutralization in README.md," >&2
    echo "then use --variant LEGACY --record-variant PROJECT" >&2
    echo "--legacy-dir <that worktree>." >&2
    exit 2 ;;
  *) echo "unknown variant: $VARIANT" >&2; exit 2 ;;
esac

RECORD_VARIANT="${RECORD_VARIANT:-$VARIANT}"
case "$RECORD_VARIANT" in
  OFF|LEGACY|PROJECT|PROJECT_RUNTIME|TOOLS|BOTH) ;;
  *) echo "unknown recorded variant: $RECORD_VARIANT" >&2; exit 2 ;;
esac
if [ "$RECORD_VARIANT" != "$VARIANT" ] &&
   { [ "$VARIANT" != LEGACY ] || [ "$RECORD_VARIANT" != PROJECT ]; }; then
  echo "--record-variant may only relabel a patched LEGACY run as PROJECT" >&2
  exit 2
fi

SOURCE_DIR="$(pwd)"
[ "$VARIANT" = LEGACY ] && SOURCE_DIR="$LEGACY_DIR"
( cd "$SOURCE_DIR" && npm run build >/dev/null ) || exit 1
node eval/provenance-ab/run-metadata.mjs --validate-source "$SOURCE_DIR" || exit 1
[ "$PREPARE_ONLY" -eq 0 ] || exit 0

for r in $(seq 1 "$REPLICATES"); do
  STAMP="$(date +%Y%m%d-%H%M%S)"
  RUN_DIR="eval/provenance-ab/runs/${STAMP}-${RECORD_VARIANT}-${WORKSPACE}-r${r}"
  mkdir -p "$RUN_DIR/turns"
  RUN_ABS="$(cd "$RUN_DIR" && pwd)"
  node eval/provenance-ab/run-metadata.mjs \
    --output "$RUN_ABS/metadata.json" \
    --variant "$RECORD_VARIANT" \
    --workspace "$WORKSPACE" \
    --replicate "$r" \
    --requested-model "$MODEL" \
    --source-dir "$SOURCE_DIR" || exit 1

  # Fresh free port per replicate.
  PORT=47911
  while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do PORT=$((PORT + 1)); done

  # --- proxy for this replicate ---------------------------------------------
  if [ "$VARIANT" = LEGACY ]; then
    ( cd "$LEGACY_DIR" && PORT="$PORT" PXPIPE_LOG="$RUN_ABS/events.jsonl" \
        node bin/cli.js ) > "$RUN_ABS/proxy.log" 2>&1 &
  else
    node eval/provenance-ab/variant-proxy.mjs --variant "$VARIANT" \
      --port "$PORT" --log "$RUN_ABS/events.jsonl" > "$RUN_ABS/proxy.log" 2>&1 &
  fi
  PROXY_PID=$!
  cleanup() { kill "$PROXY_PID" 2>/dev/null; wait "$PROXY_PID" 2>/dev/null; }
  trap cleanup EXIT

  for _ in $(seq 1 100); do
    grep -q 'listening on' "$RUN_ABS/proxy.log" 2>/dev/null && break
    kill -0 "$PROXY_PID" 2>/dev/null || { echo "proxy died; see $RUN_DIR/proxy.log" >&2; exit 1; }
    sleep 0.1
  done
  grep -q 'listening on' "$RUN_ABS/proxy.log" || { echo "proxy never came up" >&2; exit 1; }

  # --- workspace --------------------------------------------------------------
  if [ "$WORKSPACE" = empty ]; then
    WS="$RUN_ABS/ws"
    mkdir -p "$WS"
    git -C "$WS" init -q
    echo "# scratch" > "$WS/README.md"
    git -C "$WS" add -A && git -C "$WS" -c user.email=ab@pxpipe -c user.name=ab commit -qm seed
  else
    [ -d "$WORKSPACE_DIR" ] || { echo "--workspace-dir '$WORKSPACE_DIR' not found" >&2; exit 2; }
    WS="$WORKSPACE_DIR"
  fi

  # --- one cold session --------------------------------------------------------
  echo "[$VARIANT r$r] port=$PORT ws=$WS"
  ( cd "$WS" && env ANTHROPIC_BASE_URL="http://127.0.0.1:$PORT" \
      "$CLAUDE_BIN" -p "$PROMPT" --model "$MODEL" --output-format json \
      --setting-sources project --strict-mcp-config \
  ) > "$RUN_ABS/turns/turn-1.json" 2> "$RUN_ABS/turns/turn-1.err" \
    || echo "[$VARIANT r$r] session failed; see $RUN_DIR/turns/turn-1.err" >&2

  cleanup; trap - EXIT
  # Stage-A early stop: do not spend the next call after a safety result,
  # unexpected served model, unreadable turn, or repeated injection accusation.
  node eval/provenance-ab/check-stop.mjs \
    --requested-model "$MODEL" \
    --turn "$RUN_ABS/turns/turn-1.json" \
    --events "$RUN_ABS/events.jsonl"
  STOP_STATUS=$?
  if [ "$STOP_STATUS" -ne 0 ]; then
    echo "[$VARIANT r$r] EARLY STOP — do not spend further replicates on this cell (plan §7.1)" >&2
    exit "$STOP_STATUS"
  fi
done
echo "cell done → collect with: node eval/provenance-ab/collect.mjs eval/provenance-ab/runs/<dirs>"
