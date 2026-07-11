import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildClientParserSandboxProfile,
  runNoShellChild,
  runMacosClientParserValidationCli,
  validateMacosClientParsers,
  type MacosClientParserValidationOptions,
  type SandboxedInvocation,
  type SandboxRunner,
} from '../src/macos-client-parser-validation.js';
import { buildClientCandidate } from '../src/macos-local-config.js';
import { resolveMacosInstallerPaths, serializeReceipt, type CommandResult } from '../src/macos-local-installer.js';

const CODEX_VERSION = '0.144.1';
const CODEX_ARCH_VERSION = `${CODEX_VERSION}-darwin-arm64`;
const GROK_VERSION = '0.2.93';
const NONCE = '0123456789ab';
const UID = process.getuid?.() ?? process.geteuid?.() ?? 0;
const encoder = new TextEncoder();

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly bin: string;
  readonly codexLauncher: string;
  readonly codexNodeLauncher: string;
  readonly codexPackageRoot: string;
  readonly codexNative: string;
  readonly grokLauncher: string;
  readonly grokNative: string;
  readonly codexConfig: string;
  readonly grokConfig: string;
  readonly defaultSocket: string;
  readonly calls: SandboxedInvocation[];
  options: MacosClientParserValidationOptions;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function commandResult(code = 0, stdout = '', stderr = ''): CommandResult {
  return { code, stdout: encoder.encode(stdout), stderr: encoder.encode(stderr) };
}

function arm64MachO(marker: string): Uint8Array {
  const bytes = Buffer.alloc(64 + Buffer.byteLength(marker));
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.write(marker, 64);
  return bytes;
}

async function write(file: string, bytes: string | Uint8Array, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, bytes, { mode });
  await fs.chmod(file, mode);
}

async function makeFixture(): Promise<Fixture> {
  const root = await fs.mkdtemp('/tmp/ppv-');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await fs.mkdir(home, { mode: 0o700 });
  await fs.chmod(home, 0o700);
  await fs.mkdir(bin, { mode: 0o700 });

  const codexPackageRoot = path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const codexNodeLauncher = path.join(codexPackageRoot, 'bin', 'codex.js');
  const codexArchitectureRoot = path.join(codexPackageRoot, 'node_modules', '@openai', 'codex-darwin-arm64');
  const codexNative = path.join(codexArchitectureRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
  await write(codexNodeLauncher, '#!/usr/bin/env node\n// synthetic launcher\n', 0o755);
  await write(path.join(codexPackageRoot, 'package.json'), `${JSON.stringify({
    name: '@openai/codex',
    version: CODEX_VERSION,
    optionalDependencies: {
      '@openai/codex-darwin-arm64': `npm:@openai/codex@${CODEX_ARCH_VERSION}`,
    },
  })}\n`, 0o644);
  await write(path.join(codexArchitectureRoot, 'package.json'), `${JSON.stringify({
    name: '@openai/codex',
    version: CODEX_ARCH_VERSION,
    os: ['darwin'],
    cpu: ['arm64'],
  })}\n`, 0o644);
  await write(codexNative, arm64MachO('synthetic codex'), 0o755);
  const codexLauncher = path.join(bin, 'codex');
  await fs.symlink(codexNodeLauncher, codexLauncher);

  const grokNative = path.join(home, '.grok', 'downloads', `grok-${GROK_VERSION}-macos-aarch64`);
  await write(grokNative, arm64MachO('synthetic grok'), 0o755);
  const grokInnerLauncher = path.join(home, '.grok', 'bin', 'grok');
  await fs.mkdir(path.dirname(grokInnerLauncher), { recursive: true, mode: 0o700 });
  await fs.symlink(grokNative, grokInnerLauncher);
  const grokLauncher = path.join(bin, 'grok');
  await fs.symlink(grokInnerLauncher, grokLauncher);

  const codexConfig = path.join(home, '.codex', 'config.toml');
  const grokConfig = path.join(home, '.grok', 'config.toml');
  const codexBytes = encoder.encode('model = "gpt-5.6-sol"\nmodel_provider = "pxpipe_local"\n');
  const grokBytes = encoder.encode('[models]\ndefault = "grok-4.5"\n');
  await write(codexConfig, codexBytes, 0o600);
  await write(grokConfig, grokBytes, 0o644);
  const defaultSocket = path.join(home, '.grok', 'leader.sock');
  await write(defaultSocket, 'owner sentinel\n', 0o600);

  const calls: SandboxedInvocation[] = [];
  const sandboxRunner: SandboxRunner = async (invocation) => {
    calls.push(invocation);
    if (invocation.args.length === 1 && invocation.args[0] === '--version') {
      return commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}\n` : `grok ${GROK_VERSION}\n`);
    }
    return commandResult(0, 'discarded secret output', 'discarded secret diagnostics');
  };
  const options: MacosClientParserValidationOptions = {
    ownerHome: home,
    codexConfig,
    grokConfig,
    expectedCodexConfig: { sha256: hash(codexBytes), mode: 0o600 },
    expectedGrokConfig: { sha256: hash(grokBytes), mode: 0o644 },
    expectedCodexVersion: CODEX_VERSION,
    expectedGrokVersion: GROK_VERSION,
    codexLauncher,
    grokLauncher,
    pathEnvironment: bin,
    platform: 'darwin',
    architecture: 'arm64',
    uid: UID,
    nonce: () => NONCE,
    sandboxRunner,
  };
  return {
    root,
    home,
    bin,
    codexLauncher,
    codexNodeLauncher,
    codexPackageRoot,
    codexNative,
    grokLauncher,
    grokNative,
    codexConfig,
    grokConfig,
    defaultSocket,
    calls,
    options,
  };
}

describe('offline macOS client parser validation', () => {
  let target: Fixture;

  beforeEach(async () => {
    target = await makeFixture();
  });

  afterEach(async () => {
    await fs.rm(target.root, { recursive: true, force: true });
  });

  it('runs only staged native copies with exact parser arguments and isolated bytes', async () => {
    const result = await validateMacosClientParsers(target.options);

    expect(target.calls).toHaveLength(4);
    expect(target.calls.map((call) => call.args)).toEqual([
      ['--version'],
      ['--version'],
      ['features', 'list'],
      ['inspect', '--json', '--leader-socket', path.join(target.home, '.pxpipe-s', NONCE, 's')],
    ]);
    expect(target.calls.map((call) => call.outputPolicy)).toEqual([
      { kind: 'capture-version', maxCombinedBytes: 512 },
      { kind: 'capture-version', maxCombinedBytes: 512 },
      { kind: 'discard' },
      { kind: 'discard' },
    ]);
    expect(target.calls.every((call) => call.executable.startsWith(path.join(target.home, '.pxpipe-s', NONCE, 'bin')))).toBe(true);
    expect(target.calls.every((call) => call.executable !== target.codexNative && call.executable !== target.grokNative)).toBe(true);
    expect(result.codex).toMatchObject({ sourcePath: await fs.realpath(target.codexNative), version: CODEX_VERSION, mode: 0o755 });
    expect(result.grok).toMatchObject({ sourcePath: await fs.realpath(target.grokNative), version: GROK_VERSION, mode: 0o755 });
    expect(Object.values(result).join(' ')).not.toContain('discarded secret');

    const first = target.calls[0]!;
    expect(first.env).toEqual({
      HOME: path.join(target.home, '.pxpipe-s', NONCE, 'home'),
      CODEX_HOME: path.join(target.home, '.pxpipe-s', NONCE, 'home', '.codex'),
      XDG_CONFIG_HOME: path.join(target.home, '.pxpipe-s', NONCE, 'home', '.config'),
      PATH: path.join(target.home, '.pxpipe-s', NONCE, 'bin'),
      TMPDIR: `${path.join(target.home, '.pxpipe-s', NONCE, 'tmp')}${path.sep}`,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NO_COLOR: '1',
      TERM: 'dumb',
    });
    expect(await fs.readFile(target.codexConfig, 'utf8')).toBe('model = "gpt-5.6-sol"\nmodel_provider = "pxpipe_local"\n');
    expect(await fs.readFile(target.grokConfig, 'utf8')).toBe('[models]\ndefault = "grok-4.5"\n');
    expect(await fs.readFile(target.defaultSocket, 'utf8')).toBe('owner sentinel\n');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('builds deny-by-default profiles with only the staged executable and exact private socket', async () => {
    await validateMacosClientParsers(target.options);
    const codexProfile = target.calls[0]!.profile;
    const grokCall = target.calls[3]!;
    const socket = grokCall.args[3]!;

    for (const profile of [codexProfile, grokCall.profile]) {
      expect(profile).toContain('(deny default)');
      expect(profile).toContain('(deny network*)');
      expect(profile).toContain('(deny process-fork)');
      expect(profile).toContain('(deny process-exec)');
      expect(profile).toContain('(deny file-read*)');
      expect(profile).toContain('(deny file-write*)');
      expect(profile).toContain('(allow file-read-data (literal "/"))');
      expect(profile).not.toContain('(allow file-read* (literal "/"))');
      expect(profile).not.toContain(target.codexNative);
      expect(profile).not.toContain(target.grokNative);
      expect(profile).not.toContain(path.join(target.home, '.grok', 'leader.sock'));
    }
    expect(codexProfile).not.toContain('(allow network-');
    expect(grokCall.profile).toContain(`(allow network-bind (local unix-socket (literal "${socket}")))`);
    expect(grokCall.profile).toContain(`(allow network-inbound (local unix-socket (literal "${socket}")))`);
    expect(grokCall.profile).toContain(`(allow network-outbound (remote unix-socket (literal "${socket}")))`);
    expect(Buffer.byteLength(socket, 'utf8')).toBeLessThanOrEqual(90);
  });

  it('stages byte-identical TOML as 0600 without changing installed modes', async () => {
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        target.calls.push(invocation);
        const isolatedHome = invocation.env.HOME!;
        expect(await fs.readFile(path.join(isolatedHome, '.codex', 'config.toml')))
          .toEqual(await fs.readFile(target.codexConfig));
        expect(await fs.readFile(path.join(isolatedHome, '.grok', 'config.toml')))
          .toEqual(await fs.readFile(target.grokConfig));
        expect((await fs.stat(path.join(isolatedHome, '.codex', 'config.toml'))).mode & 0o777).toBe(0o600);
        expect((await fs.stat(path.join(isolatedHome, '.grok', 'config.toml'))).mode & 0o777).toBe(0o600);
        return invocation.args[0] === '--version'
          ? commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}` : `grok ${GROK_VERSION}`)
          : commandResult();
      },
    };
    await validateMacosClientParsers(target.options);
    expect((await fs.stat(target.codexConfig)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(target.grokConfig)).mode & 0o777).toBe(0o644);
  });

  it('resolves both launchers from a supplied PATH without a shell', async () => {
    target.options = { ...target.options, codexLauncher: undefined, grokLauncher: undefined };
    await expect(validateMacosClientParsers(target.options)).resolves.toMatchObject({
      codex: { sourcePath: await fs.realpath(target.codexNative) },
      grok: { sourcePath: await fs.realpath(target.grokNative) },
    });
  });

  it('loads exact candidate hashes and modes from the strict installer receipt', async () => {
    const paths = resolveMacosInstallerPaths(target.home);
    const codex = buildClientCandidate('codex', null, 47_821);
    const grok = buildClientCandidate('grok', null, 47_821);
    const receipt = {
      schemaVersion: 1,
      sourceCommit: 'a'.repeat(40),
      version: 'fixture',
      archiveSha256: 'b'.repeat(64),
      releaseTreeSha256: 'c'.repeat(64),
      port: 47_821,
      nodeExecutable: '/usr/bin/node',
      codex: { config: codex.receipt, fileMode: 0o600, directoryExisted: false, directoryMode: 0o700 },
      grok: { config: grok.receipt, fileMode: 0o600, directoryExisted: false, directoryMode: 0o700 },
    };
    await write(paths.receipt, serializeReceipt('f'.repeat(32), receipt), 0o600);
    let captured: MacosClientParserValidationOptions | undefined;
    const output: string[] = [];
    await runMacosClientParserValidationCli([], { HOME: target.home, PATH: target.bin }, {
      uid: UID,
      output: (line) => output.push(line),
      validator: async (options) => {
        captured = options;
        return {
          codex: { sourcePath: '/staged/codex', sha256: 'd'.repeat(64), mode: 0o755, version: CODEX_VERSION },
          grok: { sourcePath: '/staged/grok', sha256: 'e'.repeat(64), mode: 0o755, version: GROK_VERSION },
        };
      },
    });
    expect(captured).toMatchObject({
      ownerHome: target.home,
      codexConfig: target.codexConfig,
      grokConfig: target.grokConfig,
      expectedCodexConfig: { sha256: codex.receipt.appliedFileSha256, mode: 0o600 },
      expectedGrokConfig: { sha256: grok.receipt.appliedFileSha256, mode: 0o600 },
      pathEnvironment: target.bin,
    });
    expect(captured).not.toHaveProperty('expectedCodexVersion');
    expect(captured).not.toHaveProperty('expectedGrokVersion');
    expect(output).toEqual(['✓ Codex and Grok configuration parsers passed offline validation.']);
  });

  it('rejects a corrupt or unsafe receipt before invoking the validator', async () => {
    const paths = resolveMacosInstallerPaths(target.home);
    await write(paths.receipt, '{}\n', 0o644);
    let invoked = false;
    await expect(runMacosClientParserValidationCli([], { HOME: target.home, PATH: target.bin }, {
      uid: UID,
      output: () => undefined,
      validator: async () => {
        invoked = true;
        throw new Error('must not run');
      },
    })).rejects.toThrow('receipt mode is unsafe');
    expect(invoked).toBe(false);
  });

  it('rejects a bare payload instead of accepting it as an installer receipt', async () => {
    const paths = resolveMacosInstallerPaths(target.home);
    await write(paths.receipt, '{"schemaVersion":1}\n', 0o600);
    await expect(runMacosClientParserValidationCli([], { HOME: target.home, PATH: target.bin }, {
      uid: UID,
      output: () => undefined,
      validator: async () => { throw new Error('must not run'); },
    })).rejects.toThrow('installer receipt has an invalid schema');
  });

  it('keeps the developer command argument-free', async () => {
    await expect(runMacosClientParserValidationCli(['--codex-version', CODEX_VERSION], { HOME: target.home }, {
      uid: UID,
      output: () => undefined,
    })).rejects.toThrow('usage: pnpm validate:macos-clients');
  });

  it('retains a pre-existing private base but removes its validation child', async () => {
    const base = path.join(target.home, '.pxpipe-s');
    await fs.mkdir(base, { mode: 0o700 });
    await fs.chmod(base, 0o700);
    await validateMacosClientParsers(target.options);
    expect((await fs.stat(base)).isDirectory()).toBe(true);
    expect(await fs.readdir(base)).toEqual([]);
  });

  it('fails before mutation when the socket path exceeds 90 UTF-8 bytes', async () => {
    const longRoot = await fs.mkdtemp(path.join(os.tmpdir(), `pxpipe-${'é'.repeat(30)}-`));
    const longHome = path.join(longRoot, 'home');
    await fs.mkdir(longHome, { mode: 0o700 });
    const options = {
      ...target.options,
      ownerHome: longHome,
      codexConfig: path.join(longHome, '.codex', 'config.toml'),
      grokConfig: path.join(longHome, '.grok', 'config.toml'),
    };
    try {
      await expect(validateMacosClientParsers(options)).rejects.toThrow('exceeds 90 UTF-8 bytes');
      await expect(fs.lstat(path.join(longHome, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(target.calls).toHaveLength(0);
    } finally {
      await fs.rm(longRoot, { recursive: true, force: true });
    }
  });

  it('rejects a nonce collision without deleting the existing directory', async () => {
    const collision = path.join(target.home, '.pxpipe-s', NONCE);
    await fs.mkdir(collision, { recursive: true, mode: 0o700 });
    await fs.chmod(path.join(target.home, '.pxpipe-s'), 0o700);
    await fs.chmod(collision, 0o700);
    await fs.writeFile(path.join(collision, 'owner'), 'keep');
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('already exists');
    expect(await fs.readFile(path.join(collision, 'owner'), 'utf8')).toBe('keep');
    expect(target.calls).toHaveLength(0);
  });

  it('rejects an unsafe private base without invoking a client', async () => {
    const base = path.join(target.home, '.pxpipe-s');
    await fs.mkdir(base, { mode: 0o755 });
    await fs.chmod(base, 0o755);
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('private validation directory is unsafe');
    expect((await fs.stat(base)).mode & 0o777).toBe(0o755);
    expect(target.calls).toHaveLength(0);
  });

  it('removes a private base it created when post-create mode validation fails', async () => {
    const priorUmask = process.umask(0o777);
    try {
      await expect(validateMacosClientParsers(target.options)).rejects.toThrow('private validation directory is unsafe');
      await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(target.calls).toHaveLength(0);
    } finally {
      process.umask(priorUmask);
    }
  });

  it('requires exact fixed installed config paths', async () => {
    target.options = { ...target.options, codexConfig: path.join(target.home, 'copy.toml') };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('fixed owner paths');
    expect(target.calls).toHaveLength(0);
  });

  it.each([
    ['hash', { sha256: '0'.repeat(64), mode: 0o600 }],
    ['mode', { sha256: '', mode: 0o644 }],
  ])('rejects an installed config %s mismatch before creating state', async (_label, identity) => {
    target.options = {
      ...target.options,
      expectedCodexConfig: {
        sha256: identity.sha256 === '' ? target.options.expectedCodexConfig.sha256 : identity.sha256,
        mode: identity.mode,
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('does not match the parsed install candidate');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(target.calls).toHaveLength(0);
  });

  it('rejects a config symlink before creating state', async () => {
    const owner = `${target.codexConfig}.owner`;
    await fs.rename(target.codexConfig, owner);
    await fs.symlink(owner, target.codexConfig);
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('symbolic link');
    expect(target.calls).toHaveLength(0);
  });

  it('requires the Codex launcher to be a Node package launcher', async () => {
    await fs.writeFile(target.codexNodeLauncher, '#!/bin/sh\nexit 0\n');
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('not a Node launcher');
    expect(target.calls).toHaveLength(0);
  });

  it('requires exact Codex package and architecture-package versions', async () => {
    await fs.writeFile(path.join(target.codexPackageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.1.0' }));
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('does not match');
    expect(target.calls).toHaveLength(0);
  });

  it('requires the root package to bind the architecture alias to the exact suffixed package', async () => {
    await fs.writeFile(path.join(target.codexPackageRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      version: CODEX_VERSION,
      optionalDependencies: {
        '@openai/codex-darwin-arm64': `npm:@openai/codex@${CODEX_VERSION}`,
      },
    }));
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('bind the architecture alias exactly');
    expect(target.calls).toHaveLength(0);
  });

  it.each([
    ['alias package name', { name: '@openai/codex-darwin-arm64', version: CODEX_ARCH_VERSION, os: ['darwin'], cpu: ['arm64'] }, 'expected identity'],
    ['architecture version suffix', { name: '@openai/codex', version: CODEX_VERSION, os: ['darwin'], cpu: ['arm64'] }, 'expected identity'],
    ['macOS restriction', { name: '@openai/codex', version: CODEX_ARCH_VERSION, os: ['linux'], cpu: ['arm64'] }, 'platform metadata'],
    ['CPU restriction', { name: '@openai/codex', version: CODEX_ARCH_VERSION, os: ['darwin'], cpu: ['x64'] }, 'platform metadata'],
  ])('rejects invalid Codex architecture-package %s', async (_label, manifest, message) => {
    const architecturePackage = path.join(
      target.codexPackageRoot, 'node_modules', '@openai', 'codex-darwin-arm64', 'package.json',
    );
    await fs.writeFile(architecturePackage, JSON.stringify(manifest));
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow(message);
    expect(target.calls).toHaveLength(0);
  });

  it('supports a direct embedded vendor payload without an architecture alias', async () => {
    const architectureRoot = path.join(target.codexPackageRoot, 'node_modules', '@openai', 'codex-darwin-arm64');
    await fs.rm(architectureRoot, { recursive: true });
    await fs.writeFile(path.join(target.codexPackageRoot, 'package.json'), JSON.stringify({
      name: '@openai/codex',
      version: CODEX_VERSION,
    }));
    const directNative = path.join(
      target.codexPackageRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex',
    );
    await write(directNative, arm64MachO('direct synthetic codex'), 0o755);
    await expect(validateMacosClientParsers(target.options)).resolves.toMatchObject({
      codex: { sourcePath: await fs.realpath(directNative), version: CODEX_VERSION },
    });
  });

  it('rejects ambiguous Codex native payloads', async () => {
    const duplicate = path.join(target.codexPackageRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
    await write(duplicate, arm64MachO('duplicate'), 0o755);
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('did not resolve uniquely');
    expect(target.calls).toHaveLength(0);
  });

  it.each([
    ['non-Mach-O', encoder.encode('not a binary')],
    ['wrong architecture', (() => {
      const bytes = Buffer.from(arm64MachO('wrong'));
      bytes.writeUInt32LE(0x01000007, 4);
      return bytes;
    })()],
  ])('rejects a %s native payload', async (_label, bytes) => {
    await fs.writeFile(target.codexNative, bytes);
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow(/Mach-O|architecture/u);
    expect(target.calls).toHaveLength(0);
  });

  it('rejects a Grok target whose filename does not bind the expected version', async () => {
    const wrong = path.join(path.dirname(target.grokNative), 'grok-9.9.9-macos-aarch64');
    await fs.rename(target.grokNative, wrong);
    await fs.rm(target.grokLauncher);
    await fs.symlink(wrong, target.grokLauncher);
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('filename does not match');
    expect(target.calls).toHaveLength(0);
  });

  it('rejects group/world-writable native executables', async () => {
    await fs.chmod(target.grokNative, 0o775);
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('group/world writable');
    expect(target.calls).toHaveLength(0);
  });

  it('fails closed and cleans up on an exact version mismatch', async () => {
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => invocation.args[0] === '--version'
        ? commandResult(0, invocation.label === 'Codex' ? 'codex-cli 9.9.9' : `grok ${GROK_VERSION}`)
        : commandResult(),
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('did not report expected version');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a parser exits nonzero without exposing its output', async () => {
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        if (invocation.args[0] === '--version') {
          return commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}` : `grok ${GROK_VERSION}`);
        }
        return commandResult(71, 'SECRET-STDOUT', 'SECRET-STDERR');
      },
    };
    let thrown: unknown;
    try {
      await validateMacosClientParsers(target.options);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('parser check failed with exit 71');
    expect(String(thrown)).not.toContain('SECRET');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects writes into the initially empty working directory', async () => {
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        if (invocation.args[0] === '--version' && invocation.label === 'Codex') {
          await fs.writeFile(path.join(invocation.cwd, 'unexpected'), 'x');
          return commandResult(0, `codex-cli ${CODEX_VERSION}`);
        }
        return commandResult(0, `grok ${GROK_VERSION}`);
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('empty validation working directory');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects installed config mutation even when the sandbox runner fails', async () => {
    target.options = {
      ...target.options,
      sandboxRunner: async () => {
        await fs.writeFile(target.grokConfig, 'changed\n');
        throw new Error('synthetic runner failure');
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('Grok config hash or mode changed');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects installed native mutation after staging', async () => {
    let changed = false;
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        if (!changed) {
          changed = true;
          await fs.appendFile(target.codexNative, 'changed');
        }
        return invocation.args[0] === '--version'
          ? commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}` : `grok ${GROK_VERSION}`)
          : commandResult();
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('Codex native executable hash or mode changed');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects a Codex architecture-package symlink retarget after native resolution', async () => {
    const architectureRoot = path.join(target.codexPackageRoot, 'node_modules', '@openai', 'codex-darwin-arm64');
    const firstRoot = `${architectureRoot}-first`;
    const secondRoot = `${architectureRoot}-second`;
    await fs.rename(architectureRoot, firstRoot);
    await fs.symlink(firstRoot, architectureRoot, 'dir');
    await write(path.join(secondRoot, 'package.json'), `${JSON.stringify({
      name: '@openai/codex',
      version: CODEX_ARCH_VERSION,
      os: ['darwin'],
      cpu: ['arm64'],
    })}\n`, 0o644);
    await write(
      path.join(secondRoot, 'vendor', 'aarch64-apple-darwin', 'bin', 'codex'),
      arm64MachO('replacement codex'),
      0o755,
    );
    let retargeted = false;
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        if (!retargeted) {
          retargeted = true;
          await fs.rm(architectureRoot);
          await fs.symlink(secondRoot, architectureRoot, 'dir');
        }
        if (invocation.args[0] === '--version') {
          return commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}` : `grok ${GROK_VERSION}`);
        }
        return commandResult();
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('Codex native candidate target changed');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a staged config mutation performed by a version invocation', async () => {
    let changed = false;
    let invocations = 0;
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        invocations += 1;
        if (!changed) {
          changed = true;
          await fs.appendFile(path.join(invocation.env.HOME!, '.grok', 'config.toml'), 'changed');
        }
        return commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}` : `grok ${GROK_VERSION}`);
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('staged Grok config hash or mode changed');
    expect(invocations).toBe(1);
    expect(await fs.readFile(target.grokConfig, 'utf8')).toBe('[models]\ndefault = "grok-4.5"\n');
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a staged executable mutation performed by a parser invocation', async () => {
    const sourceHash = hash(await fs.readFile(target.codexNative));
    target.options = {
      ...target.options,
      sandboxRunner: async (invocation) => {
        if (invocation.args[0] === 'features') {
          await fs.appendFile(invocation.executable, 'changed');
          return commandResult();
        }
        if (invocation.args[0] === '--version') {
          return commandResult(0, invocation.label === 'Codex' ? `codex-cli ${CODEX_VERSION}` : `grok ${GROK_VERSION}`);
        }
        return commandResult();
      },
    };
    await expect(validateMacosClientParsers(target.options)).rejects.toThrow('staged Codex executable hash or mode changed');
    expect(hash(await fs.readFile(target.codexNative))).toBe(sourceHash);
    await expect(fs.lstat(path.join(target.home, '.pxpipe-s'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('sandbox profile input validation', () => {
  it('rejects path injection and sockets outside the private root', () => {
    expect(() => buildClientParserSandboxProfile('/tmp/bin\n(allow default)', '/tmp/home', '/tmp/home/root'))
      .toThrow('unsupported character');
    expect(() => buildClientParserSandboxProfile('/tmp/bin', '/tmp/home', '/tmp/home/root', '/tmp/home/other/s'))
      .toThrow('directly inside');
    expect(() => buildClientParserSandboxProfile('/tmp/bin', '/tmp/home', '/tmp/home'))
      .toThrow('outside the owner home');
    expect(() => buildClientParserSandboxProfile('/tmp/bin', '/tmp/home', '/tmp'))
      .toThrow('outside the owner home');
  });
});

describe('bounded no-shell child runner', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-child-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the exact cwd/env, ignores stdin, and passes shell characters literally', async () => {
    const script = [
      "let input = '';",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => process.stdout.write(JSON.stringify({ cwd: process.cwd(), only: process.env.PXPIPE_SYNTHETIC, home: process.env.HOME ?? null, arg: process.argv[1], stdin: input.length })));",
    ].join('');
    const result = await runNoShellChild({
      command: process.execPath,
      args: ['-e', script, '$HOME;echo injected'],
      cwd: root,
      env: { PXPIPE_SYNTHETIC: 'yes' },
      label: 'synthetic capture',
      timeoutMilliseconds: 2_000,
      outputPolicy: { kind: 'capture-version', maxCombinedBytes: 1_024 },
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      cwd: await fs.realpath(root),
      only: 'yes',
      home: null,
      arg: '$HOME;echo injected',
      stdin: 0,
    });
    expect(result.stderr).toHaveLength(0);
  });

  it('routes parser stdout and stderr to the operating-system discard sink', async () => {
    const result = await runNoShellChild({
      command: process.execPath,
      args: ['-e', [
        "const fs = require('node:fs');",
        "if (!fs.fstatSync(1).isCharacterDevice() || !fs.fstatSync(2).isCharacterDevice()) process.exit(71);",
        "process.stdout.write('S'.repeat(1000000)); process.stderr.write('E'.repeat(1000000));",
      ].join('')],
      cwd: root,
      env: {},
      label: 'synthetic parser',
      timeoutMilliseconds: 2_000,
      outputPolicy: { kind: 'discard' },
    });
    expect(result).toEqual({ code: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  });

  it('kills version output at the strict combined cap without exposing content', async () => {
    let pid = 0;
    let thrown: unknown;
    try {
      await runNoShellChild({
        command: process.execPath,
        args: ['-e', "process.stdout.write('ULTRASECRET'.repeat(20)); setInterval(() => {}, 1000);"],
        cwd: root,
        env: {},
        label: 'synthetic version',
        timeoutMilliseconds: 2_000,
        outputPolicy: { kind: 'capture-version', maxCombinedBytes: 64 },
        onSpawn: (value) => { pid = value; },
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('version output exceeded the byte limit');
    expect(String(thrown)).not.toContain('ULTRASECRET');
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('kills a hung child at the fixed timeout without exposing output', async () => {
    let pid = 0;
    let thrown: unknown;
    const started = Date.now();
    try {
      await runNoShellChild({
        command: process.execPath,
        args: ['-e', "process.stderr.write('TIMEOUTSECRET'); setInterval(() => {}, 1000);"],
        cwd: root,
        env: {},
        label: 'synthetic parser',
        timeoutMilliseconds: 75,
        outputPolicy: { kind: 'discard' },
        onSpawn: (value) => { pid = value; },
      });
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('synthetic parser timed out');
    expect(String(thrown)).not.toContain('TIMEOUTSECRET');
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
