#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_VERSION = '0.8.0-provenance-safe.1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(root, 'build');
const outputDir = join(buildRoot, 'macos-local');
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

async function main() {
  assertClean();

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

  await mkdir(buildRoot, { recursive: true });
  const stageDir = await mkdtemp(join(buildRoot, '.macos-local-stage-'));
  const scratchDir = await mkdtemp(join(tmpdir(), 'pxpipe-macos-local-'));

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

    await rm(outputDir, { recursive: true, force: true });
    await rename(stageDir, outputDir);

    console.log(`✓ local macOS bundle: ${outputDir}`);
    console.log(`✓ archive SHA-256: ${sha256}`);
  } finally {
    await rm(stageDir, { recursive: true, force: true });
    await rm(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
