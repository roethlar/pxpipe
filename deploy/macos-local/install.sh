#!/bin/sh
# Stable local entry point. It selects one immutable, fully published bundle
# generation and never reads artifacts from two generations.

set -eu
umask 077

fail() {
  echo "✗ $*" >&2
  exit 1
}

if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != "--uninstall" ]; }; then
  fail "usage: ./install.sh [--uninstall]"
fi

# Prevent ambient Node hooks, loaders, coverage writers, or module paths from
# running before the selected bootstrap has verified its own bytes.
unset NODE_OPTIONS NODE_PATH NODE_V8_COVERAGE NODE_COMPILE_CACHE NODE_COMPILE_CACHE_PORTABLE

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
      *) fail "verified launcher path is unavailable" ;;
    esac
    ;;
  */*) SCRIPT_DIRECTORY=${0%/*} ;;
  *) SCRIPT_DIRECTORY=. ;;
esac
unset PXPIPE_VERIFIED_SCRIPT_PATH
BUNDLE_ROOT="$(CDPATH= cd "$SCRIPT_DIRECTORY" 2>/dev/null && pwd -P)" ||
  fail "could not resolve the bundle directory"

exec "$NODE" -e '
  const crypto = require("node:crypto");
  const childProcess = require("node:child_process");
  const fs = require("node:fs");
  const path = require("node:path");
  const bundleRoot = process.argv[1];
  const userArguments = process.argv.slice(2);
  const generationsRoot = path.join(bundleRoot, ".pxpipe-generations");
  const launcherPath = path.join(bundleRoot, "install.sh");
  const pointerPath = path.join(bundleRoot, ".pxpipe-current");
  const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const exact = (value, keys) =>
    plain(value) && Object.keys(value).sort().join("\n") === keys.slice().sort().join("\n");
  const same = (left, right) =>
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs;
  const regularOnce = (file) => {
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
      if (!same(opened, afterHandle) || !same(afterHandle, afterPath) ||
          bytes.length !== afterHandle.size || afterPath.isSymbolicLink()) {
        throw new Error("changed while reading");
      }
      return bytes;
    } finally {
      fs.closeSync(descriptor);
    }
  };
  const regular = (file) => {
    let last;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return regularOnce(file);
      } catch (error) {
        last = error;
        const retryable = error &&
          (error.code === "ENOENT" || error.code === "ELOOP" ||
           String(error.message).startsWith("changed while"));
        if (!retryable || attempt === 7) throw error;
      }
    }
    throw last;
  };
  const generationRecord = (generation) => {
    if (!/^[0-9a-f]{64}$/.test(generation)) throw new Error("generation");
    const directory = path.join(generationsRoot, generation);
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("generation directory");
    }
    const receiptBytes = regular(path.join(directory, "bundle-receipt-v1.json"));
    if (hash(receiptBytes) !== generation) throw new Error("receipt hash");
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    if (!exact(receipt, ["files", "schemaVersion", "sourceCommit", "version"]) ||
        receipt.schemaVersion !== 1 ||
        typeof receipt.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(receipt.sourceCommit) ||
        typeof receipt.version !== "string" || receipt.version.length === 0 ||
        !exact(receipt.files, ["archive", "bootstrap", "installer", "launcher", "manifest"])) {
      throw new Error("receipt schema");
    }
    const launcher = receipt.files.launcher;
    const bootstrap = receipt.files.bootstrap;
    if (!exact(launcher, ["name", "sha256"]) || launcher.name !== "root-install.sh" ||
        typeof launcher.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(launcher.sha256) ||
        !exact(bootstrap, ["name", "sha256"]) || bootstrap.name !== "install.sh" ||
        typeof bootstrap.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(bootstrap.sha256)) {
      throw new Error("launcher schema");
    }
    const launcherBytes = regular(path.join(directory, launcher.name));
    const bootstrapBytes = regular(path.join(directory, bootstrap.name));
    if (hash(launcherBytes) !== launcher.sha256 || hash(bootstrapBytes) !== bootstrap.sha256) {
      throw new Error("generation component hash");
    }
    return { directory, launcher, launcherBytes, bootstrapBytes };
  };
  const generationNames = () => fs.readdirSync(generationsRoot, { withFileTypes: true })
    .filter((entry) => /^[0-9a-f]{64}$/.test(entry.name))
    .map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("generation entry");
      return entry.name;
    })
    .sort();
  const recognizedLauncher = (launcherSha256, launcherBytes) => {
    for (const generation of generationNames()) {
      const record = generationRecord(generation);
      if (record.launcher.sha256 === launcherSha256 && record.launcherBytes.equals(launcherBytes)) {
        return true;
      }
    }
    return false;
  };
  const syncDirectory = (directory) => {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  };
  const replaceLauncher = (bytes) => {
    const temporary = path.join(
      bundleRoot,
      `.install.sh.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
    );
    let descriptor;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o700,
      );
      fs.writeFileSync(descriptor, bytes);
      fs.fchmodSync(descriptor, 0o755);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, launcherPath);
      syncDirectory(bundleRoot);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  };
  const runVerifiedShell = (bytes, scriptPath) => {
    const result = childProcess.spawnSync(
      "/bin/sh",
      ["-s", "--", ...userArguments],
      {
        input: bytes,
        env: { ...process.env, PXPIPE_VERIFIED_SCRIPT_PATH: scriptPath },
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    if (result.error) throw result.error;
    if (result.signal) {
      process.kill(process.pid, result.signal);
      process.exit(1);
    }
    process.exit(result.status ?? 1);
  };
  try {
    const currentLauncher = regular(launcherPath);
    const currentLauncherSha256 = hash(currentLauncher);
    let generation;
    try {
      const pointer = regular(pointerPath).toString("utf8");
      if (!/^[0-9a-f]{64}\n$/.test(pointer)) throw new Error("pointer");
      generation = pointer.trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const candidates = generationNames().filter((candidate) => {
        const record = generationRecord(candidate);
        return record.launcher.sha256 === currentLauncherSha256 &&
          record.launcherBytes.equals(currentLauncher);
      });
      if (candidates.length === 0) throw new Error("launcher without pointer");
      generation = candidates[candidates.length - 1];
    }
    const selected = generationRecord(generation);
    if (currentLauncherSha256 !== selected.launcher.sha256 ||
        !currentLauncher.equals(selected.launcherBytes)) {
      if (!recognizedLauncher(currentLauncherSha256, currentLauncher)) {
        throw new Error("unrecognized launcher revision");
      }
      replaceLauncher(selected.launcherBytes);
      runVerifiedShell(selected.launcherBytes, launcherPath);
    }
    runVerifiedShell(
      selected.bootstrapBytes,
      path.join(selected.directory, "install.sh"),
    );
  } catch {
    console.error("✗ the selected pxpipe generation failed verification");
    process.exit(1);
  }
' "$BUNDLE_ROOT" "$@"
