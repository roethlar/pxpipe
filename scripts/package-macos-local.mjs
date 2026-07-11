#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '0.8.0-provenance-safe.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootLauncherSource = join(root, 'deploy', 'macos-local', 'install.sh');
const generationBootstrapSource = join(
  root,
  'deploy',
  'macos-local',
  'generation-install.sh',
);
const GENERATIONS_DIRECTORY = '.pxpipe-generations';
const GENERATION_POINTER = '.pxpipe-current';
const RECEIPT_NAME = 'bundle-receipt-v1.json';
const INSTALLER_NAME = '.pxpipe-installer.mjs';
const ROOT_LAUNCHER_NAME = 'root-install.sh';
const PUBLISH_LOCK = '.pxpipe-publish.lock';

function run(command, args, options = {}) {
  const capture = options.capture ?? false;
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr ?? '').trim() : '';
    throw new Error(
      `${command} ${args.join(' ')} failed with exit ${result.status}` +
        (detail ? `: ${detail}` : ''),
    );
  }

  return capture ? (result.stdout ?? '').trim() : '';
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) &&
    Object.keys(value).sort().join('\n') === keys.slice().sort().join('\n');
}

function assertClean() {
  const dirty = run(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none'],
    { capture: true },
  );
  if (dirty) {
    throw new Error(`refusing to package a dirty source tree:\n${dirty}`);
  }
}

function isWithin(parent, candidate) {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function safeArchiveEntry(entry) {
  const normalized = entry.replace(/^\.\//, '').replace(/\/$/, '');
  if (
    (normalized !== 'package' && !normalized.startsWith('package/')) ||
    normalized.includes('\\') ||
    normalized.includes('\0')
  ) {
    return false;
  }
  return !normalized.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function assertStableOutput(outputDir) {
  const privateRoot = resolve('/private');
  if (isWithin(privateRoot, outputDir)) {
    throw new Error(`refusing to write local bundle under /private: ${outputDir}`);
  }
  if (isWithin(root, outputDir)) {
    throw new Error(`refusing to write local bundle inside the source worktree: ${outputDir}`);
  }
}

async function requestedOutputDir(args) {
  const normalized = args[0] === '--' ? args.slice(1) : args;
  if (
    normalized.length !== 2 ||
    normalized[0] !== '--output' ||
    !normalized[1]?.trim()
  ) {
    throw new Error(
      'usage: pnpm run package:macos-local -- --output "$HOME/Dev/pxpipe-deploy"',
    );
  }

  const home = process.env.HOME;
  if (!home || !isAbsolute(home)) throw new Error('HOME must be an absolute directory');
  const canonicalHome = await realpath(home);
  const expected = join(canonicalHome, 'Dev', 'pxpipe-deploy');
  const requested = resolve(normalized[1]);
  if (requested !== expected) {
    throw new Error(`local bundle output must be exactly ${expected}`);
  }
  assertStableOutput(requested);
  await mkdir(requested, { recursive: true, mode: 0o755 });
  const canonical = await realpath(requested);
  if (canonical !== expected) {
    throw new Error(`local bundle output must not be a symlink: ${requested}`);
  }
  assertStableOutput(canonical);
  return canonical;
}

async function syncPath(target) {
  const handle = await open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeSynced(target, bytes, mode) {
  await writeFile(target, bytes, { mode });
  await chmod(target, mode);
  await syncPath(target);
}

async function copySynced(source, target, mode) {
  await copyFile(source, target);
  await chmod(target, mode);
  await syncPath(target);
}

async function publishBytes(bytes, target, mode) {
  const directory = dirname(target);
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    await writeSynced(temporary, bytes, mode);
    await rename(temporary, target);
    await syncPath(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function regularBytes(target, label) {
  const before = await lstat(target);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file`);
  }
  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed while being opened`);
    }
    const bytes = await handle.readFile();
    const afterHandle = await handle.stat();
    const afterPath = await lstat(target);
    if (
      !afterPath.isFile() || afterPath.isSymbolicLink() ||
      opened.dev !== afterHandle.dev || opened.ino !== afterHandle.ino ||
      opened.size !== afterHandle.size || opened.mtimeMs !== afterHandle.mtimeMs ||
      afterHandle.dev !== afterPath.dev || afterHandle.ino !== afterPath.ino ||
      afterHandle.size !== afterPath.size || afterHandle.mtimeMs !== afterPath.mtimeMs ||
      bytes.byteLength !== afterHandle.size
    ) throw new Error(`${label} changed while being read`);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function ensureGenerationsRoot(outputDir) {
  const generationsRoot = join(outputDir, GENERATIONS_DIRECTORY);
  let created = false;
  try {
    await mkdir(generationsRoot, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stat = await lstat(generationsRoot);
  const uid = process.getuid?.();
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    uid === undefined ||
    stat.uid !== uid ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      `${GENERATIONS_DIRECTORY} must be a current-user-owned, non-symlink 0700 directory`,
    );
  }
  if (created) await syncPath(outputDir);
  return generationsRoot;
}

function processStartSignature(pid) {
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
  });
  if (result.error || result.status !== 0) return undefined;
  const signature = (result.stdout ?? '').trim();
  return signature || undefined;
}

function parsePublishLock(bytes) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return undefined;
  }
  if (
    !exactKeys(value, ['nonce', 'pid', 'startSignature', 'uid']) ||
    !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    !Number.isSafeInteger(value.uid) || value.uid < 0 ||
    typeof value.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(value.nonce) ||
    typeof value.startSignature !== 'string' || value.startSignature.length === 0
  ) {
    return undefined;
  }
  return value;
}

function publishLockOwnerIsLive(record) {
  if (record.uid !== process.getuid?.()) return false;
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  return processStartSignature(record.pid) === record.startSignature;
}

async function acquirePublishLock(outputDir) {
  const uid = process.getuid?.();
  const startSignature = processStartSignature(process.pid);
  if (uid === undefined || startSignature === undefined) {
    throw new Error('could not establish the package publisher process identity');
  }
  const nonce = randomBytes(16).toString('hex');
  const record = { uid, pid: process.pid, startSignature, nonce };
  const recordBytes = Buffer.from(`${JSON.stringify(record)}\n`);
  const candidate = join(outputDir, `.${PUBLISH_LOCK}.${process.pid}.${nonce}.candidate`);
  const lockPath = join(outputDir, PUBLISH_LOCK);
  await writeSynced(candidate, recordBytes, 0o600);
  const deadline = Date.now() + 30_000;

  try {
    while (true) {
      try {
        await link(candidate, lockPath);
        await syncPath(outputDir);
        await rm(candidate, { force: true });
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }

      let existing;
      try {
        existing = parsePublishLock(await regularBytes(lockPath, 'package publisher lock'));
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        existing = undefined;
      }
      if (existing !== undefined && publishLockOwnerIsLive(existing)) {
        if (Date.now() >= deadline) {
          throw new Error('another package publisher still owns the output lock');
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        continue;
      }

      const quarantine = join(
        outputDir,
        `.${PUBLISH_LOCK}.stale.${process.pid}.${randomBytes(8).toString('hex')}`,
      );
      try {
        await rename(lockPath, quarantine);
        await syncPath(outputDir);
        await rm(quarantine, { recursive: true, force: true });
        await syncPath(outputDir);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    await rm(candidate, { force: true });
    throw error;
  }

  return async () => {
    const current = await regularBytes(lockPath, 'package publisher lock');
    if (!current.equals(recordBytes)) {
      throw new Error('package publisher lock ownership changed before release');
    }
    await rm(lockPath);
    await syncPath(outputDir);
  };
}

async function existingGenerationMatches(directory, receiptBytes, receipt) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    const existingReceipt = await regularBytes(join(directory, RECEIPT_NAME), 'generation receipt');
    if (!existingReceipt.equals(receiptBytes)) return false;
    for (const component of Object.values(receipt.files)) {
      const bytes = await regularBytes(join(directory, component.name), component.name);
      if (sha256(bytes) !== component.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function validatedStoredLauncher(outputDir, generationId) {
  if (!/^[0-9a-f]{64}$/.test(generationId)) {
    throw new Error('the generation ID is malformed');
  }
  const generationDirectory = join(outputDir, GENERATIONS_DIRECTORY, generationId);
  const generationStat = await lstat(generationDirectory);
  if (!generationStat.isDirectory() || generationStat.isSymbolicLink()) {
    throw new Error('the existing selected generation is not a regular directory');
  }
  const receiptBytes = await regularBytes(
    join(generationDirectory, RECEIPT_NAME),
    'published generation receipt',
  );
  if (sha256(receiptBytes) !== generationId) {
    throw new Error('the existing generation receipt does not match its pointer');
  }
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new Error('the existing generation receipt is malformed');
  }
  const expectedLauncher = receipt?.files?.launcher;
  if (
    exactKeys(receipt, ['files', 'schemaVersion', 'sourceCommit', 'version']) &&
    receipt.schemaVersion === 1 &&
    exactKeys(receipt.files, ['archive', 'bootstrap', 'installer', 'launcher', 'manifest']) &&
    exactKeys(expectedLauncher, ['name', 'sha256']) &&
    expectedLauncher?.name === ROOT_LAUNCHER_NAME &&
    typeof expectedLauncher?.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(expectedLauncher.sha256)
  ) {
    const storedLauncher = await regularBytes(
      join(generationDirectory, ROOT_LAUNCHER_NAME),
      'stored root launcher',
    );
    if (sha256(storedLauncher) !== expectedLauncher.sha256) {
      throw new Error('the existing generation root launcher is damaged');
    }
    return { bytes: storedLauncher, sha256: expectedLauncher.sha256 };
  }
  throw new Error('the existing generation receipt has an invalid launcher component');
}

async function publishedLauncherIsKnown(outputDir, launcherBytes) {
  const generationsRoot = join(outputDir, GENERATIONS_DIRECTORY);
  const entries = await readdir(generationsRoot, { withFileTypes: true });
  const launcherSha256 = sha256(launcherBytes);
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('a published generation is not a regular directory');
    }
    const stored = await validatedStoredLauncher(outputDir, entry.name);
    if (stored.sha256 === launcherSha256 && stored.bytes.equals(launcherBytes)) return true;
  }
  return false;
}

async function recoverPublishedLauncher(outputDir) {
  const pointer = join(outputDir, GENERATION_POINTER);
  let pointerBytes;
  try {
    pointerBytes = await regularBytes(pointer, 'existing generation pointer');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const publishedLauncher = join(outputDir, 'install.sh');
    let current;
    try {
      current = await regularBytes(publishedLauncher, 'published install.sh');
    } catch (launcherError) {
      if (launcherError?.code === 'ENOENT') return false;
      throw launcherError;
    }
    if (!await publishedLauncherIsKnown(outputDir, current)) {
      throw new Error('published install.sh without a pointer is not a known launcher revision');
    }
    return false;
  }

  const generation = pointerBytes.toString('utf8');
  if (!/^[0-9a-f]{64}\n$/.test(generation)) {
    throw new Error('the existing generation pointer is malformed');
  }
  const generationId = generation.trim();
  const storedLauncher = await validatedStoredLauncher(outputDir, generationId);
  const publishedLauncher = join(outputDir, 'install.sh');
  try {
    const current = await regularBytes(publishedLauncher, 'published install.sh');
    if (current.equals(storedLauncher.bytes)) return true;
    if (!await publishedLauncherIsKnown(outputDir, current)) {
      throw new Error('published install.sh is not a known launcher revision');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await publishBytes(storedLauncher.bytes, publishedLauncher, 0o755);
  return true;
}

async function main() {
  assertClean();
  const outputDir = await requestedOutputDir(process.argv.slice(2));
  const generationsRoot = await ensureGenerationsRoot(outputDir);

  const sourceCommit = run('git', ['rev-parse', '--verify', 'HEAD'], { capture: true });
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new Error(`git returned an invalid source commit: ${JSON.stringify(sourceCommit)}`);
  }

  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `package version is ${JSON.stringify(packageJson.version)}; expected ` +
        JSON.stringify(EXPECTED_VERSION),
    );
  }

  run('sh', ['-n', rootLauncherSource]);
  run('sh', ['-n', generationBootstrapSource]);
  // Freeze the reviewed launcher once. Its receipt and published bytes must
  // always derive from this same in-memory snapshot.
  const launcherBytes = await regularBytes(rootLauncherSource, 'root installer launcher');
  run('pnpm', ['run', 'typecheck']);
  run('pnpm', ['test']);
  run('pnpm', ['run', 'build']);

  const workspace = await mkdtemp(join(generationsRoot, '.stage-'));
  const generationStage = join(workspace, 'generation');
  const scratchDir = join(workspace, 'scratch');
  await mkdir(generationStage, { mode: 0o700 });
  await mkdir(scratchDir, { mode: 0o700 });

  try {
    const packDir = join(scratchDir, 'pack');
    const extractDir = join(scratchDir, 'extract');
    await mkdir(packDir, { mode: 0o700 });
    await mkdir(extractDir, { mode: 0o700 });

    run('pnpm', ['pack', '--pack-destination', packDir]);
    const packedFiles = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'));
    if (packedFiles.length !== 1) {
      throw new Error(`pnpm pack produced ${packedFiles.length} archives; expected exactly one`);
    }

    const archive = `pxpipe-proxy-${EXPECTED_VERSION}-${sourceCommit}.tgz`;
    const stagedArchive = join(generationStage, archive);
    await copySynced(join(packDir, packedFiles[0]), stagedArchive, 0o600);

    const listedEntries = run('tar', ['-tzf', stagedArchive], { capture: true })
      .split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ''))
      .filter(Boolean);
    if (
      listedEntries.length === 0 ||
      listedEntries.some((entry) => !safeArchiveEntry(entry)) ||
      new Set(listedEntries).size !== listedEntries.length
    ) {
      throw new Error('packed archive contains an unsafe or duplicate path');
    }
    const verboseEntries = run('tar', ['-tvzf', stagedArchive], { capture: true })
      .split(/\r?\n/)
      .filter(Boolean);
    if (
      verboseEntries.length !== listedEntries.length ||
      verboseEntries.some((entry) => entry[0] !== '-' && entry[0] !== 'd')
    ) {
      throw new Error('packed archive contains a link or unsupported entry type');
    }
    const archiveEntries = new Set(listedEntries);
    for (const required of [
      'package/bin/cli.js',
      'package/dist/macos-local-installer.js',
      'package/dist/node.js',
      'package/package.json',
    ]) {
      if (!archiveEntries.has(required)) {
        throw new Error(`packed archive is missing ${required}`);
      }
    }

    run('tar', ['-xzf', stagedArchive, '-C', extractDir]);
    const extractedPackage = join(extractDir, 'package');
    const bundledVersion = run(
      process.execPath,
      [join(extractedPackage, 'bin', 'cli.js'), '--version'],
      { capture: true },
    );
    if (bundledVersion !== EXPECTED_VERSION) {
      throw new Error(
        `packed CLI reported ${JSON.stringify(bundledVersion)}; expected ` +
          JSON.stringify(EXPECTED_VERSION),
      );
    }

    // The executable sidecar comes from the immutable archive bytes, never from
    // the mutable ignored dist/ tree after packing.
    const extractedInstaller = join(extractedPackage, 'dist', 'macos-local-installer.js');
    await regularBytes(extractedInstaller, 'packed installer program');
    const stagedInstaller = join(generationStage, INSTALLER_NAME);
    await copySynced(extractedInstaller, stagedInstaller, 0o600);
    const stagedBootstrap = join(generationStage, 'install.sh');
    await copySynced(generationBootstrapSource, stagedBootstrap, 0o700);
    const stagedRootLauncher = join(generationStage, ROOT_LAUNCHER_NAME);
    await writeSynced(stagedRootLauncher, launcherBytes, 0o700);

    assertClean();
    const finalCommit = run('git', ['rev-parse', '--verify', 'HEAD'], { capture: true });
    if (finalCommit !== sourceCommit) {
      throw new Error(`source commit changed while packaging: ${sourceCommit} -> ${finalCommit}`);
    }

    const archiveSha256 = sha256(await readFile(stagedArchive));
    const installerSha256 = sha256(await readFile(stagedInstaller));
    const manifest = {
      version: EXPECTED_VERSION,
      sourceCommit,
      archive,
      sha256: archiveSha256,
      installer: INSTALLER_NAME,
      installerSha256,
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const stagedManifest = join(generationStage, 'manifest.json');
    await writeSynced(stagedManifest, manifestBytes, 0o600);

    const bootstrapBytes = await readFile(stagedBootstrap);
    const receipt = {
      schemaVersion: 1,
      version: EXPECTED_VERSION,
      sourceCommit,
      files: {
        archive: { name: archive, sha256: archiveSha256 },
        bootstrap: { name: 'install.sh', sha256: sha256(bootstrapBytes) },
        installer: { name: INSTALLER_NAME, sha256: installerSha256 },
        launcher: { name: ROOT_LAUNCHER_NAME, sha256: sha256(launcherBytes) },
        manifest: { name: 'manifest.json', sha256: sha256(manifestBytes) },
      },
    };
    const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
    const generation = sha256(receiptBytes);
    await writeSynced(join(generationStage, RECEIPT_NAME), receiptBytes, 0o600);
    await syncPath(generationStage);

    const finalGeneration = join(generationsRoot, generation);
    try {
      await rename(generationStage, finalGeneration);
      await syncPath(generationsRoot);
    } catch (error) {
      if (
        !['EEXIST', 'ENOTEMPTY'].includes(error?.code) ||
        !await existingGenerationMatches(finalGeneration, receiptBytes, receipt)
      ) {
        throw error;
      }
    }

    const releasePublishLock = await acquirePublishLock(outputDir);
    try {
      const hadPublishedPointer = await recoverPublishedLauncher(outputDir);
      const pointerBytes = Buffer.from(`${generation}\n`);
      if (hadPublishedPointer) {
        // Existing launchers can repair/restart across this two-rename window.
        await publishBytes(pointerBytes, join(outputDir, GENERATION_POINTER), 0o600);
        await publishBytes(launcherBytes, join(outputDir, 'install.sh'), 0o755);
      } else {
        // On first publication the launcher can select this already-complete
        // generation without a pointer, so install.sh becomes usable first.
        await publishBytes(launcherBytes, join(outputDir, 'install.sh'), 0o755);
        await publishBytes(pointerBytes, join(outputDir, GENERATION_POINTER), 0o600);
      }
    } finally {
      await releasePublishLock();
    }

    const bundleSha256 = sha256(
      Buffer.from(`pxpipe-bundle-v1\n${receipt.files.launcher.sha256}\n${generation}\n`),
    );
    console.log(`✓ local macOS bundle: ${outputDir}`);
    console.log(`✓ source commit: ${sourceCommit}`);
    console.log(`✓ archive SHA-256: ${archiveSha256}`);
    console.log(`✓ generation receipt SHA-256: ${generation}`);
    console.log(`✓ complete bundle SHA-256: ${bundleSha256}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await syncPath(generationsRoot);
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
