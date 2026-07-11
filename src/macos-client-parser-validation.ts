/**
 * Offline parser validation for installed macOS Codex and Grok clients.
 *
 * The installed launchers are never executed. Native Mach-O payloads and the
 * two already-installed TOML files are copied into one private disposable
 * directory, then only those copies run under a restrictive sandbox profile.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateLocalInstallReceipt } from './macos-local-install-app.js';
import {
  parseStrictReceiptBytes,
  resolveMacosInstallerPaths,
  type CommandResult,
} from './macos-local-installer.js';

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const NONCE = /^[0-9a-f]{12}$/u;
const SOCKET_BUDGET_BYTES = 90;
const VERSION_OUTPUT_LIMIT_BYTES = 512;
const SANDBOX_TIMEOUT_MILLISECONDS = 15_000;

export class ClientParserValidationError extends Error {
  override readonly name = 'ClientParserValidationError';
}

export interface InstalledFileIdentity {
  readonly sha256: string;
  readonly mode: number;
}

export interface SandboxedInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly profile: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly label: string;
  readonly outputPolicy:
    | { readonly kind: 'capture-version'; readonly maxCombinedBytes: number }
    | { readonly kind: 'discard' };
}

export type SandboxRunner = (invocation: SandboxedInvocation) => Promise<CommandResult>;

export interface NoShellChildInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly label: string;
  readonly timeoutMilliseconds: number;
  readonly outputPolicy: SandboxedInvocation['outputPolicy'];
  /** Test observation only; production does not supply it. */
  readonly onSpawn?: (pid: number) => void;
}

export interface MacosClientParserValidationOptions {
  readonly ownerHome: string;
  readonly codexConfig: string;
  readonly grokConfig: string;
  readonly expectedCodexConfig: InstalledFileIdentity;
  readonly expectedGrokConfig: InstalledFileIdentity;
  /** Optional validation-only pins. Production derives this from exact installed package metadata. */
  readonly expectedCodexVersion?: string;
  /** Optional validation-only pins. Production derives this from the resolved versioned Mach-O name. */
  readonly expectedGrokVersion?: string;
  readonly codexLauncher?: string;
  readonly grokLauncher?: string;
  readonly pathEnvironment?: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly uid?: number;
  readonly nonce?: () => string;
  readonly sandboxExec?: string;
  readonly sandboxRunner?: SandboxRunner;
}

export interface ValidatedNativeClient {
  readonly sourcePath: string;
  readonly sha256: string;
  readonly mode: number;
  readonly version: string;
}

export interface MacosClientParserValidationResult {
  readonly codex: ValidatedNativeClient;
  readonly grok: ValidatedNativeClient;
}

interface StableFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mode: number;
  readonly uid: number;
}

interface ResolvedClient {
  readonly native: StableFile;
  readonly version: string;
  readonly verifyUnchanged: () => Promise<void>;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function currentUid(): number {
  const uid = process.getuid?.() ?? process.geteuid?.();
  if (uid === undefined) throw new ClientParserValidationError('cannot determine the current user');
  return uid;
}

function validateMode(mode: number, label: string): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new ClientParserValidationError(`${label} mode is invalid`);
  }
  return mode;
}

function validateExpectedIdentity(value: InstalledFileIdentity, label: string): InstalledFileIdentity {
  if (!SHA256.test(value.sha256)) {
    throw new ClientParserValidationError(`${label} expected hash is invalid`);
  }
  return { sha256: value.sha256, mode: validateMode(value.mode, label) };
}

async function readStableRegularFile(
  file: string,
  options: { readonly ownerUid?: number; readonly executable?: boolean; readonly label: string },
): Promise<StableFile> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errno(error) === 'ELOOP') {
      throw new ClientParserValidationError(`${options.label} resolves to a symbolic link`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    const mode = before.mode & 0o777;
    if (!before.isFile()) throw new ClientParserValidationError(`${options.label} is not a regular file`);
    if (options.ownerUid !== undefined && before.uid !== options.ownerUid) {
      throw new ClientParserValidationError(`${options.label} is not owned by the current user`);
    }
    if (options.executable === true && (mode & 0o111) === 0) {
      throw new ClientParserValidationError(`${options.label} is not executable`);
    }
    if (options.executable === true && (mode & 0o022) !== 0) {
      throw new ClientParserValidationError(`${options.label} is group/world writable`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== after.size
    ) throw new ClientParserValidationError(`${options.label} changed while it was read`);
    return { path: file, bytes, sha256: digest(bytes), mode, uid: after.uid };
  } finally {
    await handle.close();
  }
}

async function assertHashAndModeUnchanged(snapshot: StableFile, label: string): Promise<void> {
  const current = await readStableRegularFile(snapshot.path, { label });
  if (current.sha256 !== snapshot.sha256 || current.mode !== snapshot.mode) {
    throw new ClientParserValidationError(`${label} hash or mode changed during validation`);
  }
}

function validateMachO(bytes: Uint8Array, architecture: NodeJS.Architecture, label: string): void {
  if (bytes.byteLength < 8) throw new ClientParserValidationError(`${label} is not a complete Mach-O file`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const wanted = architecture === 'arm64' ? 0x0100000c
    : architecture === 'x64' ? 0x01000007
      : undefined;
  if (wanted === undefined) throw new ClientParserValidationError(`unsupported macOS architecture: ${architecture}`);
  const magic = view.getUint32(0, false);
  if (magic === 0xfeedfacf || magic === 0xfeedface) {
    if (view.getUint32(4, false) !== wanted) {
      throw new ClientParserValidationError(`${label} has the wrong Mach-O architecture`);
    }
    return;
  }
  if (magic === 0xcffaedfe || magic === 0xcefaedfe) {
    if (view.getUint32(4, true) !== wanted) {
      throw new ClientParserValidationError(`${label} has the wrong Mach-O architecture`);
    }
    return;
  }
  const fat64 = magic === 0xcafebabf || magic === 0xbfbafeca;
  const fat32 = magic === 0xcafebabe || magic === 0xbebafeca;
  if (!fat32 && !fat64) throw new ClientParserValidationError(`${label} is not a Mach-O file`);
  const little = magic === 0xbebafeca || magic === 0xbfbafeca;
  const count = view.getUint32(4, little);
  const width = fat64 ? 32 : 20;
  if (count === 0 || count > 32 || bytes.byteLength < 8 + count * width) {
    throw new ClientParserValidationError(`${label} has an invalid universal Mach-O header`);
  }
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(8 + index * width, little) === wanted) return;
  }
  throw new ClientParserValidationError(`${label} does not contain the current architecture`);
}

async function resolveExecutable(name: string, explicit: string | undefined, pathEnvironment: string): Promise<string> {
  const candidates = explicit === undefined
    ? pathEnvironment.split(path.delimiter).filter((entry) => entry !== '').map((entry) => path.join(entry, name))
    : [explicit];
  if (candidates.length === 0 || candidates.some((entry) => !path.isAbsolute(entry))) {
    throw new ClientParserValidationError(`${name} executable search path is invalid`);
  }
  const found: string[] = [];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      found.push(candidate);
      if (explicit === undefined) break;
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'EACCES' || errno(error) === 'ENOTDIR') continue;
      throw error;
    }
  }
  if (found.length !== 1) throw new ClientParserValidationError(`${name} executable was not found`);
  return found[0]!;
}

async function readPackageIdentity(
  packageRoot: string,
  name: string,
  expectedVersion?: string,
): Promise<{
  readonly snapshot: StableFile;
  readonly version: string;
  readonly manifest: Readonly<Record<string, unknown>>;
}> {
  const packageFile = path.join(packageRoot, 'package.json');
  const snapshot = await readStableRegularFile(packageFile, { label: `${name} package metadata` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(UTF8_FATAL.decode(snapshot.bytes));
  } catch {
    throw new ClientParserValidationError(`${name} package metadata is invalid`);
  }
  const version = typeof parsed === 'object' && parsed !== null
    ? (parsed as { version?: unknown }).version
    : undefined;
  if (
    typeof parsed !== 'object' || parsed === null
    || (parsed as { name?: unknown }).name !== name
    || typeof version !== 'string' || !VERSION.test(version)
    || (expectedVersion !== undefined && version !== expectedVersion)
  ) throw new ClientParserValidationError(`${name} package metadata does not match the expected identity`);
  return { snapshot, version, manifest: parsed as Record<string, unknown> };
}

function codexArchitecturePackageVersion(
  rootPackage: Awaited<ReturnType<typeof readPackageIdentity>>,
  aliasName: string,
  architecture: 'arm64' | 'x64',
): string {
  const architectureVersion = `${rootPackage.version}-darwin-${architecture}`;
  const optionalDependencies = rootPackage.manifest.optionalDependencies;
  if (
    typeof optionalDependencies !== 'object'
    || optionalDependencies === null
    || Array.isArray(optionalDependencies)
    || (optionalDependencies as Record<string, unknown>)[aliasName]
      !== `npm:@openai/codex@${architectureVersion}`
  ) throw new ClientParserValidationError('Codex root package does not bind the architecture alias exactly');
  return architectureVersion;
}

async function readCodexArchitecturePackageIdentity(
  packageRoot: string,
  aliasName: string,
  rootPackage: Awaited<ReturnType<typeof readPackageIdentity>>,
  architecture: 'arm64' | 'x64',
): Promise<StableFile> {
  const architectureVersion = codexArchitecturePackageVersion(rootPackage, aliasName, architecture);
  const identity = await readPackageIdentity(packageRoot, '@openai/codex', architectureVersion);
  if (
    !Array.isArray(identity.manifest.os)
    || identity.manifest.os.length !== 1
    || identity.manifest.os[0] !== 'darwin'
    || !Array.isArray(identity.manifest.cpu)
    || identity.manifest.cpu.length !== 1
    || identity.manifest.cpu[0] !== architecture
  ) throw new ClientParserValidationError('Codex architecture package platform metadata is invalid');
  return identity.snapshot;
}

async function resolveCodex(
  launcher: string,
  expectedVersion: string | undefined,
  architecture: NodeJS.Architecture,
): Promise<ResolvedClient> {
  const resolvedLauncher = await fs.realpath(launcher);
  const launcherSnapshot = await readStableRegularFile(resolvedLauncher, { label: 'Codex Node launcher' });
  const firstLine = UTF8_FATAL.decode(launcherSnapshot.bytes.subarray(0, Math.min(launcherSnapshot.bytes.length, 256))).split(/\r?\n/u)[0] ?? '';
  if (!firstLine.startsWith('#!') || !/(?:^|[ /])node(?:[ \r\n]|$)/u.test(firstLine)) {
    throw new ClientParserValidationError('Codex launcher is not a Node launcher');
  }
  if (path.basename(resolvedLauncher) !== 'codex.js' || path.basename(path.dirname(resolvedLauncher)) !== 'bin') {
    throw new ClientParserValidationError('Codex Node launcher has an unknown package layout');
  }
  const packageRoot = path.dirname(path.dirname(resolvedLauncher));
  const packageIdentity = await readPackageIdentity(packageRoot, '@openai/codex', expectedVersion);
  const packageSnapshot = packageIdentity.snapshot;
  const triple = architecture === 'arm64' ? 'aarch64-apple-darwin'
    : architecture === 'x64' ? 'x86_64-apple-darwin'
      : undefined;
  if (triple === undefined) throw new ClientParserValidationError(`unsupported macOS architecture: ${architecture}`);
  const supportedArchitecture = architecture as 'arm64' | 'x64';
  const architecturePackage = `codex-darwin-${architecture}`;
  const architectureAlias = `@openai/${architecturePackage}`;
  const architectureRoots = [
    packageRoot,
    path.join(packageRoot, 'node_modules', '@openai', architecturePackage),
    path.join(path.dirname(packageRoot), architecturePackage),
  ];
  const relativePayloads = [
    path.join('vendor', triple, 'bin', 'codex'),
    path.join('vendor', triple, 'codex', 'codex'),
  ];
  const matches = new Map<string, {
    native: StableFile;
    candidatePaths: Set<string>;
    metadata: Map<string, StableFile>;
  }>();
  for (const root of architectureRoots) {
    for (const relative of relativePayloads) {
      const candidate = path.join(root, relative);
      try {
        const realCandidate = await fs.realpath(candidate);
        const native = await readStableRegularFile(realCandidate, { executable: true, label: 'Codex native executable' });
        validateMachO(native.bytes, architecture, 'Codex native executable');
        let metadata: StableFile | undefined;
        if (root !== packageRoot) {
          metadata = await readCodexArchitecturePackageIdentity(
            root,
            architectureAlias,
            packageIdentity,
            supportedArchitecture,
          );
        }
        const prior = matches.get(realCandidate);
        if (prior === undefined) {
          matches.set(realCandidate, {
            native,
            candidatePaths: new Set([candidate]),
            metadata: new Map(metadata === undefined ? [] : [[metadata.path, metadata]]),
          });
        } else {
          prior.candidatePaths.add(candidate);
          if (metadata !== undefined) prior.metadata.set(metadata.path, metadata);
        }
      } catch (error) {
        if (errno(error) === 'ENOENT' || errno(error) === 'ENOTDIR') continue;
        throw error;
      }
    }
  }
  if (matches.size !== 1) {
    throw new ClientParserValidationError('Codex native executable did not resolve uniquely');
  }
  const selected = [...matches.values()][0]!;
  return {
    native: selected.native,
    version: packageIdentity.version,
    async verifyUnchanged() {
      if (await fs.realpath(launcher) !== resolvedLauncher) {
        throw new ClientParserValidationError('Codex launcher target changed during validation');
      }
      await assertHashAndModeUnchanged(launcherSnapshot, 'Codex Node launcher');
      await assertHashAndModeUnchanged(packageSnapshot, 'Codex package metadata');
      for (const metadata of selected.metadata.values()) {
        await assertHashAndModeUnchanged(metadata, 'Codex architecture package metadata');
      }
      for (const candidate of selected.candidatePaths) {
        let currentTarget: string;
        try {
          currentTarget = await fs.realpath(candidate);
        } catch {
          throw new ClientParserValidationError('Codex native candidate target changed during validation');
        }
        if (currentTarget !== selected.native.path) {
          throw new ClientParserValidationError('Codex native candidate target changed during validation');
        }
      }
      await assertHashAndModeUnchanged(selected.native, 'Codex native executable');
    },
  };
}

function grokArchitectureSuffix(architecture: NodeJS.Architecture): string {
  const suffix = architecture === 'arm64' ? 'aarch64'
    : architecture === 'x64' ? 'x86_64'
      : undefined;
  if (suffix === undefined) throw new ClientParserValidationError(`unsupported macOS architecture: ${architecture}`);
  return suffix;
}

async function resolveGrok(
  launcher: string,
  expectedVersion: string | undefined,
  architecture: NodeJS.Architecture,
): Promise<ResolvedClient> {
  const resolvedLauncher = await fs.realpath(launcher);
  const suffix = grokArchitectureSuffix(architecture);
  const match = new RegExp(`^grok-([0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)-macos-${suffix}$`, 'u')
    .exec(path.basename(resolvedLauncher));
  const resolvedVersion = match?.[1];
  if (resolvedVersion === undefined || (expectedVersion !== undefined && resolvedVersion !== expectedVersion)) {
    throw new ClientParserValidationError('Grok native filename does not match the expected version and architecture');
  }
  const native = await readStableRegularFile(resolvedLauncher, { executable: true, label: 'Grok native executable' });
  validateMachO(native.bytes, architecture, 'Grok native executable');
  return {
    native,
    version: resolvedVersion,
    async verifyUnchanged() {
      if (await fs.realpath(launcher) !== resolvedLauncher) {
        throw new ClientParserValidationError('Grok launcher target changed during validation');
      }
      await assertHashAndModeUnchanged(native, 'Grok native executable');
    },
  };
}

async function ensurePrivateDirectory(directory: string, uid: number, create: boolean): Promise<boolean> {
  let created = false;
  try {
    if (create) {
      try {
        await fs.mkdir(directory, { mode: 0o700 });
        created = true;
      } catch (error) {
        if (errno(error) !== 'EEXIST') throw error;
      }
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
      throw new ClientParserValidationError(`private validation directory is unsafe: ${directory}`);
    }
    return created;
  } catch (error) {
    if (created) {
      try {
        await fs.rmdir(directory);
      } catch {
        throw new ClientParserValidationError('could not remove an unsafe validation directory');
      }
    }
    throw error;
  }
}

async function writeExactFile(file: string, bytes: Uint8Array, mode: number, label: string): Promise<StableFile> {
  const handle = await fs.open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const staged = await readStableRegularFile(file, { label, executable: (mode & 0o111) !== 0 });
  if (staged.sha256 !== digest(bytes) || staged.mode !== mode) {
    throw new ClientParserValidationError(`${label} staging verification failed`);
  }
  return staged;
}

function seatbeltLiteral(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new ClientParserValidationError('sandbox path contains an unsupported character');
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function buildClientParserSandboxProfile(
  executable: string,
  ownerHome: string,
  checkRoot: string,
  leaderSocket?: string,
): string {
  if (![executable, ownerHome, checkRoot].every(path.isAbsolute)) {
    throw new ClientParserValidationError('sandbox paths must be absolute');
  }
  if (
    leaderSocket !== undefined
    && (!path.isAbsolute(leaderSocket) || path.dirname(leaderSocket) !== checkRoot)
  ) throw new ClientParserValidationError('Grok leader socket must be directly inside the private check directory');
  const profile = [
    '(version 1)',
    '(deny default)',
    '(deny network*)',
    '(deny process-fork)',
    '(deny process-exec)',
    '(deny file-read*)',
    '(deny file-write*)',
    `(allow process-exec (literal ${seatbeltLiteral(executable)}))`,
    `(allow file-read* (subpath ${seatbeltLiteral(checkRoot)}))`,
    `(allow file-read* (literal ${seatbeltLiteral(executable)}))`,
    '(allow file-read-data (literal "/"))',
    '(allow file-read* (subpath "/System/Library"))',
    '(allow file-read* (subpath "/usr/lib"))',
    '(allow file-read* (subpath "/private/var/db/dyld"))',
    '(allow file-read* (literal "/dev/null"))',
    '(allow file-read* (literal "/dev/urandom"))',
    '(allow file-read* (literal "/etc/localtime"))',
    `(allow file-write* (subpath ${seatbeltLiteral(checkRoot)}))`,
    '(allow process-info*)',
    '(allow sysctl-read)',
    '(allow signal (target self))',
  ];
  if (leaderSocket !== undefined) {
    const literal = seatbeltLiteral(leaderSocket);
    profile.push(
      `(allow network-bind (local unix-socket (literal ${literal})))`,
      `(allow network-inbound (local unix-socket (literal ${literal})))`,
      `(allow network-outbound (remote unix-socket (literal ${literal})))`,
    );
  }
  profile.push(
    '',
  );
  // ownerHome is intentionally used only to prove the private root is nested
  // beneath it; it is never emitted as an allowed read or write scope.
  const relativeRoot = path.relative(ownerHome, checkRoot);
  if (
    relativeRoot === ''
    || relativeRoot === '..'
    || relativeRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeRoot)
  ) {
    throw new ClientParserValidationError('private check directory is outside the owner home');
  }
  return profile.join('\n');
}

function decodeVersion(result: CommandResult, label: string, expectedVersion: string): void {
  if (result.code !== 0) throw new ClientParserValidationError(`${label} version check failed with exit ${result.code}`);
  let output: string;
  try {
    output = `${UTF8_FATAL.decode(result.stdout)}\n${UTF8_FATAL.decode(result.stderr)}`.trim();
  } catch {
    throw new ClientParserValidationError(`${label} version output is not valid UTF-8`);
  }
  if (Buffer.byteLength(output, 'utf8') > 512 || output.includes('\n')) {
    throw new ClientParserValidationError(`${label} version output has an unexpected shape`);
  }
  const versions = output.match(/[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?/gu) ?? [];
  if (versions.length !== 1 || versions[0] !== expectedVersion) {
    throw new ClientParserValidationError(`${label} did not report expected version ${expectedVersion}`);
  }
}

export async function runNoShellChild(invocation: NoShellChildInvocation): Promise<CommandResult> {
  if (
    !Number.isSafeInteger(invocation.timeoutMilliseconds)
    || invocation.timeoutMilliseconds < 1
    || invocation.timeoutMilliseconds > 60_000
  ) throw new ClientParserValidationError('child timeout is invalid');
  if (
    invocation.outputPolicy.kind === 'capture-version'
    && (
      !Number.isSafeInteger(invocation.outputPolicy.maxCombinedBytes)
      || invocation.outputPolicy.maxCombinedBytes < 1
      || invocation.outputPolicy.maxCombinedBytes > 4_096
    )
  ) throw new ClientParserValidationError('version output limit is invalid');

  return new Promise<CommandResult>((resolve, reject) => {
    const capture = invocation.outputPolicy.kind === 'capture-version';
    const child = spawn(invocation.command, [...invocation.args], {
      cwd: invocation.cwd,
      env: { ...invocation.env },
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let termination: 'timeout' | 'output-limit' | undefined;
    let settled = false;
    const finishError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const terminate = (reason: 'timeout' | 'output-limit'): void => {
      if (termination !== undefined) return;
      termination = reason;
      stdout.length = 0;
      stderr.length = 0;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => terminate('timeout'), invocation.timeoutMilliseconds);
    const collect = (destination: Buffer[]) => (chunk: Buffer): void => {
      if (termination !== undefined || invocation.outputPolicy.kind !== 'capture-version') return;
      if (outputBytes + chunk.byteLength > invocation.outputPolicy.maxCombinedBytes) {
        terminate('output-limit');
        return;
      }
      outputBytes += chunk.byteLength;
      destination.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.once('spawn', () => {
      if (child.pid !== undefined) invocation.onSpawn?.(child.pid);
    });
    child.once('error', () => {
      finishError(new ClientParserValidationError(`${invocation.label} could not start`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (termination === 'timeout') {
        reject(new ClientParserValidationError(`${invocation.label} timed out`));
        return;
      }
      if (termination === 'output-limit') {
        reject(new ClientParserValidationError(`${invocation.label} version output exceeded the byte limit`));
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: capture ? Buffer.concat(stdout) : new Uint8Array(),
        stderr: capture ? Buffer.concat(stderr) : new Uint8Array(),
      });
    });
  });
}

async function defaultSandboxRunner(sandboxExec: string, invocation: SandboxedInvocation): Promise<CommandResult> {
  return runNoShellChild({
    command: sandboxExec,
    args: ['-p', invocation.profile, invocation.executable, ...invocation.args],
    cwd: invocation.cwd,
    env: invocation.env,
    label: invocation.label,
    timeoutMilliseconds: SANDBOX_TIMEOUT_MILLISECONDS,
    outputPolicy: invocation.outputPolicy,
  });
}

async function checkedParserRun(runner: SandboxRunner, invocation: SandboxedInvocation): Promise<void> {
  const result = await runner(invocation);
  if (result.code !== 0) {
    throw new ClientParserValidationError(`${invocation.label} parser check failed with exit ${result.code}`);
  }
  // Parser output is deliberately neither decoded, returned, logged, nor persisted.
}

async function assertEmptyDirectory(directory: string): Promise<void> {
  if ((await fs.readdir(directory)).length !== 0) {
    throw new ClientParserValidationError('client wrote into the empty validation working directory');
  }
}

async function compareExpectedConfig(
  file: string,
  expected: InstalledFileIdentity,
  uid: number,
  label: string,
): Promise<StableFile> {
  const snapshot = await readStableRegularFile(file, { ownerUid: uid, label });
  if (snapshot.sha256 !== expected.sha256 || snapshot.mode !== expected.mode) {
    throw new ClientParserValidationError(`${label} does not match the parsed install candidate`);
  }
  return snapshot;
}

function randomNonce(): string {
  return randomBytes(6).toString('hex');
}

export async function validateMacosClientParsers(
  options: MacosClientParserValidationOptions,
): Promise<MacosClientParserValidationResult> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const uid = options.uid ?? currentUid();
  if (platform !== 'darwin') throw new ClientParserValidationError('client parser validation requires macOS');
  if (!path.isAbsolute(options.ownerHome) || options.ownerHome === path.parse(options.ownerHome).root) {
    throw new ClientParserValidationError('owner home must be a non-root absolute path');
  }
  if (!path.isAbsolute(options.codexConfig) || !path.isAbsolute(options.grokConfig)) {
    throw new ClientParserValidationError('installed client config paths must be absolute');
  }
  if (
    options.codexConfig !== path.join(options.ownerHome, '.codex', 'config.toml')
    || options.grokConfig !== path.join(options.ownerHome, '.grok', 'config.toml')
  ) throw new ClientParserValidationError('installed client config paths are not the fixed owner paths');
  if (
    (options.expectedCodexVersion !== undefined && !VERSION.test(options.expectedCodexVersion))
    || (options.expectedGrokVersion !== undefined && !VERSION.test(options.expectedGrokVersion))
  ) {
    throw new ClientParserValidationError('expected client version is invalid');
  }
  const expectedCodexConfig = validateExpectedIdentity(options.expectedCodexConfig, 'Codex config');
  const expectedGrokConfig = validateExpectedIdentity(options.expectedGrokConfig, 'Grok config');
  const pathEnvironment = options.pathEnvironment ?? process.env.PATH ?? '';
  const nonce = (options.nonce ?? randomNonce)();
  if (!NONCE.test(nonce)) throw new ClientParserValidationError('validation nonce is invalid');

  const base = path.join(options.ownerHome, '.pxpipe-s');
  const checkRoot = path.join(base, nonce);
  const socket = path.join(checkRoot, 's');
  if (Buffer.byteLength(socket, 'utf8') > SOCKET_BUDGET_BYTES) {
    throw new ClientParserValidationError(`Grok leader socket exceeds ${SOCKET_BUDGET_BYTES} UTF-8 bytes`);
  }

  const ownerStat = await fs.lstat(options.ownerHome);
  if (!ownerStat.isDirectory() || ownerStat.isSymbolicLink() || ownerStat.uid !== uid) {
    throw new ClientParserValidationError('owner home is unsafe');
  }
  const codexLauncher = await resolveExecutable('codex', options.codexLauncher, pathEnvironment);
  const grokLauncher = await resolveExecutable('grok', options.grokLauncher, pathEnvironment);
  const codex = await resolveCodex(codexLauncher, options.expectedCodexVersion, architecture);
  const grok = await resolveGrok(grokLauncher, options.expectedGrokVersion, architecture);
  const codexConfig = await compareExpectedConfig(options.codexConfig, expectedCodexConfig, uid, 'Codex config');
  const grokConfig = await compareExpectedConfig(options.grokConfig, expectedGrokConfig, uid, 'Grok config');

  let baseCreated = false;
  let rootCreated = false;
  let failure: unknown;
  let result: MacosClientParserValidationResult | undefined;
  try {
    baseCreated = await ensurePrivateDirectory(base, uid, true);
    await ensurePrivateDirectory(checkRoot, uid, false).catch(async (error: unknown) => {
      if (errno(error) !== 'ENOENT') throw error;
      await fs.mkdir(checkRoot, { mode: 0o700 });
      rootCreated = true;
      await ensurePrivateDirectory(checkRoot, uid, false);
    });
    if (!rootCreated) throw new ClientParserValidationError('validation directory already exists');

    const isolatedHome = path.join(checkRoot, 'home');
    const emptyCwd = path.join(checkRoot, 'cwd');
    const bin = path.join(checkRoot, 'bin');
    const temporary = path.join(checkRoot, 'tmp');
    for (const directory of [isolatedHome, emptyCwd, bin, temporary]) {
      await fs.mkdir(directory, { mode: 0o700 });
      await ensurePrivateDirectory(directory, uid, false);
    }
    const isolatedCodexDirectory = path.join(isolatedHome, '.codex');
    const isolatedGrokDirectory = path.join(isolatedHome, '.grok');
    await fs.mkdir(isolatedCodexDirectory, { mode: 0o700 });
    await fs.mkdir(isolatedGrokDirectory, { mode: 0o700 });
    const stagedCodexConfig = await writeExactFile(
      path.join(isolatedCodexDirectory, 'config.toml'), codexConfig.bytes, 0o600, 'staged Codex config',
    );
    const stagedGrokConfig = await writeExactFile(
      path.join(isolatedGrokDirectory, 'config.toml'), grokConfig.bytes, 0o600, 'staged Grok config',
    );
    const stagedCodex = await writeExactFile(path.join(bin, 'codex'), codex.native.bytes, codex.native.mode, 'staged Codex executable');
    const stagedGrok = await writeExactFile(path.join(bin, 'grok'), grok.native.bytes, grok.native.mode, 'staged Grok executable');
    if (stagedCodex.sha256 !== codex.native.sha256 || stagedGrok.sha256 !== grok.native.sha256) {
      throw new ClientParserValidationError('staged native executable hash mismatch');
    }

    const env: Readonly<Record<string, string>> = {
      HOME: isolatedHome,
      CODEX_HOME: isolatedCodexDirectory,
      XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
      PATH: bin,
      TMPDIR: `${temporary}${path.sep}`,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    const runner = options.sandboxRunner
      ?? ((invocation: SandboxedInvocation) => defaultSandboxRunner(options.sandboxExec ?? '/usr/bin/sandbox-exec', invocation));
    const codexProfile = buildClientParserSandboxProfile(stagedCodex.path, options.ownerHome, checkRoot);
    const grokProfile = buildClientParserSandboxProfile(stagedGrok.path, options.ownerHome, checkRoot, socket);
    const verifyStaged = async (): Promise<void> => {
      await assertHashAndModeUnchanged(stagedCodexConfig, 'staged Codex config');
      await assertHashAndModeUnchanged(stagedGrokConfig, 'staged Grok config');
      await assertHashAndModeUnchanged(stagedCodex, 'staged Codex executable');
      await assertHashAndModeUnchanged(stagedGrok, 'staged Grok executable');
    };
    await verifyStaged();
    const runAndVerify: SandboxRunner = async (invocation) => {
      try {
        return await runner(invocation);
      } finally {
        await verifyStaged();
      }
    };
    const invoke = async (
      executable: StableFile,
      profile: string,
      args: readonly string[],
      label: string,
    ): Promise<CommandResult> => runAndVerify({
      executable: executable.path,
      args,
      profile,
      cwd: emptyCwd,
      env,
      label,
      outputPolicy: { kind: 'capture-version', maxCombinedBytes: VERSION_OUTPUT_LIMIT_BYTES },
    });

    decodeVersion(await invoke(stagedCodex, codexProfile, ['--version'], 'Codex'), 'Codex', codex.version);
    await assertEmptyDirectory(emptyCwd);
    decodeVersion(await invoke(stagedGrok, grokProfile, ['--version'], 'Grok'), 'Grok', grok.version);
    await assertEmptyDirectory(emptyCwd);
    await verifyStaged();
    await checkedParserRun(runAndVerify, {
      executable: stagedCodex.path,
      args: ['features', 'list'],
      profile: codexProfile,
      cwd: emptyCwd,
      env,
      label: 'Codex',
      outputPolicy: { kind: 'discard' },
    });
    await assertEmptyDirectory(emptyCwd);
    await verifyStaged();
    await checkedParserRun(runAndVerify, {
      executable: stagedGrok.path,
      args: ['inspect', '--json', '--leader-socket', socket],
      profile: grokProfile,
      cwd: emptyCwd,
      env,
      label: 'Grok',
      outputPolicy: { kind: 'discard' },
    });
    await assertEmptyDirectory(emptyCwd);

    await assertHashAndModeUnchanged(codexConfig, 'Codex config');
    await assertHashAndModeUnchanged(grokConfig, 'Grok config');
    await codex.verifyUnchanged();
    await grok.verifyUnchanged();
    result = {
      codex: { sourcePath: codex.native.path, sha256: codex.native.sha256, mode: codex.native.mode, version: codex.version },
      grok: { sourcePath: grok.native.path, sha256: grok.native.sha256, mode: grok.native.mode, version: grok.version },
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      await assertHashAndModeUnchanged(codexConfig, 'Codex config');
      await assertHashAndModeUnchanged(grokConfig, 'Grok config');
      await codex.verifyUnchanged();
      await grok.verifyUnchanged();
    } catch (error) {
      // A source mutation is more important than a parser failure and must not
      // be hidden by it.
      failure = error;
    }
    if (rootCreated) {
      try {
        await fs.rm(checkRoot, { recursive: true, force: false });
      } catch (error) {
        failure ??= error;
      }
    }
    if (baseCreated) {
      try {
        await fs.rmdir(base);
      } catch (error) {
        if (errno(error) !== 'ENOTEMPTY') failure ??= error;
      }
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new ClientParserValidationError('client parser validation did not complete');
  return result;
}

async function expectedConfigIdentitiesFromReceipt(
  receiptPath: string,
  uid: number,
): Promise<{ readonly codex: InstalledFileIdentity; readonly grok: InstalledFileIdentity }> {
  const receiptFile = await readStableRegularFile(receiptPath, { ownerUid: uid, label: 'installer receipt' });
  if (receiptFile.mode !== 0o600) throw new ClientParserValidationError('installer receipt mode is unsafe');
  const receipt = parseStrictReceiptBytes(
    receiptFile.bytes,
    validateLocalInstallReceipt,
    'installer receipt',
  ).payload;
  return {
    codex: { sha256: receipt.codex.config.appliedFileSha256, mode: receipt.codex.fileMode },
    grok: { sha256: receipt.grok.config.appliedFileSha256, mode: receipt.grok.fileMode },
  };
}

export async function runMacosClientParserValidationCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: {
    readonly uid?: number;
    readonly validator?: typeof validateMacosClientParsers;
    readonly output?: (line: string) => void;
  } = {},
): Promise<void> {
  if (argv.length !== 0) throw new ClientParserValidationError('usage: pnpm validate:macos-clients');
  const home = env.HOME;
  if (home === undefined || !path.isAbsolute(home)) {
    throw new ClientParserValidationError('HOME must be an absolute owner directory');
  }
  const uid = dependencies.uid ?? currentUid();
  const paths = resolveMacosInstallerPaths(home);
  const expected = await expectedConfigIdentitiesFromReceipt(paths.receipt, uid);
  await (dependencies.validator ?? validateMacosClientParsers)({
    ownerHome: home,
    codexConfig: paths.codexConfig,
    grokConfig: paths.grokConfig,
    expectedCodexConfig: expected.codex,
    expectedGrokConfig: expected.grok,
    pathEnvironment: env.PATH,
  });
  (dependencies.output ?? ((line: string) => process.stdout.write(`${line}\n`)))(
    '✓ Codex and Grok configuration parsers passed offline validation.',
  );
}

async function main(): Promise<void> {
  try {
    await runMacosClientParserValidationCli();
  } catch (error) {
    process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) void main();
