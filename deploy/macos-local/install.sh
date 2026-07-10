#!/usr/bin/env bash
# Install a verified pxpipe fork bundle as a loopback-only macOS LaunchAgent.

set -euo pipefail
umask 077

LABEL="com.pxpipe.proxy"
HOST_BIND="127.0.0.1"
PORT="${PXPIPE_PORT:-47821}"
GUI_DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_ROOT="$HOME/Library/Application Support/pxpipe"
RELEASES="$INSTALL_ROOT/releases"
CURRENT="$INSTALL_ROOT/current"
LOG_DIR="$HOME/Library/Logs/pxpipe"
OUT_LOG="$LOG_DIR/pxpipe.out.log"
ERR_LOG="$LOG_DIR/pxpipe.err.log"
BUNDLE_DIR="$(cd "$(dirname "$0")" && pwd)"
MANIFEST="$BUNDLE_DIR/manifest.json"

fail() {
  echo "✗ $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

stop_service() {
  launchctl bootout "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1 || true
}

write_plist() {
  local node_path="$1"
  local cli_path="$2"
  local target="$PLIST.tmp.$$"

  mkdir -p "$(dirname "$PLIST")" "$LOG_DIR"
  touch "$OUT_LOG" "$ERR_LOG"
  chmod 600 "$OUT_LOG" "$ERR_LOG"

  cat > "$target" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$node_path")</string>
    <string>$(xml_escape "$cli_path")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>$HOST_BIND</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$(xml_escape "$OUT_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$ERR_LOG")</string>
</dict>
</plist>
EOF
  chmod 600 "$target"
  mv -f "$target" "$PLIST"
}

wait_for_health() {
  local attempts="15"
  local delay="1"
  local i

  for ((i = 0; i < attempts; i += 1)); do
    if curl -fsS -o /dev/null "http://$HOST_BIND:$PORT/"; then
      return 0
    fi
    sleep "$delay"
  done
  return 1
}

wait_for_port_free() {
  local i
  for ((i = 0; i < 50; i += 1)); do
    if [[ -z "$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if [[ "$(uname -s)" != "Darwin" ]]; then
  fail "this installer is macOS-only"
fi

require_command launchctl

if [[ "${1:-}" == "--uninstall" ]]; then
  [[ "$#" -eq 1 ]] || fail "usage: ./install.sh --uninstall"
  stop_service
  rm -f "$PLIST"
  rm -rf "$INSTALL_ROOT"
  cat <<EOF
✓ pxpipe service and installed program removed.
  Preserved logs:   $LOG_DIR
  Preserved events: $HOME/.pxpipe/events.jsonl
EOF
  exit 0
fi

[[ "$#" -eq 0 ]] || fail "usage: ./install.sh [--uninstall]"
[[ "$PORT" =~ ^[1-9][0-9]*$ ]] || fail "PXPIPE_PORT must be an integer from 1 to 65535"
(( 10#$PORT >= 1 && 10#$PORT <= 65535 )) ||
  fail "PXPIPE_PORT must be an integer from 1 to 65535"

for command in node tar shasum curl sed awk basename cmp mktemp readlink lsof; do
  require_command "$command"
done
NODE="$(command -v node)"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail "could not determine the Node version"
(( NODE_MAJOR >= 18 )) || fail "Node 18 or newer is required; found $("$NODE" --version)"

[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || fail "manifest.json is missing beside install.sh"

FIELDS="$("$NODE" -e '
  const fs = require("node:fs");
  const file = process.argv[1];
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const keys = ["version", "sourceCommit", "archive", "sha256"];
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.keys(value).sort().join("\n") !== keys.slice().sort().join("\n") ||
    keys.some((key) => typeof value[key] !== "string")
  ) {
    process.exit(3);
  }
  process.stdout.write(keys.map((key) => value[key]).join("\t"));
' "$MANIFEST")" || fail "manifest.json is malformed"

IFS=$'\t' read -r VERSION SOURCE_COMMIT ARCHIVE SHA256 <<< "$FIELDS"
[[ "$VERSION" =~ ^[0-9A-Za-z][0-9A-Za-z.+-]*$ ]] || fail "manifest version is invalid"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]] || fail "manifest sourceCommit is invalid"
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "manifest sha256 is invalid"
EXPECTED_ARCHIVE="pxpipe-proxy-$VERSION-$SOURCE_COMMIT.tgz"
[[ "$ARCHIVE" == "$EXPECTED_ARCHIVE" ]] || fail "manifest archive name does not match its version and source"
[[ "$ARCHIVE" == "$(basename "$ARCHIVE")" ]] || fail "manifest archive must be a plain filename"
ARCHIVE_PATH="$BUNDLE_DIR/$ARCHIVE"
[[ -f "$ARCHIVE_PATH" && ! -L "$ARCHIVE_PATH" ]] || fail "verified package archive is missing beside install.sh"

ACTUAL_SHA="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
[[ "$ACTUAL_SHA" == "$SHA256" ]] || fail "package checksum does not match manifest.json"

while IFS= read -r entry; do
  entry="${entry#./}"
  [[ "$entry" == package/* ]] || fail "package archive contains an unsafe path: $entry"
  [[ "/$entry/" != *"/../"* ]] || fail "package archive contains an unsafe path: $entry"
done < <(tar -tzf "$ARCHIVE_PATH")

while IFS= read -r mode _; do
  case "${mode:0:1}" in
    -|d) ;;
    *) fail "package archive contains a link or unsupported entry type" ;;
  esac
done < <(tar -tvzf "$ARCHIVE_PATH")

mkdir -p "$RELEASES"
chmod 700 "$INSTALL_ROOT" "$RELEASES"
STAGING="$(mktemp -d "$INSTALL_ROOT/.staging.XXXXXX")"
NEXT_LINK="$INSTALL_ROOT/.current.$$"
PLIST_BACKUP="$STAGING/previous.plist"
cleanup() {
  rm -f "$NEXT_LINK"
  rm -rf "$STAGING"
}
trap cleanup EXIT

tar -xzf "$ARCHIVE_PATH" -C "$STAGING"
PACKAGE_DIR="$STAGING/package"
for required in "bin/cli.js" "dist/node.js" "package.json"; do
  [[ -f "$PACKAGE_DIR/$required" && ! -L "$PACKAGE_DIR/$required" ]] ||
    fail "package archive is missing a regular $required"
done

PACKED_VERSION="$("$NODE" -p 'require(process.argv[1]).version' "$PACKAGE_DIR/package.json")"
[[ "$PACKED_VERSION" == "$VERSION" ]] || fail "package version does not match manifest.json"
CLI_VERSION="$("$NODE" "$PACKAGE_DIR/bin/cli.js" --version)"
[[ "$CLI_VERSION" == "$VERSION" ]] || fail "packaged command reported the wrong version"

RELEASE_DIR="$RELEASES/$SOURCE_COMMIT"
NEW_RELEASE=0
if [[ -e "$RELEASE_DIR" ]]; then
  [[ -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || fail "release path is not a normal directory"
  [[ -f "$RELEASE_DIR/.pxpipe-manifest.json" ]] || fail "existing release lacks its install receipt"
  cmp -s "$MANIFEST" "$RELEASE_DIR/.pxpipe-manifest.json" ||
    fail "the same source commit is already installed with different contents"
else
  cp "$MANIFEST" "$PACKAGE_DIR/.pxpipe-manifest.json"
  chmod -R go-rwx "$PACKAGE_DIR"
  mv "$PACKAGE_DIR" "$RELEASE_DIR"
  NEW_RELEASE=1
fi

OLD_TARGET=""
if [[ -L "$CURRENT" ]]; then
  OLD_TARGET="$(readlink "$CURRENT")"
fi
if [[ -f "$PLIST" ]]; then
  cp "$PLIST" "$PLIST_BACKUP"
fi

stop_service
if ! wait_for_port_free; then
  if [[ -f "$PLIST_BACKUP" ]]; then
    launchctl bootstrap "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  fi
  if [[ "$NEW_RELEASE" -eq 1 ]]; then
    rm -rf "$RELEASE_DIR"
  fi
  fail "port $PORT is still in use after stopping the previous service"
fi
ln -s "$RELEASE_DIR" "$NEXT_LINK"
rm -f "$CURRENT"
mv "$NEXT_LINK" "$CURRENT"
write_plist "$NODE" "$CURRENT/bin/cli.js"

STARTED=0
if launchctl bootstrap "$GUI_DOMAIN" "$PLIST"; then
  STARTED=1
fi

if [[ "$STARTED" -ne 1 ]] || ! wait_for_health; then
  echo "✗ new pxpipe release failed its local health check; restoring the previous release" >&2
  stop_service

  if [[ -n "$OLD_TARGET" && -d "$OLD_TARGET" ]]; then
    rm -f "$CURRENT"
    ln -s "$OLD_TARGET" "$CURRENT"
    if [[ -f "$PLIST_BACKUP" ]]; then
      cp "$PLIST_BACKUP" "$PLIST"
    fi
    launchctl bootstrap "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  elif [[ -f "$PLIST_BACKUP" ]]; then
    rm -f "$CURRENT"
    cp "$PLIST_BACKUP" "$PLIST"
    launchctl bootstrap "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  else
    rm -f "$CURRENT" "$PLIST"
  fi

  if [[ "$NEW_RELEASE" -eq 1 ]]; then
    rm -rf "$RELEASE_DIR"
  fi
  exit 1
fi

if [[ -n "$OLD_TARGET" && "$OLD_TARGET" != "$RELEASE_DIR" ]]; then
  for candidate in "$RELEASES"/*; do
    [[ -e "$candidate" ]] || continue
    if [[ "$candidate" != "$RELEASE_DIR" && "$candidate" != "$OLD_TARGET" ]]; then
      rm -rf "$candidate"
    fi
  done
fi

cat <<EOF
✓ pxpipe $VERSION is running locally and will start at login.
  dashboard  http://$HOST_BIND:$PORT/
  logs       $LOG_DIR/
  events     $HOME/.pxpipe/events.jsonl

Start Claude Code with:
  ANTHROPIC_BASE_URL=http://$HOST_BIND:$PORT claude

Uninstall with:
  $BUNDLE_DIR/install.sh --uninstall
EOF
