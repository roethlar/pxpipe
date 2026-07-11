#!/bin/sh
# Verify one immutable bundle generation, then enter its transaction-safe Node
# installer. The stable root launcher selects this directory exactly once.

set -eu
umask 077

fail() {
  echo "✗ $*" >&2
  exit 1
}

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--uninstall" ]; }; then
  fail "usage: ./install.sh [--uninstall]"
fi

# These variables can inject code or create files before installer verification.
unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_COMPILE_CACHE_PORTABLE

command -v uname >/dev/null 2>&1 || fail "required command not found: uname"
UNAME="$(command -v uname)"
case "$UNAME" in
  /*) ;;
  *) fail "uname must resolve to an absolute executable" ;;
esac
[ -f "$UNAME" ] && [ -x "$UNAME" ] || fail "uname is not an executable file"
[ "$("$UNAME" -s)" = "Darwin" ] || fail "this installer is macOS-only"
command -v node >/dev/null 2>&1 || fail "required command not found: node"
NODE="$(command -v node)"
case "$NODE" in
  /*) ;;
  *) fail "node must resolve to an absolute executable" ;;
esac
[ -f "$NODE" ] && [ -x "$NODE" ] || fail "node is not an executable file"
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "could not determine the Node version" ;;
esac
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 18 or newer is required; found $("$NODE" --version)"

case "$0" in
  /bin/sh|sh)
    SCRIPT_PATH=${PXPIPE_VERIFIED_SCRIPT_PATH:-}
    case "$SCRIPT_PATH" in
      /*) SCRIPT_DIRECTORY=${SCRIPT_PATH%/*} ;;
      *) fail "verified bootstrap path is unavailable" ;;
    esac
    ;;
  */*) SCRIPT_DIRECTORY=${0%/*} ;;
  *) SCRIPT_DIRECTORY=. ;;
esac
unset PXPIPE_VERIFIED_SCRIPT_PATH
GENERATION_DIRECTORY="$(CDPATH= cd "$SCRIPT_DIRECTORY" 2>/dev/null && pwd -P)" ||
  fail "could not resolve the generation directory"
GENERATION=${GENERATION_DIRECTORY##*/}

"$NODE" -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const directory = process.argv[1];
  const generation = process.argv[2];
  const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const exact = (value, keys) =>
    plain(value) && Object.keys(value).sort().join("\n") === keys.slice().sort().join("\n");
  const regular = (file) => {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("not regular");
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("changed while opening");
      }
      const bytes = fs.readFileSync(descriptor);
      const afterHandle = fs.fstatSync(descriptor);
      const afterPath = fs.lstatSync(file);
      if (opened.dev !== afterHandle.dev || opened.ino !== afterHandle.ino ||
          opened.size !== afterHandle.size || opened.mtimeMs !== afterHandle.mtimeMs ||
          afterHandle.dev !== afterPath.dev || afterHandle.ino !== afterPath.ino ||
          afterHandle.size !== afterPath.size || afterHandle.mtimeMs !== afterPath.mtimeMs ||
          afterPath.isSymbolicLink() || bytes.length !== afterHandle.size) {
        throw new Error("changed while reading");
      }
      return bytes;
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const component = (value, name) => {
    if (!exact(value, ["name", "sha256"]) || value.name !== name ||
        typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256)) {
      throw new Error("component schema");
    }
    const bytes = regular(path.join(directory, name));
    if (hash(bytes) !== value.sha256) {
      throw new Error("component hash");
    }
    return bytes;
  };
  let installerBytes;
  let expectedBundleHashes;
  try {
    if (!/^[0-9a-f]{64}$/.test(generation)) throw new Error("generation");
    const receiptBytes = regular(path.join(directory, "bundle-receipt-v1.json"));
    if (hash(receiptBytes) !== generation) throw new Error("receipt hash");
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    if (!exact(receipt, ["files", "schemaVersion", "sourceCommit", "version"]) ||
        receipt.schemaVersion !== 1 ||
        typeof receipt.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(receipt.sourceCommit) ||
        typeof receipt.version !== "string" || receipt.version.length === 0 || receipt.version.includes("/") ||
        !exact(receipt.files, ["archive", "bootstrap", "installer", "launcher", "manifest"])) {
      throw new Error("receipt schema");
    }
    const archiveName = `pxpipe-proxy-${receipt.version}-${receipt.sourceCommit}.tgz`;
    component(receipt.files.archive, archiveName);
    component(receipt.files.bootstrap, "install.sh");
    installerBytes = component(receipt.files.installer, ".pxpipe-installer.mjs");
    const manifestBytes = component(receipt.files.manifest, "manifest.json");
    const launcher = receipt.files.launcher;
    if (!exact(launcher, ["name", "sha256"]) || launcher.name !== "root-install.sh" ||
        typeof launcher.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(launcher.sha256) ||
        hash(regular(path.join(directory, launcher.name))) !== launcher.sha256) {
      throw new Error("launcher hash");
    }

    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    if (!exact(manifest, ["archive", "installer", "installerSha256", "sha256", "sourceCommit", "version"]) ||
        manifest.version !== receipt.version || manifest.sourceCommit !== receipt.sourceCommit ||
        manifest.archive !== archiveName || manifest.sha256 !== receipt.files.archive.sha256 ||
        manifest.installer !== ".pxpipe-installer.mjs" ||
        manifest.installerSha256 !== receipt.files.installer.sha256) {
      throw new Error("manifest mismatch");
    }
    expectedBundleHashes = {
      manifestSha256: receipt.files.manifest.sha256,
      archiveSha256: receipt.files.archive.sha256,
      installerSha256: receipt.files.installer.sha256,
    };
  } catch {
    console.error("✗ the selected pxpipe generation failed verification");
    process.exit(1);
  }

  (async () => {
    try {
      const source = `data:text/javascript;base64,${installerBytes.toString("base64")}`;
      const loaded = await import(source);
      if (typeof loaded.runMacosInstallApp !== "function") {
        throw new Error("packaged installer export is missing");
      }
      await loaded.runMacosInstallApp({
        entryFile: path.join(directory, ".pxpipe-installer.mjs"),
        argv: process.argv.slice(3),
        expectedBundleHashes,
      });
    } catch (error) {
      console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  })();
' "$GENERATION_DIRECTORY" "$GENERATION" "$@"
