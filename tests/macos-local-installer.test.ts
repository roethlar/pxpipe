import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '..');
const INSTALLER_SOURCE = path.join(REPO, 'deploy', 'macos-local', 'install.sh');
const PACKAGER_SOURCE = path.join(REPO, 'scripts', 'package-macos-local.mjs');
const VERSION = '0.8.0-provenance-safe.1';
const DOLLAR = String.fromCharCode(36);
const roots: string[] = [];

interface Harness {
  root: string;
  home: string;
  calls: string;
  env: NodeJS.ProcessEnv;
}

interface Bundle {
  dir: string;
  installer: string;
  manifest: string;
  commit: string;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function makeHarness(): Harness {
  const root = tempRoot('pxpipe-macos-install-');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'launchctl.log');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  writeExecutable(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n');
  writeExecutable(
    path.join(bin, 'launchctl'),
    '#!/bin/sh\nprintf "%s\\n" "' + DOLLAR + '*" >> "' + DOLLAR + 'CALL_LOG"\nexit 0\n',
  );
  writeExecutable(
    path.join(bin, 'curl'),
    '#!/bin/sh\nif [ "' + DOLLAR + '{CURL_MODE:-success}" = "fail" ]; then exit 22; fi\nexit 0\n',
  );
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeExecutable(
    path.join(bin, 'lsof'),
    '#!/bin/sh\nif [ "${LSOF_MODE:-free}" = "held" ]; then echo 99999; fi\nexit 0\n',
  );

  return {
    root,
    home,
    calls,
    env: {
      ...process.env,
      HOME: home,
      PATH: [
        bin,
        path.dirname(process.execPath),
        process.env.PATH ?? '/usr/bin:/bin',
      ].join(path.delimiter),
      CALL_LOG: calls,
      CURL_MODE: 'success',
    },
  };
}

function makeBundle(
  root: string,
  options: {
    commit?: string;
    packageVersion?: string;
    manifestVersion?: string;
    missingDist?: boolean;
  } = {},
): Bundle {
  const commit = options.commit ?? 'a'.repeat(40);
  const packageVersion = options.packageVersion ?? VERSION;
  const manifestVersion = options.manifestVersion ?? VERSION;
  const suffix = commit.slice(0, 8);
  const dir = path.join(root, 'bundle-' + suffix);
  const source = path.join(root, 'source-' + suffix);
  const packageDir = path.join(source, 'package');
  fs.mkdirSync(path.join(packageDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const installer = path.join(dir, 'install.sh');
  fs.copyFileSync(INSTALLER_SOURCE, installer);
  fs.chmodSync(installer, 0o755);
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'pxpipe-proxy', version: packageVersion, type: 'module' }) + '\n',
  );
  fs.writeFileSync(
    path.join(packageDir, 'bin', 'cli.js'),
    'if (process.argv.includes("--version")) console.log(' +
      JSON.stringify(packageVersion) +
      ');\n',
  );
  if (!options.missingDist) {
    fs.writeFileSync(path.join(packageDir, 'dist', 'node.js'), 'export {};\n');
  }

  const archiveName =
    'pxpipe-proxy-' + manifestVersion + '-' + commit + '.tgz';
  const archive = path.join(dir, archiveName);
  execFileSync('tar', ['-czf', archive, '-C', source, 'package']);
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        version: manifestVersion,
        sourceCommit: commit,
        archive: archiveName,
        sha256,
      },
      null,
      2,
    ) + '\n',
  );

  return { dir, installer, manifest, commit };
}

function runInstaller(
  bundle: Bundle,
  harness: Harness,
  args: string[] = [],
  env: NodeJS.ProcessEnv = harness.env,
) {
  return spawnSync('bash', [bundle.installer, ...args], {
    cwd: bundle.dir,
    env,
    encoding: 'utf8',
  });
}

function readManifest(bundle: Bundle): Record<string, string> {
  return JSON.parse(fs.readFileSync(bundle.manifest, 'utf8')) as Record<string, string>;
}

function writeManifest(bundle: Bundle, value: Record<string, string>): void {
  fs.writeFileSync(bundle.manifest, JSON.stringify(value, null, 2) + '\n');
}

function plistPath(harness: Harness): string {
  return path.join(harness.home, 'Library', 'LaunchAgents', 'com.pxpipe.proxy.plist');
}

function installRoot(harness: Harness): string {
  return path.join(harness.home, 'Library', 'Application Support', 'pxpipe');
}

function expectNoServiceChange(harness: Harness): void {
  expect(fs.existsSync(plistPath(harness))).toBe(false);
  const calls = fs.existsSync(harness.calls) ? fs.readFileSync(harness.calls, 'utf8') : '';
  expect(calls).not.toContain('bootstrap');
}

describe.skipIf(process.platform === 'win32')('local macOS package installer', () => {
  it('installs a loopback-only service and passes its health check', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      PXPIPE_PORT: '47991',
    });

    expect(result.status, result.stderr).toBe(0);
    const plist = fs.readFileSync(plistPath(harness), 'utf8');
    expect(plist).toContain('<key>HOST</key><string>127.0.0.1</string>');
    expect(plist).toContain('<key>PORT</key><string>47991</string>');
    expect(plist).not.toContain('0.0.0.0');
    expect(fs.readlinkSync(path.join(installRoot(harness), 'current'))).toBe(
      path.join(installRoot(harness), 'releases', bundle.commit),
    );
    expect(fs.readFileSync(harness.calls, 'utf8')).toContain('bootstrap');
    expect(result.stdout).toContain(
      'ANTHROPIC_BASE_URL=http://127.0.0.1:47991 claude',
    );
  });

  it('rejects invalid ports before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      PXPIPE_PORT: '0',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PXPIPE_PORT');
    expectNoServiceChange(harness);
  });

  it('refuses to replace a service while its port remains occupied', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      LSOF_MODE: 'held',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('port 47821 is still in use');
    expectNoServiceChange(harness);
    expect(fs.existsSync(path.join(installRoot(harness), 'releases', bundle.commit))).toBe(
      false,
    );
  });

  it('rejects malformed manifests before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    fs.writeFileSync(bundle.manifest, '{');

    const result = runInstaller(bundle, harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('manifest.json is malformed');
    expectNoServiceChange(harness);
  });

  it('rejects wrong archive names and checksums before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    const wrongName = readManifest(bundle);
    wrongName.archive = 'wrong.tgz';
    writeManifest(bundle, wrongName);
    const named = runInstaller(bundle, harness);
    expect(named.status).not.toBe(0);
    expect(named.stderr).toContain('archive name');
    expectNoServiceChange(harness);

    const valid = makeBundle(harness.root, { commit: 'b'.repeat(40) });
    const wrongDigest = readManifest(valid);
    wrongDigest.sha256 = '0'.repeat(64);
    writeManifest(valid, wrongDigest);
    const digested = runInstaller(valid, harness);
    expect(digested.status).not.toBe(0);
    expect(digested.stderr).toContain('checksum');
    expectNoServiceChange(harness);
  });

  it('rejects incomplete archives and package-version mismatches before launch', () => {
    const harness = makeHarness();
    const incomplete = makeBundle(harness.root, {
      commit: 'c'.repeat(40),
      missingDist: true,
    });
    const missing = runInstaller(incomplete, harness);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('dist/node.js');
    expectNoServiceChange(harness);

    const mismatch = makeBundle(harness.root, {
      commit: 'd'.repeat(40),
      manifestVersion: '0.8.0-provenance-safe.2',
    });
    const versioned = runInstaller(mismatch, harness);
    expect(versioned.status).not.toBe(0);
    expect(versioned.stderr).toContain('version does not match');
    expectNoServiceChange(harness);
  });

  it('updates to a healthy release and keeps the previous release', () => {
    const harness = makeHarness();
    const first = makeBundle(harness.root, { commit: 'e'.repeat(40) });
    const second = makeBundle(harness.root, { commit: 'f'.repeat(40) });

    expect(runInstaller(first, harness).status).toBe(0);
    const updated = runInstaller(second, harness);
    expect(updated.status, updated.stderr).toBe(0);
    expect(fs.readlinkSync(path.join(installRoot(harness), 'current'))).toBe(
      path.join(installRoot(harness), 'releases', second.commit),
    );
    expect(
      fs.existsSync(path.join(installRoot(harness), 'releases', first.commit)),
    ).toBe(true);
  });

  it('restores the previous release when an update fails its health check', () => {
    const harness = makeHarness();
    const first = makeBundle(harness.root, { commit: '1'.repeat(40) });
    const second = makeBundle(harness.root, { commit: '2'.repeat(40) });
    expect(runInstaller(first, harness).status).toBe(0);

    const failed = runInstaller(second, harness, [], {
      ...harness.env,
      CURL_MODE: 'fail',
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('restoring the previous release');
    expect(fs.readlinkSync(path.join(installRoot(harness), 'current'))).toBe(
      path.join(installRoot(harness), 'releases', first.commit),
    );
    expect(
      fs.existsSync(path.join(installRoot(harness), 'releases', second.commit)),
    ).toBe(false);
  });

  it('uninstalls the service but preserves logs and events', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    expect(runInstaller(bundle, harness).status).toBe(0);
    const events = path.join(harness.home, '.pxpipe', 'events.jsonl');
    const log = path.join(harness.home, 'Library', 'Logs', 'pxpipe', 'pxpipe.out.log');
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.writeFileSync(events, '{}\n');
    fs.writeFileSync(log, 'kept\n');

    const removed = runInstaller(bundle, harness, ['--uninstall']);
    expect(removed.status, removed.stderr).toBe(0);
    expect(fs.existsSync(installRoot(harness))).toBe(false);
    expect(fs.existsSync(plistPath(harness))).toBe(false);
    expect(fs.readFileSync(events, 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(log, 'utf8')).toBe('kept\n');
  });

  it('refuses dirty source and unstable package destinations', () => {
    const root = tempRoot('pxpipe-macos-pack-');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'deploy', 'macos-local'), { recursive: true });
    fs.copyFileSync(PACKAGER_SOURCE, path.join(root, 'scripts', 'package-macos-local.mjs'));
    fs.copyFileSync(INSTALLER_SOURCE, path.join(root, 'deploy', 'macos-local', 'install.sh'));
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'pxpipe-proxy', version: VERSION }) + '\n',
    );
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
      { cwd: root },
    );
    fs.writeFileSync(path.join(root, 'dirty.txt'), 'not committed\n');

    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts', 'package-macos-local.mjs')],
      { cwd: root, encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing to package a dirty source tree');
    expect(fs.existsSync(path.join(root, 'build'))).toBe(false);

    fs.rmSync(path.join(root, 'dirty.txt'));
    const packager = path.join(root, 'scripts', 'package-macos-local.mjs');
    const missingOutput = spawnSync(process.execPath, [packager], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(missingOutput.status).not.toBe(0);
    expect(missingOutput.stderr).toContain('--output <stable-directory>');

    const privateOutput = path.join(
      '/private/tmp',
      'pxpipe-forbidden-bundle-' + path.basename(root),
    );
    const privateResult = spawnSync(
      process.execPath,
      [packager, '--output', privateOutput],
      { cwd: root, encoding: 'utf8' },
    );
    expect(privateResult.status).not.toBe(0);
    expect(privateResult.stderr).toContain('refusing to write local bundle under /private');
    expect(fs.existsSync(privateOutput)).toBe(false);
  });
});
