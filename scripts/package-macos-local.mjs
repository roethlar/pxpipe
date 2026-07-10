#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '0.8.0-provenance-safe.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installerSource = join(root, 'deploy', 'macos-local', 'install.sh');

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
      'usage: pnpm run package:macos-local -- --output <stable-directory>',
    );
  }

  const requested = resolve(normalized[1]);
  assertStableOutput(requested);
  await mkdir(requested, { recursive: true });
  const canonical = await realpath(requested);
  assertStableOutput(canonical);
  return canonical;
}

function safePriorArchive(value) {
  return (
    typeof value === 'string' &&
    basename(value) === value &&
    value.startsWith('pxpipe-proxy-') &&
    value.endsWith('.tgz')
  );
}

async function publishFile(stageDir, outputDir, name, mode) {
  const temporary = join(outputDir, `.${name}.${process.pid}.tmp`);
  try {
    await copyFile(join(stageDir, name), temporary);
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, join(outputDir, name));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  assertClean();
  const outputDir = await requestedOutputDir(process.argv.slice(2));

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

  run('bash', ['-n', installerSource]);
  run('pnpm', ['run', 'typecheck']);
  run('pnpm', ['test']);
  run('pnpm', ['run', 'build']);

  const stageDir = await mkdtemp(
    join(dirname(outputDir), '.pxpipe-macos-local-stage-'),
  );
  const scratchDir = join(stageDir, '.scratch');
  await mkdir(scratchDir);

  try {
    const packDir = join(scratchDir, 'pack');
    const extractDir = join(scratchDir, 'extract');
    await mkdir(packDir);
    await mkdir(extractDir);

    run('pnpm', ['pack', '--pack-destination', packDir]);
    const packedFiles = (await readdir(packDir)).filter((name) => name.endsWith('.tgz'));
    if (packedFiles.length !== 1) {
      throw new Error(`pnpm pack produced ${packedFiles.length} archives; expected exactly one`);
    }

    const archive = `pxpipe-proxy-${EXPECTED_VERSION}-${sourceCommit}.tgz`;
    const stagedArchive = join(stageDir, archive);
    await copyFile(join(packDir, packedFiles[0]), stagedArchive);

    const archiveEntries = new Set(
      run('tar', ['-tzf', stagedArchive], { capture: true })
        .split(/\r?\n/)
        .map((entry) => entry.replace(/^\.\//, ''))
        .filter(Boolean),
    );
    for (const required of [
      'package/bin/cli.js',
      'package/dist/node.js',
      'package/package.json',
    ]) {
      if (!archiveEntries.has(required)) {
        throw new Error(`packed archive is missing ${required}`);
      }
    }

    run('tar', ['-xzf', stagedArchive, '-C', extractDir]);
    const bundledVersion = run(
      process.execPath,
      [join(extractDir, 'package', 'bin', 'cli.js'), '--version'],
      { capture: true },
    );
    if (bundledVersion !== EXPECTED_VERSION) {
      throw new Error(
        `packed CLI reported ${JSON.stringify(bundledVersion)}; expected ` +
          JSON.stringify(EXPECTED_VERSION),
      );
    }

    assertClean();
    const finalCommit = run('git', ['rev-parse', '--verify', 'HEAD'], { capture: true });
    if (finalCommit !== sourceCommit) {
      throw new Error(`source commit changed while packaging: ${sourceCommit} -> ${finalCommit}`);
    }

    const sha256 = createHash('sha256')
      .update(await readFile(stagedArchive))
      .digest('hex');
    const manifest = {
      version: EXPECTED_VERSION,
      sourceCommit,
      archive,
      sha256,
    };
    await writeFile(join(stageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await copyFile(installerSource, join(stageDir, 'install.sh'));
    await chmod(join(stageDir, 'install.sh'), 0o755);

    let priorArchive;
    try {
      const priorManifest = JSON.parse(
        await readFile(join(outputDir, 'manifest.json'), 'utf8'),
      );
      if (safePriorArchive(priorManifest.archive)) {
        priorArchive = priorManifest.archive;
      }
    } catch {
      priorArchive = undefined;
    }

    await publishFile(stageDir, outputDir, archive);
    await publishFile(stageDir, outputDir, 'install.sh', 0o755);
    await publishFile(stageDir, outputDir, 'manifest.json');
    if (priorArchive && priorArchive !== archive) {
      await rm(join(outputDir, priorArchive), { force: true });
    }

    console.log(`✓ local macOS bundle: ${outputDir}`);
    console.log(`✓ archive SHA-256: ${sha256}`);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
