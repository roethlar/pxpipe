import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runMacosInstallApp,
  validateLocalInstallReceipt,
  type LegacyAdoptionIdentity,
  type RunMacosInstallAppOptions,
} from '../src/macos-local-install-app.js';
import {
  CODEX_SUBSCRIPTION_UPSTREAM,
  GROK_SUBSCRIPTION_UPSTREAM,
  INSTALLER_RESOURCE_NAMES,
  INSTALLER_PROGRAM_NAME,
  INSTALLED_MODELS,
  InstallerCrashSimulation,
  resolveMacosInstallerPaths,
  sha256,
  type CommandResult,
  type CommandRunner,
} from '../src/macos-local-installer.js';

const VERSION = '0.8.0-provenance-safe.1';
const SOURCE = 'a'.repeat(40);
const UID = process.getuid?.() ?? process.geteuid?.() ?? 0;
const encoder = new TextEncoder();

interface LoadedJob {
  path: string;
  program: string;
  arguments: string[];
  stdout: string;
  stderr: string;
  environment: Record<string, string>;
}

interface Harness {
  readonly root: string;
  readonly home: string;
  readonly helper: string;
  readonly paths: ReturnType<typeof resolveMacosInstallerPaths>;
  readonly runner: CommandRunner;
  readonly calls: string[];
  loaded: boolean;
  healthy: boolean;
  readonly unhealthyPorts: Set<number>;
  failStop: boolean;
  jobPid: string;
  listenerOutput: string;
  bindingAddress: string;
  activePort: number;
  readonly lingeringPortPolls: Map<number, number>;
  readonly lingerOnStopPolls: Map<number, number>;
  readonly lsofPorts: number[];
  readonly bootstrapPointers: string[];
  startupPrintMisses: number;
  startupPidStateMisses: number;
  listenerMisses: number;
  invocation: number;
  nonce: number;
  loadedJob: LoadedJob | undefined;
}

let harness: Harness;

function result(code = 0, stdout = '', stderr = ''): CommandResult {
  return { code, stdout: encoder.encode(stdout), stderr: encoder.encode(stderr) };
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function nextId(target: Harness): string {
  target.nonce += 1;
  return target.nonce.toString(16).padStart(32, '0');
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

function loadedJobFromPlist(target: Harness, plist: string): LoadedJob {
  const argumentsMatch = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<\/array>/u.exec(plist);
  const environmentMatch = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/u.exec(plist);
  const stdoutMatch = /<key>StandardOutPath<\/key><string>([^<]*)<\/string>/u.exec(plist);
  const stderrMatch = /<key>StandardErrorPath<\/key><string>([^<]*)<\/string>/u.exec(plist);
  if (argumentsMatch === null || environmentMatch === null || stdoutMatch === null || stderrMatch === null) {
    throw new Error('fixture plist is malformed');
  }
  const environment: Record<string, string> = {};
  for (const match of environmentMatch[1]!.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/gu)) {
    environment[decodeXml(match[1]!)] = decodeXml(match[2]!);
  }
  return {
    path: target.paths.launchAgent,
    program: decodeXml(argumentsMatch[1]!),
    arguments: [decodeXml(argumentsMatch[1]!), decodeXml(argumentsMatch[2]!)],
    stdout: decodeXml(stdoutMatch[1]!),
    stderr: decodeXml(stderrMatch[1]!),
    environment,
  };
}

function printLoadedJob(target: Harness, state = 'running'): string {
  const logs = path.join(target.home, 'Library', 'Logs', 'pxpipe');
  const job = target.loadedJob ?? {
    path: target.paths.launchAgent,
    program: '/usr/bin/node',
    arguments: ['/usr/bin/node', path.join(target.paths.current, 'bin', 'cli.js')],
    stdout: path.join(logs, 'pxpipe.out.log'),
    stderr: path.join(logs, 'pxpipe.err.log'),
    environment: {
      HOST: '127.0.0.1',
      PORT: String(target.activePort),
      PXPIPE_MODELS: INSTALLED_MODELS,
      PXPIPE_CODEX_UPSTREAM: CODEX_SUBSCRIPTION_UPSTREAM,
      PXPIPE_GROK_UPSTREAM: GROK_SUBSCRIPTION_UPSTREAM,
    },
  };
  const environment = Object.entries(job.environment)
    .map(([key, value]) => `\t\t${key} => ${value}`)
    .join('\n');
  return `gui/${UID}/com.pxpipe.proxy = {\n\tactive count = 1\n\tpath = ${job.path}\n\ttype = LaunchAgent\n\tstate = ${state}\n\n\tprogram = ${job.program}\n\targuments = {\n${job.arguments.map((argument) => `\t\t${argument}`).join('\n')}\n\t}\n\n\tstdout path = ${job.stdout}\n\tstderr path = ${job.stderr}\n\tinherited environment = {\n\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.fixture/Listeners\n\t}\n\n\tdefault environment = {\n\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin\n\t}\n\n\tenvironment = {\n\t\tOSLogRateLimit => 64\n${environment}\n\t\tXPC_SERVICE_NAME => com.pxpipe.proxy\n\t}\n\n\tpid = ${target.jobPid}\n\tspawn type = daemon (3)\n\tjetsam properties = {\n\t\tstate = active\n\t}\n\tresource coalition = {\n\t\tstate = active\n\t}\n}\n`;
}

async function setBundleSource(target: Harness, sourceCommit: string): Promise<void> {
  const bundle = path.dirname(target.helper);
  const archive = `pxpipe-proxy-${VERSION}-${sourceCommit}.tgz`;
  const archiveBytes = encoder.encode(`fixture archive ${sourceCommit}\n`);
  await fs.writeFile(path.join(bundle, archive), archiveBytes);
  await fs.writeFile(path.join(bundle, 'manifest.json'), `${JSON.stringify({
    version: VERSION,
    sourceCommit,
    archive,
    sha256: sha256(archiveBytes),
    installer: INSTALLER_PROGRAM_NAME,
    installerSha256: sha256(await fs.readFile(target.helper)),
  }, null, 2)}\n`);
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-install-app-'));
  const home = path.join(root, 'home');
  const bundle = path.join(root, 'bundle');
  const fixture = path.join(root, 'fixture', 'package');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.mkdir(path.join(fixture, 'bin'), { recursive: true });
  await fs.mkdir(path.join(fixture, 'dist'), { recursive: true });
  await fs.mkdir(bundle);
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({
    name: 'pxpipe-proxy', version: VERSION, type: 'module',
  }));
  await fs.writeFile(path.join(fixture, 'bin', 'cli.js'), 'console.log("fixture");\n');
  await fs.writeFile(path.join(fixture, 'dist', 'node.js'), 'export {};\n');
  await fs.writeFile(path.join(fixture, 'dist', 'macos-local-installer.js'), 'fixture installer\n');

  const helper = path.join(bundle, INSTALLER_PROGRAM_NAME);
  const helperBytes = encoder.encode('fixture installer\n');
  const archiveBytes = encoder.encode('fixture archive\n');
  const archive = `pxpipe-proxy-${VERSION}-${SOURCE}.tgz`;
  await fs.writeFile(helper, helperBytes);
  await fs.writeFile(path.join(bundle, archive), archiveBytes);
  await fs.writeFile(path.join(bundle, 'manifest.json'), `${JSON.stringify({
    version: VERSION,
    sourceCommit: SOURCE,
    archive,
    sha256: sha256(archiveBytes),
    installer: INSTALLER_PROGRAM_NAME,
    installerSha256: sha256(helperBytes),
  }, null, 2)}\n`);

  const state = {
    root,
    home,
    helper,
    paths: resolveMacosInstallerPaths(home),
    calls: [] as string[],
    loaded: false,
    healthy: true,
    unhealthyPorts: new Set<number>(),
    failStop: false,
    jobPid: '4242',
    listenerOutput: '4242\n',
    bindingAddress: '127.0.0.1',
    activePort: 47821,
    lingeringPortPolls: new Map<number, number>(),
    lingerOnStopPolls: new Map<number, number>(),
    lsofPorts: [],
    bootstrapPointers: [],
    startupPrintMisses: 0,
    startupPidStateMisses: 0,
    listenerMisses: 0,
    invocation: 0,
    nonce: 0,
    loadedJob: undefined,
    runner: undefined as unknown as CommandRunner,
  } satisfies Harness;

  const entries = [
    'package/',
    'package/package.json',
    'package/bin/',
    'package/bin/cli.js',
    'package/dist/',
    'package/dist/node.js',
    'package/dist/macos-local-installer.js',
  ];
  state.runner = async (command, args) => {
    state.calls.push(`${command} ${args.join(' ')}`);
    if (command === 'tar' && args[0] === '-tzf') return result(0, `${entries.join('\n')}\n`);
    if (command === 'tar' && args[0] === '-tvzf') {
      return result(0, `${entries.map((entry) => `${entry.endsWith('/') ? 'd' : '-'} fixture ${entry}`).join('\n')}\n`);
    }
    if (command === 'tar' && args[0] === '-xzf') {
      const destination = args[args.indexOf('-C') + 1];
      if (destination === undefined) return result(2, '', 'missing destination');
      await fs.cp(fixture, path.join(destination, 'package'), { recursive: true });
      return result();
    }
    if (
      (command === process.execPath || command === '/usr/bin/node')
      && args.at(-1) === '--version'
    ) return result(0, `${VERSION}\n`);
    if (command === 'launchctl' && args[0] === 'print') {
      if (state.loaded && state.startupPrintMisses > 0) {
        state.startupPrintMisses -= 1;
        return result(
          113,
          '',
          `Bad request.\nCould not find service "com.pxpipe.proxy" in domain for user gui: ${UID}\n`,
        );
      }
      if (state.loaded && state.startupPidStateMisses > 0) {
        state.startupPidStateMisses -= 1;
        return result(0, printLoadedJob(state, 'spawn scheduled'));
      }
      return state.loaded
        ? result(0, printLoadedJob(state))
        : result(
            113,
            '',
            `Bad request.\nCould not find service "com.pxpipe.proxy" in domain for user gui: ${UID}\n`,
          );
    }
    if (command === 'launchctl' && args[0] === 'bootout') {
      if (state.failStop) return result(5, '', 'refused');
      const linger = state.lingerOnStopPolls.get(state.activePort);
      if (linger !== undefined) state.lingeringPortPolls.set(state.activePort, linger);
      state.loaded = false;
      return result();
    }
    if (command === 'launchctl' && (args[0] === 'bootstrap' || args[0] === 'kickstart')) {
      if (args[0] === 'bootstrap') {
        state.bootstrapPointers.push(await fs.readlink(state.paths.current));
        const installedPlist = await fs.readFile(state.paths.launchAgent, 'utf8');
        const portMatch = /<key>PORT<\/key>\s*<string>([1-9][0-9]*)<\/string>/u.exec(installedPlist);
        if (portMatch === null) return result(5, '', 'missing port');
        state.activePort = Number(portMatch[1]);
        state.loadedJob = loadedJobFromPlist(state, installedPlist);
      }
      state.loaded = true;
      return result();
    }
    if (command === 'lsof') {
      const portArgument = args.find((argument) => argument.startsWith('-iTCP:'));
      const queriedPort = Number(portArgument?.slice('-iTCP:'.length));
      state.lsofPorts.push(queriedPort);
      const lingering = state.lingeringPortPolls.get(queriedPort) ?? 0;
      if (lingering > 0) {
        state.lingeringPortPolls.set(queriedPort, lingering - 1);
        return result(0, state.listenerOutput);
      }
      if (state.loaded && state.listenerMisses > 0) {
        state.listenerMisses -= 1;
        return result(1);
      }
      if (!state.loaded || queriedPort !== state.activePort) return result(1);
      if (args.includes('-Fpn')) {
        return result(
          0,
          `p${state.jobPid}\nf19\nn${state.bindingAddress}:${queriedPort}\n`,
        );
      }
      return result(0, state.listenerOutput);
    }
    if (command === 'curl') {
      const url = args.at(-1) ?? '';
      const curlPort = Number(/^http:\/\/127\.0\.0\.1:([1-9][0-9]*)\/$/u.exec(url)?.[1]);
      return result(state.healthy && !state.unhealthyPorts.has(curlPort) ? 0 : 22);
    }
    if (command === 'ps') return result(0, 'Sat Jul 11 03:00:00 2026\n');
    return result(127, '', `unexpected command: ${command}`);
  };
  return state;
}

async function run(
  target: Harness,
  argv: readonly string[] = [],
  env: Readonly<Record<string, string | undefined>> = {},
  hooks?: { checkpoint(name: string): void | Promise<void> },
  installSignalHandlers = false,
  legacyAdoptionIdentity?: LegacyAdoptionIdentity,
) {
  target.invocation += 1;
  return runMacosInstallApp({
    entryFile: target.helper,
    argv,
    env,
    home: target.home,
    runner: target.runner,
    sleep: async () => undefined,
    processIdentity: {
      uid: UID,
      pid: 10_000 + target.invocation,
      startSignature: `fixture-${target.invocation}`,
    },
    isProcessAlive: async () => false,
    nodeExecutable: '/usr/bin/node',
    platform: 'darwin',
    commandAvailable: async () => true,
    legacyAdoptionIdentity,
    transactionId: target.invocation.toString(16).padStart(32, '0'),
    nonce: () => nextId(target),
    output: () => undefined,
    installSignalHandlers,
    hooks,
  });
}

async function runWithPreflightOverrides(
  target: Harness,
  overrides: Partial<RunMacosInstallAppOptions>,
) {
  target.invocation += 1;
  return runMacosInstallApp({
    entryFile: target.helper,
    argv: [],
    env: {},
    home: target.home,
    runner: target.runner,
    sleep: async () => undefined,
    processIdentity: {
      uid: UID,
      pid: 20_000 + target.invocation,
      startSignature: `preflight-${target.invocation}`,
    },
    isProcessAlive: async () => false,
    nodeExecutable: '/usr/bin/node',
    transactionId: target.invocation.toString(16).padStart(32, '0'),
    nonce: () => nextId(target),
    output: () => undefined,
    installSignalHandlers: false,
    platform: 'darwin',
    commandAvailable: async () => true,
    ...overrides,
  });
}

async function installedLegacyIdentity(target: Harness): Promise<LegacyAdoptionIdentity> {
  const receipt = JSON.parse(await fs.readFile(target.paths.receipt, 'utf8')) as {
    payload: {
      sourceCommit: string;
      version: string;
      archiveSha256: string;
      releaseTreeSha256: string;
    };
  };
  return {
    sourceCommit: receipt.payload.sourceCommit,
    version: receipt.payload.version,
    archiveSha256: receipt.payload.archiveSha256,
    releaseTreeSha256: receipt.payload.releaseTreeSha256,
  };
}

async function expectJournalHasAllResources(target: Harness): Promise<void> {
  const journal = JSON.parse(await fs.readFile(target.paths.journal, 'utf8')) as {
    expectedResources: Array<{ name: string }>;
    resources: Array<{ name: string }>;
  };
  const expectedNames = [...INSTALLER_RESOURCE_NAMES].sort();
  expect(journal.expectedResources.map(({ name }) => name).sort()).toEqual(expectedNames);
  expect(journal.resources.map(({ name }) => name).sort()).toEqual(expectedNames);
}

async function expectNoTransactionDebris(target: Harness): Promise<void> {
  expect(await exists(target.paths.journal)).toBe(false);
  expect(await exists(target.paths.lock)).toBe(false);
  const transactions = await fs.readdir(target.paths.transactions).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
    throw error;
  });
  const stateEntries = await fs.readdir(target.paths.stateRoot);
  const installEntries = await fs.readdir(target.paths.installRoot);
  expect(transactions).toEqual([]);
  expect(stateEntries.filter((entry) => /^\.candidate-[0-9a-f]{32}$/u.test(entry))).toEqual([]);
  expect(installEntries.filter((entry) => /^\.current-[0-9a-f]{32}$/u.test(entry))).toEqual([]);
}

async function expectCohesiveInstalledState(target: Harness): Promise<void> {
  expect(target.loaded).toBe(true);
  expect(await fs.readlink(target.paths.current)).toBe(path.join(target.paths.releases, SOURCE));
  for (const file of [
    target.paths.launchAgent,
    target.paths.receipt,
    target.paths.codexConfig,
    target.paths.grokConfig,
    path.join(target.paths.releases, SOURCE, 'bin', 'cli.js'),
  ]) expect(await exists(file)).toBe(true);
  await expectNoTransactionDebris(target);
}

async function expectCohesiveAbsentState(target: Harness): Promise<void> {
  expect(target.loaded).toBe(false);
  for (const file of [
    target.paths.current,
    target.paths.launchAgent,
    target.paths.receipt,
    target.paths.codexConfig,
    target.paths.grokConfig,
    path.join(target.paths.releases, SOURCE),
  ]) expect(await exists(file)).toBe(false);
  await expectNoTransactionDebris(target);
}

interface OperationalSnapshot {
  readonly currentTarget: string;
  readonly plist: Buffer;
  readonly receipt: Buffer;
  readonly codex: Buffer;
  readonly grok: Buffer;
  readonly bootouts: number;
  readonly bootstraps: number;
}

async function operationalSnapshot(target: Harness): Promise<OperationalSnapshot> {
  return {
    currentTarget: await fs.readlink(target.paths.current),
    plist: await fs.readFile(target.paths.launchAgent),
    receipt: await fs.readFile(target.paths.receipt),
    codex: await fs.readFile(target.paths.codexConfig),
    grok: await fs.readFile(target.paths.grokConfig),
    bootouts: target.calls.filter((call) => call.startsWith('launchctl bootout')).length,
    bootstraps: target.calls.filter((call) => call.startsWith('launchctl bootstrap')).length,
  };
}

async function expectNoOperationalMutation(
  target: Harness,
  before: OperationalSnapshot,
): Promise<void> {
  expect(await operationalSnapshot(target)).toEqual(before);
  expect(await exists(target.paths.journal)).toBe(false);
}

beforeEach(async () => {
  harness = await makeHarness();
});

afterEach(async () => {
  await fs.rm(harness.root, { recursive: true, force: true });
});

describe('runnable macOS local installer app', () => {
  it('rejects direct helper execution off macOS before touching installer state', async () => {
    await expect(runWithPreflightOverrides(harness, { platform: 'linux' }))
      .rejects.toThrow('macOS-only');
    expect(await exists(harness.paths.stateRoot)).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  it.each([
    'NODE_OPTIONS',
    'NODE_PATH',
    'NODE_V8_COVERAGE',
    'NODE_COMPILE_CACHE',
    'NODE_COMPILE_CACHE_PORTABLE',
  ])('rejects direct helper execution with injectable %s before state', async (name) => {
    await expect(runWithPreflightOverrides(harness, { env: { [name]: '/owner/injection' } }))
      .rejects.toThrow(`unsafe Node environment variable is set: ${name}`);
    expect(await exists(harness.paths.stateRoot)).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  it.each([
    { command: '/usr/bin/node', label: 'node' },
    { command: 'tar', label: 'tar' },
    { command: 'launchctl', label: 'launchctl' },
    { command: 'lsof', label: 'lsof' },
    { command: 'curl', label: 'curl' },
    { command: 'ps', label: 'ps' },
  ])('rejects a missing required $label command before state or extraction', async ({ command, label }) => {
    await expect(runWithPreflightOverrides(harness, {
      commandAvailable: async (candidate) => candidate !== command,
    })).rejects.toThrow(`required command not found: ${label}`);
    expect(await exists(harness.paths.stateRoot)).toBe(false);
    expect(harness.calls).toEqual([]);
  });

  it('fresh-installs both clients, one fixed service, and an alternate port', async () => {
    await expect(run(harness, [], {
      PXPIPE_PORT: '49123',
      OPENAI_API_KEY: 'must-not-leak',
      PXPIPE_GATEWAY_BASE: 'https://must-not-leak.invalid',
    })).resolves.toBe('changed');

    const codex = await fs.readFile(harness.paths.codexConfig, 'utf8');
    const grok = await fs.readFile(harness.paths.grokConfig, 'utf8');
    const plist = await fs.readFile(harness.paths.launchAgent, 'utf8');
    const logDirectory = path.join(harness.home, 'Library', 'Logs', 'pxpipe');
    const stdoutLog = path.join(logDirectory, 'pxpipe.out.log');
    const stderrLog = path.join(logDirectory, 'pxpipe.err.log');
    expect(codex).toContain('base_url = "http://127.0.0.1:49123/_pxpipe/codex"');
    expect(codex).toContain('supports_websockets = false');
    expect(grok).toContain('cli_chat_proxy_base_url = "http://127.0.0.1:49123/_pxpipe/grok/v1"');
    expect(grok).not.toContain('models_base_url');
    expect(plist).toContain('<string>49123</string>');
    expect(plist).toContain('PXPIPE_CODEX_UPSTREAM');
    expect(plist).toContain('PXPIPE_GROK_UPSTREAM');
    expect(plist).toContain('<key>ProcessType</key><string>Background</string>');
    expect(plist).toContain(`<key>StandardOutPath</key><string>${stdoutLog}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key><string>${stderrLog}</string>`);
    expect(plist).not.toMatch(/must-not-leak|API_KEY|GATEWAY/u);
    expect((await fs.lstat(logDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.lstat(stdoutLog)).mode & 0o777).toBe(0o600);
    expect((await fs.lstat(stderrLog)).mode & 0o777).toBe(0o600);
    expect(harness.loaded).toBe(true);
    expect(await fs.readlink(harness.paths.current)).toBe(
      path.join(harness.paths.releases, SOURCE),
    );

    const envelope = JSON.parse(await fs.readFile(harness.paths.receipt, 'utf8')) as {
      payload: unknown;
    };
    expect(validateLocalInstallReceipt(envelope.payload)).toMatchObject({
      sourceCommit: SOURCE,
      version: VERSION,
      port: 49123,
    });
  });

  it('waits for launchd to finish a non-running transition that still reports the job PID', async () => {
    harness.startupPidStateMisses = 1;

    await expect(run(harness)).resolves.toBe('changed');

    await expectCohesiveInstalledState(harness);
    expect(harness.startupPidStateMisses).toBe(0);
  });

  it('never accepts a persistent non-running launchd state even when it reports a PID', async () => {
    harness.startupPidStateMisses = 20;

    await expect(run(harness)).rejects.toThrow('installed pxpipe job did not acquire its selected port');

    await expectCohesiveAbsentState(harness);
  });

  it('is a true no-op on an already-correct reinstall', async () => {
    await run(harness);
    const tracked = [
      harness.paths.codexConfig,
      harness.paths.grokConfig,
      harness.paths.launchAgent,
      harness.paths.receipt,
    ];
    const before = await Promise.all(tracked.map(async (file) => (await fs.lstat(file)).mtimeMs));
    const bootstrapCount = harness.calls.filter((call) => call.startsWith('launchctl bootstrap')).length;
    const bindingProofs = harness.calls.filter((call) => call.includes('lsof -w') && call.includes('-Fpn')).length;
    const healthChecks = harness.calls.filter((call) => call.startsWith('curl ')).length;

    await expect(run(harness)).resolves.toBe('no-op');

    expect(await Promise.all(tracked.map(async (file) => (await fs.lstat(file)).mtimeMs))).toEqual(before);
    expect(harness.calls.filter((call) => call.startsWith('launchctl bootstrap'))).toHaveLength(bootstrapCount);
    expect(harness.calls.filter((call) => call.includes('lsof -w') && call.includes('-Fpn')).length)
      .toBeGreaterThan(bindingProofs);
    expect(harness.calls.filter((call) => call.startsWith('curl ')).length).toBeGreaterThan(healthChecks);
  });

  it('refuses to call an unhealthy matching install a no-op', async () => {
    await run(harness);
    harness.healthy = false;
    const before = await operationalSnapshot(harness);

    await expect(run(harness)).rejects.toThrow('did not become healthy');

    await expectNoOperationalMutation(harness, before);
  });

  it('does not trust a mutable release manifest when installed files drift', async () => {
    await run(harness);
    await fs.appendFile(path.join(harness.paths.releases, SOURCE, 'dist', 'node.js'), '// owner drift\n');
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;
    await expect(run(harness)).rejects.toThrow('managed release tree drifted');
    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout'))).toHaveLength(bootouts);
    expect(harness.loaded).toBe(true);
  });

  it.each([
    {
      name: 'current release link on update',
      argv: [] as readonly string[],
      error: 'managed current release link drifted',
      async mutate(target: Harness) {
        await fs.rm(target.paths.current);
        await fs.symlink(path.join(target.paths.releases, 'b'.repeat(40)), target.paths.current);
      },
    },
    {
      name: 'LaunchAgent on uninstall',
      argv: ['--uninstall'] as readonly string[],
      error: 'managed LaunchAgent drifted',
      async mutate(target: Harness) {
        await fs.appendFile(target.paths.launchAgent, '<!-- owner drift -->\n');
      },
    },
    {
      name: 'release manifest on update',
      argv: [] as readonly string[],
      error: 'managed release manifest drifted',
      async mutate(target: Harness) {
        const manifestPath = path.join(target.paths.releases, SOURCE, '.pxpipe-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
          version: string;
          archive: string;
        };
        manifest.version = 'owner-version';
        manifest.archive = `pxpipe-proxy-owner-version-${SOURCE}.tgz`;
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      },
    },
    {
      name: 'service log artifact on uninstall',
      argv: ['--uninstall'] as readonly string[],
      error: 'managed service artifact is missing',
      async mutate(target: Harness) {
        await fs.rm(path.join(target.home, 'Library', 'Logs', 'pxpipe', 'pxpipe.out.log'));
      },
    },
    {
      name: 'loaded service label on uninstall',
      argv: ['--uninstall'] as readonly string[],
      error: 'managed launchd service is not loaded',
      async mutate(target: Harness) {
        target.loaded = false;
      },
    },
  ])('rejects drifted $name with zero operational mutation', async ({ argv, error, mutate }) => {
    await run(harness);
    await mutate(harness);
    const before = await operationalSnapshot(harness);

    await expect(run(harness, argv)).rejects.toThrow(error);

    await expectNoOperationalMutation(harness, before);
  });

  it.each([
    {
      field: 'plist path',
      mutate(job: LoadedJob) { job.path = '/tmp/foreign.plist'; },
    },
    {
      field: 'program',
      mutate(job: LoadedJob) { job.program = '/tmp/foreign-node'; },
    },
    {
      field: 'arguments',
      mutate(job: LoadedJob) { job.arguments = [job.program, '/tmp/foreign-cli.js']; },
    },
    {
      field: 'stdout path',
      mutate(job: LoadedJob) { job.stdout = '/tmp/foreign.out'; },
    },
    {
      field: 'stderr path',
      mutate(job: LoadedJob) { job.stderr = '/tmp/foreign.err'; },
    },
    {
      field: 'managed environment',
      mutate(job: LoadedJob) { job.environment.PORT = '59999'; },
    },
    {
      field: 'unexpected environment',
      mutate(job: LoadedJob) { job.environment.OWNER_INJECTED = '1'; },
    },
  ])('rejects a foreign loaded launchd $field while the managed files remain exact', async ({ mutate }) => {
    await run(harness);
    if (harness.loadedJob === undefined) throw new Error('fixture job was not loaded');
    mutate(harness.loadedJob);
    const before = await operationalSnapshot(harness);

    await expect(run(harness, ['--uninstall'])).rejects.toThrow('loaded launchd job');

    await expectNoOperationalMutation(harness, before);
    expect(harness.loaded).toBe(true);
  });

  it('surgically uninstalls and retains the stable private state root', async () => {
    await run(harness);
    const stdoutLog = path.join(harness.home, 'Library', 'Logs', 'pxpipe', 'pxpipe.out.log');
    const stderrLog = path.join(harness.home, 'Library', 'Logs', 'pxpipe', 'pxpipe.err.log');
    await fs.appendFile(stdoutLog, 'owner stdout history\n');
    await fs.appendFile(stderrLog, 'owner stderr history\n');
    await expect(run(harness, ['--uninstall'])).resolves.toBe('changed');

    expect(harness.loaded).toBe(false);
    expect(await exists(harness.paths.current)).toBe(false);
    expect(await exists(harness.paths.launchAgent)).toBe(false);
    expect(await exists(harness.paths.receipt)).toBe(false);
    expect(await exists(harness.paths.codexConfig)).toBe(false);
    expect(await exists(harness.paths.grokConfig)).toBe(false);
    expect(await exists(harness.paths.releases)).toBe(false);
    expect(await fs.readFile(stdoutLog, 'utf8')).toBe('owner stdout history\n');
    expect(await fs.readFile(stderrLog, 'utf8')).toBe('owner stderr history\n');
    expect((await fs.lstat(harness.paths.stateRoot)).mode & 0o777).toBe(0o700);
    await expect(run(harness, ['--uninstall'])).resolves.toBe('no-op');
    expect(await fs.readFile(stdoutLog, 'utf8')).toBe('owner stdout history\n');
    expect(await fs.readFile(stderrLog, 'utf8')).toBe('owner stderr history\n');
  });

  it('retains pxpipe-created config directories when owner bytes remain on uninstall', async () => {
    await run(harness);
    await fs.appendFile(harness.paths.codexConfig, '\nmodel = "owner-codex"\n');
    await fs.appendFile(harness.paths.grokConfig, '\n[owner]\nnote = "keep"\n');

    await expect(run(harness, ['--uninstall'])).resolves.toBe('changed');

    expect(await fs.readFile(harness.paths.codexConfig, 'utf8')).toContain('model = "owner-codex"');
    expect(await fs.readFile(harness.paths.grokConfig, 'utf8')).toContain('note = "keep"');
    expect((await fs.lstat(path.dirname(harness.paths.codexConfig))).isDirectory()).toBe(true);
    expect((await fs.lstat(path.dirname(harness.paths.grokConfig))).isDirectory()).toBe(true);
    expect(await fs.readFile(harness.paths.codexConfig, 'utf8')).not.toContain('/_pxpipe/codex');
    expect(await fs.readFile(harness.paths.grokConfig, 'utf8')).not.toContain('/_pxpipe/grok/v1');
  });

  it('rolls service state back and removes the new release after a health failure', async () => {
    harness.healthy = false;
    await expect(run(harness)).rejects.toThrow('did not become healthy');
    expect(harness.loaded).toBe(false);
    expect(await exists(harness.paths.current)).toBe(false);
    expect(await exists(harness.paths.launchAgent)).toBe(false);
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(false);
    expect(await exists(harness.paths.receipt)).toBe(false);
    expect(await exists(harness.paths.codexConfig)).toBe(false);
    expect(await exists(harness.paths.grokConfig)).toBe(false);
  });

  it('recovers process death after release materialization but before link switch', async () => {
    await expect(run(harness, [], {}, {
      checkpoint(name) {
        if (name === 'operation:after:materialize-release') {
          throw new InstallerCrashSimulation('death');
        }
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(true);
    expect(await exists(harness.paths.current)).toBe(false);

    await expect(run(harness, ['--uninstall'])).resolves.toBe('no-op');
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(false);
    expect(await exists(harness.paths.journal)).toBe(false);
  });

  it.each([
    { checkpoint: 'operation:after:switch-service', committed: false },
    { checkpoint: 'operation:after:apply-codex', committed: false },
    { checkpoint: 'operation:after:apply-grok', committed: false },
    { checkpoint: 'operation:after:validate-applied', committed: false },
    { checkpoint: 'receipt:after-rename', committed: true },
    { checkpoint: 'transaction:committed', committed: true },
  ])('recovers all eight resources after process death at $checkpoint', async ({ checkpoint, committed }) => {
    await expect(run(harness, [], {}, {
      checkpoint(name) {
        if (name === checkpoint) throw new InstallerCrashSimulation('death');
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    await expectJournalHasAllResources(harness);

    if (committed) {
      await expect(run(harness)).resolves.toBe('no-op');
      await expectCohesiveInstalledState(harness);
    } else {
      await expect(run(harness, ['--uninstall'])).resolves.toBe('no-op');
      await expectCohesiveAbsentState(harness);
    }
  });

  it('recognizes a committed uninstall after process death following receipt removal', async () => {
    await run(harness);
    await expect(run(harness, ['--uninstall'], {}, {
      checkpoint(name) {
        if (name === 'operation:after-receipt-commit') {
          throw new InstallerCrashSimulation('death');
        }
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect(await exists(harness.paths.receipt)).toBe(false);
    await expectJournalHasAllResources(harness);

    await expect(run(harness, ['--uninstall'])).resolves.toBe('no-op');
    await expectCohesiveAbsentState(harness);
  });

  it('turns SIGTERM into handled rollback instead of default process death', async () => {
    await expect(run(harness, [], {}, {
      checkpoint(name) {
        if (name === 'operation:after:switch-service') process.emit('SIGTERM');
      },
    }, true)).rejects.toThrow('interrupted by SIGTERM');
    expect(await exists(harness.paths.current)).toBe(false);
    expect(await exists(harness.paths.launchAgent)).toBe(false);
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(false);
    expect(await exists(harness.paths.receipt)).toBe(false);
  });

  it('restores pointer and plist before force-restarting the prior loaded service', async () => {
    await run(harness);
    const priorPointer = await fs.readlink(harness.paths.current);
    const priorPlist = await fs.readFile(harness.paths.launchAgent);
    const nextSource = 'b'.repeat(40);
    await setBundleSource(harness, nextSource);
    harness.unhealthyPorts.add(49124);

    await expect(run(harness, [], { PXPIPE_PORT: '49124' })).rejects.toThrow('did not become healthy');

    expect(await fs.readlink(harness.paths.current)).toBe(priorPointer);
    expect(await fs.readFile(harness.paths.launchAgent)).toEqual(priorPlist);
    expect(harness.bootstrapPointers.at(-1)).toBe(priorPointer);
    expect(await exists(path.join(harness.paths.releases, nextSource))).toBe(false);
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(true);
    expect(harness.loaded).toBe(true);
  });

  it('keeps the previous verified release after a successful update', async () => {
    await run(harness);
    const nextSource = 'd'.repeat(40);
    await setBundleSource(harness, nextSource);
    await expect(run(harness)).resolves.toBe('changed');
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(true);
    expect(await exists(path.join(harness.paths.releases, nextSource))).toBe(true);
    expect(await fs.readlink(harness.paths.current)).toBe(
      path.join(harness.paths.releases, nextSource),
    );
  });

  it('drains the receipt port before switching an update to a new port', async () => {
    await run(harness);
    harness.lingerOnStopPolls.set(47821, 2);
    const callStart = harness.calls.length;

    await expect(run(harness, [], { PXPIPE_PORT: '49124' })).resolves.toBe('changed');

    const updateCalls = harness.calls.slice(callStart);
    const bootout = updateCalls.findIndex((call) => call.startsWith('launchctl bootout'));
    const bootstrap = updateCalls.findIndex((call) => call.startsWith('launchctl bootstrap'));
    const oldPortPolls = updateCalls
      .slice(bootout + 1, bootstrap)
      .filter((call) => call.includes('lsof -w') && call.includes('-iTCP:47821'));
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(bootstrap).toBeGreaterThan(bootout);
    expect(oldPortPolls).toHaveLength(3);
  });

  it('drains the receipt port on uninstall even when PXPIPE_PORT differs', async () => {
    await run(harness, [], { PXPIPE_PORT: '49123' });
    harness.lingerOnStopPolls.set(49123, 1);
    const callStart = harness.calls.length;

    await expect(run(harness, ['--uninstall'], { PXPIPE_PORT: '49999' })).resolves.toBe('changed');

    const uninstallCalls = harness.calls.slice(callStart);
    const bootout = uninstallCalls.findIndex((call) => call.startsWith('launchctl bootout'));
    const afterStop = uninstallCalls.slice(bootout + 1);
    expect(afterStop.filter((call) => call.includes('lsof -w') && call.includes('-iTCP:49123')))
      .toHaveLength(2);
    expect(afterStop.some((call) => call.includes('-iTCP:49999'))).toBe(false);
  });

  it('replays committed cleanup from the durable receipt, not the next bundle', async () => {
    await run(harness);
    const committedSource = 'b'.repeat(40);
    await setBundleSource(harness, committedSource);
    await expect(run(harness, [], { PXPIPE_PORT: '49124' }, {
      checkpoint(name) {
        if (name === 'operation:after-receipt-commit') {
          throw new InstallerCrashSimulation('death');
        }
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect(await exists(harness.paths.journal)).toBe(true);

    const nextSource = 'c'.repeat(40);
    await setBundleSource(harness, nextSource);
    await fs.appendFile(harness.paths.grokConfig, '\n[endpoints.owner]\nmodels_base_url = "https://owner.invalid"\n');
    await expect(run(harness, [], { PXPIPE_PORT: '49124' })).rejects.toThrow('models_base_url');

    const receipt = JSON.parse(await fs.readFile(harness.paths.receipt, 'utf8')) as {
      payload: { sourceCommit: string };
    };
    expect(receipt.payload.sourceCommit).toBe(committedSource);
    expect(await exists(path.join(harness.paths.releases, committedSource))).toBe(true);
    expect(await exists(path.join(harness.paths.releases, nextSource))).toBe(false);
    expect(await exists(harness.paths.journal)).toBe(false);
  });

  it('rejects a healthy foreign or duplicate listener before curl acceptance', async () => {
    harness.listenerOutput = '9999\n4242\n';
    await expect(run(harness)).rejects.toThrow('not owned solely');
    expect(harness.loaded).toBe(false);
    expect(await exists(harness.paths.receipt)).toBe(false);
    expect(await exists(path.join(harness.paths.releases, SOURCE))).toBe(false);
  });

  it.each(['0.0.0.0', '[::1]', '*'])(
    'rejects a service listener bound to %s instead of exact IPv4 loopback',
    async (bindingAddress) => {
      harness.bindingAddress = bindingAddress;

      await expect(run(harness)).rejects.toThrow('not bound exactly to 127.0.0.1');

      expect(harness.calls.some((call) =>
        call.includes('lsof -w -nP -a -p 4242') && call.includes('-Fpn')
      )).toBe(true);
      expect(harness.loaded).toBe(false);
      expect(await exists(harness.paths.receipt)).toBe(false);
    },
  );

  it('retries a proven startup absence but still requires one matching job PID', async () => {
    harness.startupPrintMisses = 1;
    harness.listenerMisses = 1;
    await expect(run(harness)).resolves.toBe('changed');
    expect(harness.startupPrintMisses).toBe(0);
    expect(harness.listenerMisses).toBe(0);
    expect(harness.loaded).toBe(true);
  });

  it('rejects a managed footprint without a receipt before service mutation', async () => {
    await fs.mkdir(path.dirname(harness.paths.codexConfig), { recursive: true, mode: 0o700 });
    await fs.writeFile(harness.paths.codexConfig, 'model_provider = "pxpipe_local"\n', { mode: 0o600 });
    await expect(run(harness)).rejects.toThrow('managed client footprint exists without a receipt');
    expect(harness.calls.some((call) => call.startsWith('launchctl bootstrap'))).toBe(false);
    expect(await exists(harness.paths.launchAgent)).toBe(false);
  });

  it('rejects a loaded receipt-free label even when current and plist are absent', async () => {
    harness.loaded = true;

    await expect(run(harness)).rejects.toThrow('exists without managed artifacts');

    expect(harness.calls.some((call) => call.startsWith('tar '))).toBe(false);
    expect(harness.calls.some((call) => call.startsWith('launchctl bootout'))).toBe(false);
    expect(await exists(harness.paths.receipt)).toBe(false);
  });

  it('strictly adopts a healthy receipt-free local install before creating its ledger', async () => {
    await run(harness);
    const legacyAdoptionIdentity = await installedLegacyIdentity(harness);
    await fs.rm(harness.paths.receipt);
    await fs.rm(harness.paths.codexConfig);
    await fs.rm(harness.paths.grokConfig);
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;

    await expect(run(
      harness,
      [],
      {},
      undefined,
      false,
      legacyAdoptionIdentity,
    )).resolves.toBe('changed');

    expect(await exists(harness.paths.receipt)).toBe(true);
    expect(await exists(harness.paths.codexConfig)).toBe(true);
    expect(await exists(harness.paths.grokConfig)).toBe(true);
    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout')).length).toBeGreaterThan(bootouts);
    expect(harness.loaded).toBe(true);
  });

  it('drains the validated legacy port before first ledger install changes ports', async () => {
    await run(harness);
    const legacyAdoptionIdentity = await installedLegacyIdentity(harness);
    await fs.rm(harness.paths.receipt);
    await fs.rm(harness.paths.codexConfig);
    await fs.rm(harness.paths.grokConfig);
    harness.lingerOnStopPolls.set(47821, 2);
    const callStart = harness.calls.length;

    await expect(run(
      harness,
      [],
      { PXPIPE_PORT: '49124' },
      undefined,
      false,
      legacyAdoptionIdentity,
    )).resolves.toBe('changed');

    const adoptionCalls = harness.calls.slice(callStart);
    const bootout = adoptionCalls.findIndex((call) => call.startsWith('launchctl bootout'));
    const bootstrap = adoptionCalls.findIndex((call) => call.startsWith('launchctl bootstrap'));
    expect(adoptionCalls.slice(bootout + 1, bootstrap).filter((call) =>
      call.includes('lsof -w') && call.includes('-iTCP:47821')
    )).toHaveLength(3);
    expect(harness.activePort).toBe(49124);
  });

  it('accepts only the exact pinned legacy plist shape when the pinned identity matches', async () => {
    await run(harness);
    const legacyAdoptionIdentity = await installedLegacyIdentity(harness);
    const logs = path.join(harness.home, 'Library', 'Logs', 'pxpipe');
    const legacyPlist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.pxpipe.proxy</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>/usr/bin/node</string>\n    <string>${harness.paths.current}/bin/cli.js</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOST</key><string>127.0.0.1</string>\n    <key>PORT</key><string>47821</string>\n    <key>PXPIPE_MODELS</key><string>claude-fable-5,gpt-5.6-sol,grok-4.5</string>\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>${logs}/pxpipe.out.log</string>\n  <key>StandardErrorPath</key><string>${logs}/pxpipe.err.log</string>\n</dict>\n</plist>\n`;
    await fs.writeFile(harness.paths.launchAgent, legacyPlist, { mode: 0o600 });
    harness.loadedJob = loadedJobFromPlist(harness, legacyPlist);
    await fs.rm(harness.paths.receipt);
    await fs.rm(harness.paths.codexConfig);
    await fs.rm(harness.paths.grokConfig);

    await expect(run(
      harness,
      [],
      {},
      undefined,
      false,
      legacyAdoptionIdentity,
    )).resolves.toBe('changed');
  });

  it('rejects an unapproved legacy source when no test identity is injected', async () => {
    await run(harness);
    await fs.rm(harness.paths.receipt);
    await fs.rm(harness.paths.codexConfig);
    await fs.rm(harness.paths.grokConfig);
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;

    await expect(run(harness)).rejects.toThrow('not the approved legacy build');

    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout'))).toHaveLength(bootouts);
    expect(harness.loaded).toBe(true);
  });

  it('rejects a modified legacy release tree even when its manifest identity is pinned', async () => {
    await run(harness);
    const legacyAdoptionIdentity = await installedLegacyIdentity(harness);
    await fs.rm(harness.paths.receipt);
    await fs.rm(harness.paths.codexConfig);
    await fs.rm(harness.paths.grokConfig);
    await fs.appendFile(path.join(harness.paths.releases, SOURCE, 'dist', 'node.js'), '// drift\n');
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;

    await expect(run(
      harness,
      [],
      {},
      undefined,
      false,
      legacyAdoptionIdentity,
    )).rejects.toThrow('release tree is not the approved legacy build');

    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout'))).toHaveLength(bootouts);
    expect(harness.loaded).toBe(true);
  });

  it('refuses an unsafe receipt-free service before stopping it', async () => {
    await run(harness);
    const legacyAdoptionIdentity = await installedLegacyIdentity(harness);
    await fs.rm(harness.paths.receipt);
    await fs.rm(harness.paths.codexConfig);
    await fs.rm(harness.paths.grokConfig);
    await fs.writeFile(
      harness.paths.launchAgent,
      (await fs.readFile(harness.paths.launchAgent, 'utf8')).replace(
        '<key>HOST</key>\n      <string>127.0.0.1</string>',
        '<key>HOST</key>\n      <string>0.0.0.0</string>',
      ),
      { mode: 0o600 },
    );
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;

    await expect(run(
      harness,
      [],
      {},
      undefined,
      false,
      legacyAdoptionIdentity,
    )).rejects.toThrow('failed adoption checks');
    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout'))).toHaveLength(bootouts);
    expect(harness.loaded).toBe(true);
  });

  it('rejects a local log symlink before changing the service', async () => {
    const logDirectory = path.join(harness.home, 'Library', 'Logs', 'pxpipe');
    await fs.mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const ownerFile = path.join(harness.root, 'owner-log');
    await fs.writeFile(ownerFile, 'keep\n', { mode: 0o600 });
    await fs.symlink(ownerFile, path.join(logDirectory, 'pxpipe.out.log'));

    await expect(run(harness)).rejects.toThrow('local log is not an owner-safe regular file');
    expect(await fs.readFile(ownerFile, 'utf8')).toBe('keep\n');
    expect(harness.calls.some((call) => call.startsWith('launchctl bootstrap'))).toBe(false);
  });

  it('rejects unsafe LaunchAgent parents and client symlinks before mutation', async () => {
    const launchAgents = path.dirname(harness.paths.launchAgent);
    await fs.mkdir(launchAgents, { recursive: true, mode: 0o777 });
    await fs.chmod(launchAgents, 0o777);
    await expect(run(harness)).rejects.toThrow('LaunchAgent directory is unsafe');
    await fs.chmod(launchAgents, 0o700);

    await fs.mkdir(path.dirname(harness.paths.codexConfig), { mode: 0o700 });
    const target = path.join(harness.root, 'owner-config');
    await fs.writeFile(target, 'model = "owner"\n');
    await fs.symlink(target, harness.paths.codexConfig);
    await expect(run(harness)).rejects.toThrow('not a regular owner file');
    expect(harness.calls.some((call) => call.startsWith('launchctl bootstrap'))).toBe(false);
  });

  it('cleans only its fixed crash-debris names while holding the installer lock', async () => {
    await fs.mkdir(harness.paths.stateRoot, { recursive: true, mode: 0o700 });
    const candidate = path.join(harness.paths.stateRoot, `.candidate-${'b'.repeat(32)}`);
    const currentTemp = path.join(harness.paths.installRoot, `.current-${'c'.repeat(32)}`);
    const ownerFile = path.join(harness.paths.stateRoot, 'owner-data');
    await fs.mkdir(candidate);
    await fs.writeFile(currentTemp, 'debris');
    await fs.writeFile(ownerFile, 'keep');
    await expect(run(harness, ['--uninstall'])).resolves.toBe('no-op');
    expect(await exists(candidate)).toBe(false);
    expect(await exists(currentTemp)).toBe(false);
    expect(await fs.readFile(ownerFile, 'utf8')).toBe('keep');
  });

  it('rejects managed drift before stopping or changing the installed service', async () => {
    await run(harness);
    const plistBefore = await fs.readFile(harness.paths.launchAgent);
    const currentBefore = await fs.readlink(harness.paths.current);
    await fs.writeFile(
      harness.paths.codexConfig,
      (await fs.readFile(harness.paths.codexConfig, 'utf8')).replace(
        '/_pxpipe/codex',
        '/owner-change',
      ),
    );
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;

    await expect(run(harness, ['--uninstall'])).rejects.toThrow('drifted');
    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout'))).toHaveLength(bootouts);
    expect(await fs.readFile(harness.paths.launchAgent)).toEqual(plistBefore);
    expect(await fs.readlink(harness.paths.current)).toBe(currentBefore);
    expect(harness.loaded).toBe(true);
  });

  it('rejects a receipt whose recorded port disagrees with both managed URLs', async () => {
    await run(harness);
    const receipt = JSON.parse(await fs.readFile(harness.paths.receipt, 'utf8')) as {
      payload: { port: number };
    };
    receipt.payload.port = 50001;
    await fs.writeFile(harness.paths.receipt, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    const bootouts = harness.calls.filter((call) => call.startsWith('launchctl bootout')).length;
    await expect(run(harness, ['--uninstall'])).rejects.toThrow('URLs do not match');
    expect(harness.calls.filter((call) => call.startsWith('launchctl bootout'))).toHaveLength(bootouts);
    expect(harness.loaded).toBe(true);
  });

  it('does not ignore a real launchctl stop failure', async () => {
    await run(harness);
    harness.failStop = true;
    await expect(run(harness, ['--uninstall'])).rejects.toThrow('launchctl failed');
    expect(harness.loaded).toBe(true);
    expect(await exists(harness.paths.receipt)).toBe(true);
  });
});
