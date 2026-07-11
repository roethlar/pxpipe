import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';

const REPO = path.resolve(import.meta.dirname, '..');
const INSTALLER_SOURCE = path.join(REPO, 'deploy', 'macos-local', 'install.sh');
const GENERATION_INSTALLER_SOURCE = path.join(
  REPO,
  'deploy',
  'macos-local',
  'generation-install.sh',
);
const PACKAGER_SOURCE = path.join(REPO, 'scripts', 'package-macos-local.mjs');
const INSTALLER_ENTRY = path.join(REPO, 'src', 'macos-local-install-app.ts');
const VERSION = '0.8.0-provenance-safe.1';
const INSTALLED_MODELS = 'claude-fable-5,gpt-5.6-sol,grok-4.5';
const DOLLAR = String.fromCharCode(36);
const roots: string[] = [];
let bundledInstaller: Buffer | undefined;

interface Harness {
  root: string;
  home: string;
  calls: string;
  serviceState: string;
  env: NodeJS.ProcessEnv;
}

interface Bundle {
  dir: string;
  installer: string;
  helper: string;
  manifest: string;
  receipt: string;
  generation: string;
  commit: string;
}

interface PackagerFixture {
  repo: string;
  packager: string;
  packSource: string;
  output: string;
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

function stableTempRoot(prefix: string): string {
  const parent = process.platform === 'darwin' ? '/Users/Shared' : os.tmpdir();
  const root = fs.mkdtempSync(path.join(parent, prefix));
  roots.push(root);
  return root;
}

function writeExecutable(file: string, body: string): void {
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
}

function installerProgram(): Buffer {
  if (bundledInstaller) return bundledInstaller;
  const result = buildSync({
    entryPoints: [INSTALLER_ENTRY],
    outfile: 'macos-local-installer.js',
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'esm',
    write: false,
  });
  const output = result.outputFiles?.[0];
  if (!output) throw new Error('esbuild did not emit the installer fixture');
  bundledInstaller = Buffer.from(output.contents);
  return bundledInstaller;
}

function fileSha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeHarness(root = tempRoot('pxpipe-macos-install-')): Harness {
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const calls = path.join(root, 'launchctl.log');
  const serviceState = path.join(root, 'service.loaded');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  writeExecutable(path.join(bin, 'uname'), '#!/bin/sh\necho Darwin\n');
  writeExecutable(
    path.join(bin, 'launchctl'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "' + DOLLAR + '*" >> "' + DOLLAR + 'CALL_LOG"',
      'case "' + DOLLAR + '1" in',
      '  print)',
      '    if [ -f "' + DOLLAR + 'SERVICE_STATE" ]; then',
      '      port=${PXPIPE_PORT:-47821}',
      '      cat <<EOF',
      'gui/${TEST_UID}/com.pxpipe.proxy = {',
      '\tactive count = 1',
      '\tpath = ${HOME}/Library/LaunchAgents/com.pxpipe.proxy.plist',
      '\ttype = LaunchAgent',
      '\tstate = running',
      '',
      '\tprogram = ' + process.execPath,
      '\targuments = {',
      '\t\t' + process.execPath,
      '\t\t${HOME}/Library/Application Support/pxpipe/current/bin/cli.js',
      '\t}',
      '',
      '\tstdout path = ${HOME}/Library/Logs/pxpipe/pxpipe.out.log',
      '\tstderr path = ${HOME}/Library/Logs/pxpipe/pxpipe.err.log',
      '\tenvironment = {',
      '\t\tHOST => 127.0.0.1',
      '\t\tPORT => ${port}',
      '\t\tPXPIPE_MODELS => claude-fable-5,gpt-5.6-sol,grok-4.5',
      '\t\tPXPIPE_CODEX_UPSTREAM => https://chatgpt.com/backend-api/codex',
      '\t\tPXPIPE_GROK_UPSTREAM => https://cli-chat-proxy.grok.com',
      '\t\tXPC_SERVICE_NAME => com.pxpipe.proxy',
      '\t}',
      '',
      '\tpid = 4242',
      '}',
      'EOF',
      '      exit 0',
      '    fi',
      '    printf "Bad request.\\nCould not find service \\"com.pxpipe.proxy\\" in domain for user gui: %s\\n" "' + DOLLAR + 'TEST_UID" >&2',
      '    exit 113',
      '    ;;',
      '  bootout)',
      '    rm -f "' + DOLLAR + 'SERVICE_STATE"',
      '    exit 0',
      '    ;;',
      '  bootstrap|kickstart)',
      '    : > "' + DOLLAR + 'SERVICE_STATE"',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 64',
      '',
    ].join('\n'),
  );
  writeExecutable(
    path.join(bin, 'curl'),
    '#!/bin/sh\nif [ "' + DOLLAR + '{CURL_MODE:-success}" = "fail" ]; then exit 22; fi\nexit 0\n',
  );
  writeExecutable(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  writeExecutable(
    path.join(bin, 'lsof'),
    [
      '#!/bin/sh',
      'port=',
      'for argument in "$@"; do',
      '  case "$argument" in -iTCP:*) port=${argument#-iTCP:} ;; esac',
      'done',
      'if [ "${LSOF_MODE:-free}" = "held" ]; then echo 99999; exit 0; fi',
      'case " $* " in',
      '  *" -Fpn "*)',
      '    if [ -f "$SERVICE_STATE" ]; then',
      '      printf "p4242\\nf9\\nn127.0.0.1:%s\\n" "$port"',
      '      exit 0',
      '    fi',
      '    exit 1',
      '    ;;',
      'esac',
      'if [ -f "$SERVICE_STATE" ]; then echo 4242; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'),
  );

  return {
    root,
    home,
    calls,
    serviceState,
    env: {
      ...process.env,
      HOME: home,
      PATH: [
        bin,
        path.dirname(process.execPath),
        process.env.PATH ?? '/usr/bin:/bin',
      ].join(path.delimiter),
      CALL_LOG: calls,
      SERVICE_STATE: serviceState,
      TEST_UID: String(process.getuid?.() ?? process.geteuid?.() ?? 0),
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
    launcherTransform?: (source: string) => string;
    bootstrapTransform?: (source: string) => string;
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
  const launcherSource = fs.readFileSync(INSTALLER_SOURCE, 'utf8');
  fs.writeFileSync(
    installer,
    options.launcherTransform ? options.launcherTransform(launcherSource) : launcherSource,
  );
  fs.chmodSync(installer, 0o755);
  const generationsRoot = path.join(dir, '.pxpipe-generations');
  const generationDraft = path.join(generationsRoot, '.fixture');
  fs.mkdirSync(generationDraft, { recursive: true, mode: 0o700 });
  const installerName = '.pxpipe-installer.mjs';
  const installerBytes = installerProgram();
  const helperDraft = path.join(generationDraft, installerName);
  fs.writeFileSync(helperDraft, installerBytes, { mode: 0o600 });
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
  fs.writeFileSync(
    path.join(packageDir, 'dist', 'macos-local-installer.js'),
    installerBytes,
  );

  const archiveName =
    'pxpipe-proxy-' + manifestVersion + '-' + commit + '.tgz';
  const archive = path.join(generationDraft, archiveName);
  execFileSync('tar', ['-czf', archive, '-C', source, 'package']);
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const manifestDraft = path.join(generationDraft, 'manifest.json');
  fs.writeFileSync(
    manifestDraft,
    JSON.stringify(
      {
        version: manifestVersion,
        sourceCommit: commit,
        archive: archiveName,
        sha256,
        installer: installerName,
        installerSha256: createHash('sha256').update(installerBytes).digest('hex'),
      },
      null,
      2,
    ) + '\n',
  );
  const generationBootstrap = path.join(generationDraft, 'install.sh');
  const bootstrapSource = fs.readFileSync(GENERATION_INSTALLER_SOURCE, 'utf8');
  fs.writeFileSync(
    generationBootstrap,
    options.bootstrapTransform ? options.bootstrapTransform(bootstrapSource) : bootstrapSource,
  );
  fs.chmodSync(generationBootstrap, 0o700);
  const storedRootLauncher = path.join(generationDraft, 'root-install.sh');
  fs.copyFileSync(installer, storedRootLauncher);
  fs.chmodSync(storedRootLauncher, 0o700);
  const receiptValue = {
    schemaVersion: 1,
    version: manifestVersion,
    sourceCommit: commit,
    files: {
      archive: { name: archiveName, sha256: fileSha256(archive) },
      bootstrap: { name: 'install.sh', sha256: fileSha256(generationBootstrap) },
      installer: { name: installerName, sha256: fileSha256(helperDraft) },
      launcher: { name: 'root-install.sh', sha256: fileSha256(storedRootLauncher) },
      manifest: { name: 'manifest.json', sha256: fileSha256(manifestDraft) },
    },
  };
  const receiptBytes = Buffer.from(JSON.stringify(receiptValue, null, 2) + '\n');
  const generation = createHash('sha256').update(receiptBytes).digest('hex');
  fs.writeFileSync(path.join(generationDraft, 'bundle-receipt-v1.json'), receiptBytes, {
    mode: 0o600,
  });
  const generationDirectory = path.join(generationsRoot, generation);
  fs.renameSync(generationDraft, generationDirectory);
  fs.writeFileSync(path.join(dir, '.pxpipe-current'), generation + '\n', { mode: 0o600 });

  return {
    dir,
    installer,
    helper: path.join(generationDirectory, installerName),
    manifest: path.join(generationDirectory, 'manifest.json'),
    receipt: path.join(generationDirectory, 'bundle-receipt-v1.json'),
    generation,
    commit,
  };
}

function makePackagerFixture(
  harness: Harness,
  options: {
    name?: string;
    launcherSuffix?: string;
    packagerTransform?: (source: string) => string;
  } = {},
): PackagerFixture {
  const repo = path.join(harness.root, `packager-repo${options.name ? `-${options.name}` : ''}`);
  const scripts = path.join(repo, 'scripts');
  const deploy = path.join(repo, 'deploy', 'macos-local');
  const packSource = path.join(repo, 'pack-source');
  const packageDirectory = path.join(packSource, 'package');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(deploy, { recursive: true });
  fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(packageDirectory, 'dist'), { recursive: true });
  const packagerTarget = path.join(scripts, 'package-macos-local.mjs');
  const packagerSource = fs.readFileSync(PACKAGER_SOURCE, 'utf8');
  fs.writeFileSync(
    packagerTarget,
    options.packagerTransform ? options.packagerTransform(packagerSource) : packagerSource,
  );
  fs.copyFileSync(INSTALLER_SOURCE, path.join(deploy, 'install.sh'));
  fs.copyFileSync(GENERATION_INSTALLER_SOURCE, path.join(deploy, 'generation-install.sh'));
  if (options.launcherSuffix) {
    fs.appendFileSync(path.join(deploy, 'install.sh'), options.launcherSuffix);
  }
  fs.chmodSync(path.join(deploy, 'install.sh'), 0o755);
  fs.chmodSync(path.join(deploy, 'generation-install.sh'), 0o755);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ name: 'pxpipe-proxy', version: VERSION, type: 'module' }) + '\n',
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    JSON.stringify({ name: 'pxpipe-proxy', version: VERSION, type: 'module' }) + '\n',
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin', 'cli.js'),
    `if (process.argv.includes("--version")) console.log(${JSON.stringify(VERSION)});\n`,
  );
  fs.writeFileSync(path.join(packageDirectory, 'dist', 'node.js'), 'export {};\n');
  fs.writeFileSync(
    path.join(packageDirectory, 'dist', 'macos-local-installer.js'),
    installerProgram(),
  );
  fs.writeFileSync(
    path.join(repo, 'dist', 'macos-local-installer.js'),
    'throw new Error("mutable dist helper must never be published");\n',
  );

  const fakePnpm = path.join(harness.root, 'bin', 'pnpm');
  writeExecutable(
    fakePnpm,
    [
      '#!/bin/sh',
      'if [ "' + DOLLAR + '1" = "run" ] && [ "${2:-}" = "build" ] && [ -n "${MUTATE_LAUNCHER:-}" ]; then',
      '  printf "\\n# mutated after capture\\n" >> "$MUTATE_LAUNCHER"',
      'fi',
      'if [ "' + DOLLAR + '1" != "pack" ]; then exit 0; fi',
      'if [ "${PNPM_FAIL_PACK:-0}" = "1" ]; then exit 42; fi',
      'shift',
      'destination=',
      'while [ "' + DOLLAR + '#" -gt 0 ]; do',
      '  case "' + DOLLAR + '1" in',
      '    --pack-destination)',
      '      destination="' + DOLLAR + '2"',
      '      shift 2',
      '      ;;',
      '    *) shift ;;',
      '  esac',
      'done',
      '[ -n "' + DOLLAR + 'destination" ] || exit 64',
      'mkdir -p "' + DOLLAR + 'destination"',
      'tar -czf "' + DOLLAR + 'destination/fixture.tgz" -C "' + DOLLAR + 'PACK_SOURCE" package',
      'if [ -n "${PUBLISH_BARRIER_DIR:-}" ]; then',
      '  mkdir -p "$PUBLISH_BARRIER_DIR"',
      '  : > "$PUBLISH_BARRIER_DIR/$PUBLISHER_ID"',
      '  while [ ! -f "$PUBLISH_BARRIER_DIR/$PUBLISHER_PEER" ]; do /bin/sleep 0.01; done',
      'fi',
      '',
    ].join('\n'),
  );

  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'],
    { cwd: repo },
  );
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
  return {
    repo,
    packager: path.join(scripts, 'package-macos-local.mjs'),
    packSource,
    output: path.join(harness.home, 'Dev', 'pxpipe-deploy'),
    commit,
  };
}

function runInstaller(
  bundle: Bundle,
  harness: Harness,
  args: string[] = [],
  env: NodeJS.ProcessEnv = harness.env,
) {
  return spawnSync(bundle.installer, args, {
    cwd: bundle.dir,
    env,
    encoding: 'utf8',
  });
}

function bundleFromPublishedOutput(output: string, commit: string): Bundle {
  const generation = fs.readFileSync(path.join(output, '.pxpipe-current'), 'utf8').trim();
  const generationDirectory = path.join(output, '.pxpipe-generations', generation);
  return {
    dir: output,
    installer: path.join(output, 'install.sh'),
    helper: path.join(generationDirectory, '.pxpipe-installer.mjs'),
    manifest: path.join(generationDirectory, 'manifest.json'),
    receipt: path.join(generationDirectory, 'bundle-receipt-v1.json'),
    generation,
    commit,
  };
}

function expectPublishedGenerationsComplete(output: string): void {
  const generationsRoot = path.join(output, '.pxpipe-generations');
  const generations = fs.readdirSync(generationsRoot, { withFileTypes: true });
  expect(generations.length).toBeGreaterThan(0);
  for (const entry of generations) {
    expect(entry.isDirectory()).toBe(true);
    expect(entry.name).toMatch(/^[0-9a-f]{64}$/u);
    const directory = path.join(generationsRoot, entry.name);
    const receiptFile = path.join(directory, 'bundle-receipt-v1.json');
    expect(fileSha256(receiptFile)).toBe(entry.name);
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as {
      files: Record<string, { name: string; sha256: string }>;
    };
    for (const component of Object.values(receipt.files)) {
      const target = path.join(directory, component.name);
      expect(fileSha256(target)).toBe(component.sha256);
    }
  }
  const selected = fs.readFileSync(path.join(output, '.pxpipe-current'), 'utf8').trim();
  const selectedReceipt = JSON.parse(
    fs.readFileSync(path.join(generationsRoot, selected, 'bundle-receipt-v1.json'), 'utf8'),
  ) as { files: { launcher: { sha256: string } } };
  expect(fileSha256(path.join(output, 'install.sh'))).toBe(
    selectedReceipt.files.launcher.sha256,
  );
}

function runPackagerAsync(
  fixture: PackagerFixture,
  harness: Harness,
  env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [fixture.packager, '--output', fixture.output],
      {
        cwd: fixture.repo,
        env: { ...harness.env, PACK_SOURCE: fixture.packSource, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function injectAfterUnique(source: string, needle: string, injected: string): string {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error('packager injection marker is not unique');
  }
  return source.slice(0, first + needle.length) + injected + source.slice(first + needle.length);
}

function pauseAtPublishHandoff(source: string, firstPublication: boolean): string {
  const marker = firstPublication
    ? '        // On first publication the launcher can select this already-complete\n' +
      '        // generation without a pointer, so install.sh becomes usable first.\n' +
      "        await publishBytes(launcherBytes, join(outputDir, 'install.sh'), 0o755);"
    : "        // Existing launchers can repair/restart across this two-rename window.\n" +
      '        await publishBytes(pointerBytes, join(outputDir, GENERATION_POINTER), 0o600);';
  return injectAfterUnique(source, marker, `
        await writeFile(process.env.PUBLISH_WINDOW_READY, 'ready\\n');
        while (true) {
          try {
            await lstat(process.env.PUBLISH_WINDOW_RELEASE);
            break;
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }`);
}

function dieAfterPointerPublish(source: string): string {
  const marker = "        // Existing launchers can repair/restart across this two-rename window.\n" +
    '        await publishBytes(pointerBytes, join(outputDir, GENERATION_POINTER), 0o600);';
  return injectAfterUnique(source, marker, '\n        process.kill(process.pid, "SIGKILL");');
}

function swapBootstrapAfterRootVerification(source: string): string {
  return injectAfterUnique(source, '    const selected = generationRecord(generation);', `
    fs.writeFileSync(
      path.join(selected.directory, "install.sh"),
      fs.readFileSync(process.env.SWAP_BOOTSTRAP_WITH),
    );`);
}

function swapInstallerAfterGenerationVerification(source: string): string {
  return injectAfterUnique(source, '  (async () => {', `
  fs.writeFileSync(
    path.join(directory, ".pxpipe-installer.mjs"),
    fs.readFileSync(process.env.SWAP_INSTALLER_WITH),
  );
`);
}

function swapManifestAndArchiveAfterGenerationVerification(source: string): string {
  return injectAfterUnique(source, '  (async () => {', `
  fs.copyFileSync(
    process.env.SWAP_ARCHIVE_WITH,
    path.join(directory, process.env.SWAP_ARCHIVE_NAME),
  );
  fs.copyFileSync(
    process.env.SWAP_MANIFEST_WITH,
    path.join(directory, "manifest.json"),
  );
`);
}

async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`timed out waiting for ${file}`);
}

function runPublishedProbe(output: string, harness: Harness) {
  return spawnSync(path.join(output, 'install.sh'), [], {
    cwd: output,
    env: { ...harness.env, PXPIPE_PORT: '0' },
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
      PXPIPE_MODELS: 'off',
      OPENAI_API_KEY: 'must-not-persist',
      PXPIPE_GATEWAY_BASE: 'https://must-not-persist.invalid',
    });

    expect(result.status, result.stderr).toBe(0);
    const plist = fs.readFileSync(plistPath(harness), 'utf8');
    expect(plist).toContain('<key>HOST</key>');
    expect(plist).toContain('<string>127.0.0.1</string>');
    expect(plist).toContain('<key>PORT</key>');
    expect(plist).toContain('<string>47991</string>');
    expect(plist).toContain('<key>PXPIPE_MODELS</key>');
    expect(plist).toContain('<string>' + INSTALLED_MODELS + '</string>');
    expect(plist).toContain('https://chatgpt.com/backend-api/codex');
    expect(plist).toContain('https://cli-chat-proxy.grok.com');
    expect(plist).not.toMatch(/must-not-persist|API_KEY|GATEWAY/u);
    expect(plist).not.toContain('0.0.0.0');
    expect(fs.readFileSync(path.join(harness.home, '.codex', 'config.toml'), 'utf8')).toContain(
      'base_url = "http://127.0.0.1:47991/_pxpipe/codex"',
    );
    expect(fs.readFileSync(path.join(harness.home, '.grok', 'config.toml'), 'utf8')).toContain(
      'cli_chat_proxy_base_url = "http://127.0.0.1:47991/_pxpipe/grok/v1"',
    );
    expect(fs.readlinkSync(path.join(installRoot(harness), 'current'))).toBe(
      path.join(installRoot(harness), 'releases', bundle.commit),
    );
    expect(fs.readFileSync(harness.calls, 'utf8')).toContain('bootstrap');
    expect(result.stdout).toContain('Run: codex');
    expect(result.stdout).toContain('Run: grok');
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
    expect(result.stderr).toContain('port 47821 remains in use');
    expectNoServiceChange(harness);
    expect(fs.existsSync(path.join(installRoot(harness), 'releases', bundle.commit))).toBe(
      false,
    );
  }, 15_000);

  it('rejects malformed manifests before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    fs.writeFileSync(bundle.manifest, '{');

    const result = runInstaller(bundle, harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('selected pxpipe generation failed verification');
    expectNoServiceChange(harness);
  });

  it('rejects a modified installer program before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    fs.appendFileSync(bundle.helper, '\n// modified\n');

    const result = runInstaller(bundle, harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('selected pxpipe generation failed verification');
    expectNoServiceChange(harness);
  });

  it('rejects a modified stable launcher before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    fs.appendFileSync(bundle.installer, '\n# modified\n');

    const result = runInstaller(bundle, harness);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('selected pxpipe generation failed verification');
    expectNoServiceChange(harness);
  });

  it('never executes bootstrap bytes swapped after root verification', () => {
    const harness = makeHarness();
    const sentinel = path.join(harness.root, 'swapped-bootstrap-ran');
    const swapped = path.join(harness.root, 'swapped-bootstrap.sh');
    writeExecutable(
      swapped,
      `#!/bin/sh\n: > "$SWAP_SENTINEL"\nexit 0\n`,
    );
    const bundle = makeBundle(harness.root, {
      launcherTransform: swapBootstrapAfterRootVerification,
    });

    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      SWAP_BOOTSTRAP_WITH: swapped,
      SWAP_SENTINEL: sentinel,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('selected pxpipe generation failed verification');
    expect(fs.existsSync(sentinel)).toBe(false);
    expectNoServiceChange(harness);
  });

  it('never imports installer bytes swapped after generation verification', () => {
    const harness = makeHarness();
    const sentinel = path.join(harness.root, 'swapped-installer-ran');
    const swapped = path.join(harness.root, 'swapped-installer.mjs');
    fs.writeFileSync(
      swapped,
      'import fs from "node:fs";\n' +
        'fs.writeFileSync(process.env.SWAP_SENTINEL, "executed\\n");\n' +
        'export async function runMacosInstallApp() {}\n',
    );
    const bundle = makeBundle(harness.root, {
      bootstrapTransform: swapInstallerAfterGenerationVerification,
    });

    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      SWAP_INSTALLER_WITH: swapped,
      SWAP_SENTINEL: sentinel,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('installer checksum');
    expect(fs.existsSync(sentinel)).toBe(false);
    expectNoServiceChange(harness);
  });

  it('never installs an archive and manifest swapped together after verification', () => {
    const harness = makeHarness();
    const sentinel = path.join(harness.root, 'swapped-archive-ran');
    const bundle = makeBundle(harness.root, {
      bootstrapTransform: swapManifestAndArchiveAfterGenerationVerification,
    });
    const originalManifest = readManifest(bundle);
    const swappedSource = path.join(harness.root, 'swapped-source');
    const swappedPackage = path.join(swappedSource, 'package');
    fs.mkdirSync(path.join(swappedPackage, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(swappedPackage, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(swappedPackage, 'package.json'),
      JSON.stringify({ name: 'pxpipe-proxy', version: VERSION, type: 'module' }) + '\n',
    );
    fs.writeFileSync(
      path.join(swappedPackage, 'bin', 'cli.js'),
      'import fs from "node:fs";\n' +
        'if (process.argv.includes("--version")) {\n' +
        '  fs.writeFileSync(process.env.SWAP_SENTINEL, "executed\\n");\n' +
        `  console.log(${JSON.stringify(VERSION)});\n` +
        '}\n',
    );
    fs.writeFileSync(path.join(swappedPackage, 'dist', 'node.js'), 'export {};\n');
    fs.copyFileSync(
      bundle.helper,
      path.join(swappedPackage, 'dist', 'macos-local-installer.js'),
    );
    const swappedArchive = path.join(harness.root, 'swapped-archive.tgz');
    execFileSync('tar', ['-czf', swappedArchive, '-C', swappedSource, 'package']);
    const swappedManifest = path.join(harness.root, 'swapped-manifest.json');
    fs.writeFileSync(
      swappedManifest,
      JSON.stringify({
        ...originalManifest,
        sha256: fileSha256(swappedArchive),
      }, null, 2) + '\n',
    );

    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      SWAP_ARCHIVE_WITH: swappedArchive,
      SWAP_ARCHIVE_NAME: originalManifest.archive,
      SWAP_MANIFEST_WITH: swappedManifest,
      SWAP_SENTINEL: sentinel,
    });

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(path.join(installRoot(harness), 'releases', bundle.commit))).toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('bundle manifest checksum does not match the verified bundle');
    expectNoServiceChange(harness);
  });

  it('rejects malformed or linked generation pointers before changing the service', () => {
    const harness = makeHarness();
    const malformed = makeBundle(harness.root);
    fs.writeFileSync(
      path.join(malformed.dir, '.pxpipe-current'),
      malformed.generation + '\n' + '0'.repeat(64) + '\n',
    );
    const malformedResult = runInstaller(malformed, harness);
    expect(malformedResult.status).not.toBe(0);
    expect(malformedResult.stderr).toContain('selected pxpipe generation failed verification');
    expectNoServiceChange(harness);

    const linked = makeBundle(harness.root, { commit: '9'.repeat(40) });
    const pointer = path.join(linked.dir, '.pxpipe-current');
    const pointerTarget = path.join(linked.dir, '.pointer-target');
    fs.renameSync(pointer, pointerTarget);
    fs.symlinkSync(pointerTarget, pointer);
    const linkedResult = runInstaller(linked, harness);
    expect(linkedResult.status).not.toBe(0);
    expect(linkedResult.stderr).toContain('selected pxpipe generation failed verification');
    expectNoServiceChange(harness);
  });

  it('removes ambient Node injection before the first Node process', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    const sentinel = path.join(harness.root, 'node-options-ran');
    const portableSentinel = path.join(harness.root, 'portable-cache-ran');
    const preload = path.join(harness.root, 'ambient-preload.cjs');
    fs.writeFileSync(
      preload,
      'require("node:fs").writeFileSync(process.env.NODE_SENTINEL, "ran\\n");\n',
    );
    writeExecutable(
      path.join(harness.root, 'bin', 'node'),
      [
        '#!/bin/sh',
        'if [ "${NODE_COMPILE_CACHE_PORTABLE+x}" = "x" ]; then : > "$PORTABLE_SENTINEL"; fi',
        `exec ${JSON.stringify(process.execPath)} "$@"`,
        '',
      ].join('\n'),
    );

    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      NODE_OPTIONS: `--require=${preload}`,
      NODE_PATH: path.join(harness.root, 'ambient-modules'),
      NODE_V8_COVERAGE: path.join(harness.root, 'coverage'),
      NODE_COMPILE_CACHE: path.join(harness.root, 'compile-cache'),
      NODE_COMPILE_CACHE_PORTABLE: '1',
      NODE_SENTINEL: sentinel,
      PORTABLE_SENTINEL: portableSentinel,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(portableSentinel)).toBe(false);
    expect(fs.existsSync(path.join(harness.root, 'coverage'))).toBe(false);
    expect(fs.existsSync(path.join(harness.root, 'compile-cache'))).toBe(false);
  });

  it('rejects a non-macOS direct launcher entry before changing the service', () => {
    const harness = makeHarness();
    const bundle = makeBundle(harness.root);
    const wrongBin = path.join(harness.root, 'wrong-platform-bin');
    fs.mkdirSync(wrongBin);
    writeExecutable(path.join(wrongBin, 'uname'), '#!/bin/sh\necho Linux\n');
    const result = runInstaller(bundle, harness, [], {
      ...harness.env,
      PATH: wrongBin + path.delimiter + harness.env.PATH,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('macOS-only');
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
    expect(named.stderr).toContain('selected pxpipe generation failed verification');
    expectNoServiceChange(harness);

    const valid = makeBundle(harness.root, { commit: 'b'.repeat(40) });
    const wrongDigest = readManifest(valid);
    wrongDigest.sha256 = '0'.repeat(64);
    writeManifest(valid, wrongDigest);
    const digested = runInstaller(valid, harness);
    expect(digested.status).not.toBe(0);
    expect(digested.stderr).toContain('selected pxpipe generation failed verification');
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
    expect(failed.stderr).toContain('installed service did not become healthy');
    expect(fs.readlinkSync(path.join(installRoot(harness), 'current'))).toBe(
      path.join(installRoot(harness), 'releases', first.commit),
    );
    expect(
      fs.existsSync(path.join(installRoot(harness), 'releases', second.commit)),
    ).toBe(false);
  }, 30_000);

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
    expect(fs.existsSync(installRoot(harness))).toBe(true);
    expect(
      fs.statSync(path.join(installRoot(harness), 'state')).mode & 0o777,
    ).toBe(0o700);
    expect(fs.existsSync(path.join(installRoot(harness), 'state', 'receipt-v1.json'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(installRoot(harness), 'releases'))).toBe(false);
    expect(fs.existsSync(plistPath(harness))).toBe(false);
    expect(fs.existsSync(path.join(harness.home, '.codex', 'config.toml'))).toBe(false);
    expect(fs.existsSync(path.join(harness.home, '.grok', 'config.toml'))).toBe(false);
    expect(fs.readFileSync(events, 'utf8')).toBe('{}\n');
    expect(fs.readFileSync(log, 'utf8')).toBe('kept\n');
  });

  it('publishes a complete real-packager generation and installs that exact archive helper', () => {
    const root = stableTempRoot('pxpipe-packager-success-');
    const harness = makeHarness(root);
    const fixture = makePackagerFixture(harness);
    const result = spawnSync(
      process.execPath,
      [fixture.packager, '--output', fixture.output],
      {
        cwd: fixture.repo,
        env: { ...harness.env, PACK_SOURCE: fixture.packSource },
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('complete bundle SHA-256');
    expectPublishedGenerationsComplete(fixture.output);
    expect(
      fs.readdirSync(fixture.output).filter((name) => !name.startsWith('.')),
    ).toEqual(['install.sh']);
    const bundle = bundleFromPublishedOutput(fixture.output, fixture.commit);
    expect(createHash('sha256').update(fs.readFileSync(bundle.receipt)).digest('hex')).toBe(
      bundle.generation,
    );
    const manifest = readManifest(bundle);
    const extract = path.join(root, 'published-archive-check');
    fs.mkdirSync(extract);
    execFileSync('tar', [
      '-xzf',
      path.join(path.dirname(bundle.manifest), manifest.archive),
      '-C',
      extract,
    ]);
    expect(fileSha256(bundle.helper)).toBe(
      fileSha256(path.join(extract, 'package', 'dist', 'macos-local-installer.js')),
    );

    const installed = runInstaller(bundle, harness);
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain('Run: codex');
    expect(installed.stdout).toContain('Run: grok');
  }, 20_000);

  it('publishes the captured launcher bytes when its ignored source changes later', () => {
    const root = stableTempRoot('pxpipe-packager-launcher-capture-');
    const harness = makeHarness(root);
    const fixture = makePackagerFixture(harness);
    const launcherSource = path.join(
      fixture.repo,
      'deploy',
      'macos-local',
      'install.sh',
    );
    const capturedSha256 = fileSha256(launcherSource);
    execFileSync('git', ['update-index', '--assume-unchanged', 'deploy/macos-local/install.sh'], {
      cwd: fixture.repo,
    });

    const result = spawnSync(
      process.execPath,
      [fixture.packager, '--output', fixture.output],
      {
        cwd: fixture.repo,
        env: {
          ...harness.env,
          PACK_SOURCE: fixture.packSource,
          MUTATE_LAUNCHER: launcherSource,
        },
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fileSha256(launcherSource)).not.toBe(capturedSha256);
    expect(fileSha256(path.join(fixture.output, 'install.sh'))).toBe(capturedSha256);
    const bundle = bundleFromPublishedOutput(fixture.output, fixture.commit);
    const receipt = JSON.parse(fs.readFileSync(bundle.receipt, 'utf8')) as {
      files: { launcher: { name: string; sha256: string } };
    };
    expect(receipt.files.launcher.sha256).toBe(capturedSha256);
    expect(fileSha256(path.join(path.dirname(bundle.receipt), receipt.files.launcher.name))).toBe(
      capturedSha256,
    );
  }, 20_000);

  it('refuses unsafe pre-existing generation roots without following or changing them', () => {
    const root = stableTempRoot('pxpipe-packager-generation-root-');
    const harness = makeHarness(root);
    const fixture = makePackagerFixture(harness);
    fs.mkdirSync(fixture.output, { recursive: true });
    const generationsRoot = path.join(fixture.output, '.pxpipe-generations');
    const symlinkTarget = path.join(root, 'owner-generation-target');
    fs.mkdirSync(symlinkTarget, { mode: 0o755 });
    const sentinel = path.join(symlinkTarget, 'owner-data');
    fs.writeFileSync(sentinel, 'untouched\n');
    fs.symlinkSync(symlinkTarget, generationsRoot);

    const linked = spawnSync(
      process.execPath,
      [fixture.packager, '--output', fixture.output],
      {
        cwd: fixture.repo,
        env: { ...harness.env, PACK_SOURCE: fixture.packSource },
        encoding: 'utf8',
      },
    );
    expect(linked.status).not.toBe(0);
    expect(linked.stderr).toContain('non-symlink 0700 directory');
    expect(fs.lstatSync(generationsRoot).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('untouched\n');
    expect(fs.statSync(symlinkTarget).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(path.join(fixture.output, 'install.sh'))).toBe(false);
    expect(fs.existsSync(path.join(fixture.output, '.pxpipe-current'))).toBe(false);

    fs.rmSync(generationsRoot);
    fs.mkdirSync(generationsRoot, { mode: 0o755 });
    fs.chmodSync(generationsRoot, 0o755);
    const unsafeMode = spawnSync(
      process.execPath,
      [fixture.packager, '--output', fixture.output],
      {
        cwd: fixture.repo,
        env: { ...harness.env, PACK_SOURCE: fixture.packSource },
        encoding: 'utf8',
      },
    );
    expect(unsafeMode.status).not.toBe(0);
    expect(unsafeMode.stderr).toContain('current-user-owned, non-symlink 0700 directory');
    expect(fs.statSync(generationsRoot).mode & 0o777).toBe(0o755);
  }, 10_000);

  it('waits behind a live publisher lock before exposing a generation pointer', async () => {
    const root = stableTempRoot('pxpipe-packager-publisher-lock-');
    const harness = makeHarness(root);
    const fixture = makePackagerFixture(harness);
    fs.mkdirSync(fixture.output, { recursive: true });
    const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    if (sleeper.pid === undefined) throw new Error('sleep fixture did not start');
    const sleeperExited = new Promise<void>((resolveExit) => {
      sleeper.once('exit', () => resolveExit());
    });
    const startSignature = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(sleeper.pid)],
      { encoding: 'utf8' },
    ).trim();
    fs.writeFileSync(
      path.join(fixture.output, '.pxpipe-publish.lock'),
      JSON.stringify({
        uid: process.getuid?.() ?? 0,
        pid: sleeper.pid,
        startSignature,
        nonce: 'a'.repeat(32),
      }) + '\n',
      { mode: 0o600 },
    );

    const publishing = runPackagerAsync(fixture, harness);
    const generationsRoot = path.join(fixture.output, '.pxpipe-generations');
    let generationReady = false;
    let pointerWasBlocked = false;
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        generationReady = fs.existsSync(generationsRoot) &&
          fs.readdirSync(generationsRoot).some((name) => /^[0-9a-f]{64}$/u.test(name));
        if (generationReady) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      }
      pointerWasBlocked = !fs.existsSync(path.join(fixture.output, '.pxpipe-current'));
    } finally {
      sleeper.kill('SIGTERM');
      await sleeperExited;
    }
    const result = await publishing;
    expect(generationReady).toBe(true);
    expect(pointerWasBlocked).toBe(true);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(fixture.output, '.pxpipe-current'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.output, '.pxpipe-publish.lock'))).toBe(false);
  }, 15_000);

  it('keeps first publication invokable after install.sh appears and before its pointer', async () => {
    const root = stableTempRoot('pxpipe-packager-first-handoff-');
    const harness = makeHarness(root);
    const ready = path.join(root, 'first-ready');
    const release = path.join(root, 'first-release');
    const fixture = makePackagerFixture(harness, {
      packagerTransform: (source) => pauseAtPublishHandoff(source, true),
    });

    const publishing = runPackagerAsync(fixture, harness, {
      PUBLISH_WINDOW_READY: ready,
      PUBLISH_WINDOW_RELEASE: release,
    });
    await waitForFile(ready);
    expect(fs.existsSync(path.join(fixture.output, 'install.sh'))).toBe(true);
    expect(fs.existsSync(path.join(fixture.output, '.pxpipe-current'))).toBe(false);

    const probe = runPublishedProbe(fixture.output, harness);
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain('PXPIPE_PORT');

    fs.writeFileSync(release, 'continue\n');
    const published = await publishing;
    expect(published.status, published.stderr).toBe(0);
    expectPublishedGenerationsComplete(fixture.output);
  }, 20_000);

  it('keeps an invocation live between pointer and differing-launcher publication', async () => {
    const root = stableTempRoot('pxpipe-packager-live-handoff-');
    const harness = makeHarness(root);
    const firstFixture = makePackagerFixture(harness, {
      name: 'old',
      launcherSuffix: '\n# launcher revision old\n',
    });
    const first = spawnSync(
      process.execPath,
      [firstFixture.packager, '--output', firstFixture.output],
      {
        cwd: firstFixture.repo,
        env: { ...harness.env, PACK_SOURCE: firstFixture.packSource },
        encoding: 'utf8',
      },
    );
    expect(first.status, first.stderr).toBe(0);

    const ready = path.join(root, 'handoff-ready');
    const release = path.join(root, 'handoff-release');
    const secondFixture = makePackagerFixture(harness, {
      name: 'new',
      launcherSuffix: '\n# launcher revision new\n',
      packagerTransform: (source) => pauseAtPublishHandoff(source, false),
    });
    const publishing = runPackagerAsync(secondFixture, harness, {
      PUBLISH_WINDOW_READY: ready,
      PUBLISH_WINDOW_RELEASE: release,
    });
    await waitForFile(ready);

    const selected = bundleFromPublishedOutput(secondFixture.output, secondFixture.commit);
    const selectedReceipt = JSON.parse(fs.readFileSync(selected.receipt, 'utf8')) as {
      files: { launcher: { sha256: string } };
    };
    expect(fileSha256(path.join(secondFixture.output, 'install.sh')))
      .not.toBe(selectedReceipt.files.launcher.sha256);
    const probe = runPublishedProbe(secondFixture.output, harness);
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain('PXPIPE_PORT');
    expect(fileSha256(path.join(secondFixture.output, 'install.sh')))
      .toBe(selectedReceipt.files.launcher.sha256);

    fs.writeFileSync(release, 'continue\n');
    const published = await publishing;
    expect(published.status, published.stderr).toBe(0);
    expectPublishedGenerationsComplete(secondFixture.output);
  }, 30_000);

  it('self-repairs after publisher death following the pointer rename', () => {
    const root = stableTempRoot('pxpipe-packager-death-handoff-');
    const harness = makeHarness(root);
    const firstFixture = makePackagerFixture(harness, {
      name: 'old',
      launcherSuffix: '\n# launcher revision before death\n',
    });
    const first = spawnSync(
      process.execPath,
      [firstFixture.packager, '--output', firstFixture.output],
      {
        cwd: firstFixture.repo,
        env: { ...harness.env, PACK_SOURCE: firstFixture.packSource },
        encoding: 'utf8',
      },
    );
    expect(first.status, first.stderr).toBe(0);

    const dyingFixture = makePackagerFixture(harness, {
      name: 'dying',
      launcherSuffix: '\n# launcher revision selected before death\n',
      packagerTransform: dieAfterPointerPublish,
    });
    const died = spawnSync(
      process.execPath,
      [dyingFixture.packager, '--output', dyingFixture.output],
      {
        cwd: dyingFixture.repo,
        env: { ...harness.env, PACK_SOURCE: dyingFixture.packSource },
        encoding: 'utf8',
      },
    );
    expect(died.status).toBeNull();
    expect(died.signal).toBe('SIGKILL');

    const selected = bundleFromPublishedOutput(dyingFixture.output, dyingFixture.commit);
    const selectedReceipt = JSON.parse(fs.readFileSync(selected.receipt, 'utf8')) as {
      files: { launcher: { sha256: string } };
    };
    expect(fileSha256(path.join(dyingFixture.output, 'install.sh')))
      .not.toBe(selectedReceipt.files.launcher.sha256);
    const probe = runPublishedProbe(dyingFixture.output, harness);
    expect(probe.status).not.toBe(0);
    expect(probe.stderr).toContain('PXPIPE_PORT');
    expect(fileSha256(path.join(dyingFixture.output, 'install.sh')))
      .toBe(selectedReceipt.files.launcher.sha256);
    expect(fs.existsSync(selected.receipt)).toBe(true);
  }, 30_000);

  it('keeps published generations complete under concurrent publishers and a later failure', async () => {
    const root = stableTempRoot('pxpipe-packager-race-');
    const harness = makeHarness(root);
    const fixture = makePackagerFixture(harness);
    fs.mkdirSync(fixture.output, { recursive: true });
    const ownerArchive = path.join(fixture.output, 'pxpipe-proxy-owner-data.tgz');
    fs.writeFileSync(ownerArchive, 'owner data\n');
    fs.writeFileSync(
      path.join(fixture.output, 'manifest.json'),
      JSON.stringify({ archive: path.basename(ownerArchive) }) + '\n',
    );
    const [first, second] = await Promise.all([
      runPackagerAsync(fixture, harness),
      runPackagerAsync(fixture, harness),
    ]);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expectPublishedGenerationsComplete(fixture.output);
    expect(fs.readFileSync(ownerArchive, 'utf8')).toBe('owner data\n');

    const selectedBeforeFailure = fs.readFileSync(
      path.join(fixture.output, '.pxpipe-current'),
      'utf8',
    );
    const failed = spawnSync(
      process.execPath,
      [fixture.packager, '--output', fixture.output],
      {
        cwd: fixture.repo,
        env: {
          ...harness.env,
          PACK_SOURCE: fixture.packSource,
          PNPM_FAIL_PACK: '1',
        },
        encoding: 'utf8',
      },
    );
    expect(failed.status).not.toBe(0);
    expect(fs.readFileSync(path.join(fixture.output, '.pxpipe-current'), 'utf8')).toBe(
      selectedBeforeFailure,
    );

    const bundle = bundleFromPublishedOutput(fixture.output, fixture.commit);
    expect(createHash('sha256').update(fs.readFileSync(bundle.receipt)).digest('hex')).toBe(
      bundle.generation,
    );
    const installed = runInstaller(bundle, harness);
    expect(installed.status, installed.stderr).toBe(0);
  }, 30_000);

  it('serializes concurrent publishers with different launcher revisions', async () => {
    const root = stableTempRoot('pxpipe-packager-launcher-race-');
    const harness = makeHarness(root);
    const firstFixture = makePackagerFixture(harness, {
      name: 'first',
      launcherSuffix: '\n# launcher revision one\n',
    });
    const secondFixture = makePackagerFixture(harness, {
      name: 'second',
      launcherSuffix: '\n# launcher revision two\n',
    });
    const barrier = path.join(root, 'publisher-barrier');
    const [first, second] = await Promise.all([
      runPackagerAsync(firstFixture, harness, {
        PUBLISH_BARRIER_DIR: barrier,
        PUBLISHER_ID: 'first',
        PUBLISHER_PEER: 'second',
      }),
      runPackagerAsync(secondFixture, harness, {
        PUBLISH_BARRIER_DIR: barrier,
        PUBLISHER_ID: 'second',
        PUBLISHER_PEER: 'first',
      }),
    ]);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expectPublishedGenerationsComplete(firstFixture.output);
    const selected = fs.readFileSync(
      path.join(firstFixture.output, '.pxpipe-current'),
      'utf8',
    ).trim();
    const selectedReceipt = JSON.parse(
      fs.readFileSync(
        path.join(
          firstFixture.output,
          '.pxpipe-generations',
          selected,
          'bundle-receipt-v1.json',
        ),
        'utf8',
      ),
    ) as { files: { launcher: { sha256: string } } };
    expect(fileSha256(path.join(firstFixture.output, 'install.sh'))).toBe(
      selectedReceipt.files.launcher.sha256,
    );
    expect(
      fs.readdirSync(firstFixture.output).some((name) => name.includes('publish.lock')),
    ).toBe(false);
  }, 30_000);

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
    expect(missingOutput.stderr).toContain('$HOME/Dev/pxpipe-deploy');

    const wrongStableOutput = path.join(os.homedir(), 'Dev', 'pxpipe-deploy-other');
    const wrongStableResult = spawnSync(
      process.execPath,
      [packager, '--output', wrongStableOutput],
      { cwd: root, encoding: 'utf8' },
    );
    expect(wrongStableResult.status).not.toBe(0);
    expect(wrongStableResult.stderr).toContain('local bundle output must be exactly');

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
    expect(privateResult.stderr).toContain('local bundle output must be exactly');
    expect(fs.existsSync(privateOutput)).toBe(false);

    const privateViaPnpm = spawnSync(
      process.execPath,
      [packager, '--', '--output', privateOutput],
      { cwd: root, encoding: 'utf8' },
    );
    expect(privateViaPnpm.status).not.toBe(0);
    expect(privateViaPnpm.stderr).toContain('local bundle output must be exactly');
  });
});
