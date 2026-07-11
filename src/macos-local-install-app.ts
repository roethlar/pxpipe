/** Runnable, dependency-injected macOS one-port installer application. */

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  buildClientCandidate,
  buildUninstallCandidate,
  findLegacyFootprints,
  validateClientConfigReceipt,
  type ClientConfigCandidate,
  type ClientConfigReceipt,
  type ClientUninstallCandidate,
} from './macos-local-config.js';
import {
  CODEX_SUBSCRIPTION_UPSTREAM,
  DEFAULT_INSTALL_PORT,
  GROK_SUBSCRIPTION_UPSTREAM,
  INSTALLED_MODELS,
  INSTALLER_PROGRAM_NAME,
  InstallerValidationError,
  atomicWriteFsync,
  buildLaunchAgentPlist,
  createFileResourceAdapter,
  createMacosServiceOperations,
  createProcessLivenessCheck,
  currentProcessIdentity,
  extractVerifiedPackage,
  fsyncDirectory,
  parseInstallerInvocation,
  resolveMacosInstallerPaths,
  runCommand,
  runInstallerOperation,
  sameResourceIdentity,
  serializeReceipt,
  sha256,
  validateInstallerBundle,
  type BundleManifest,
  type CapturedResource,
  type CommandRunner,
  type ExpectedInstallerBundleHashes,
  type InstallerOperation,
  type InstallerOperationAdapter,
  type InstallerHooks,
  type MacosInstallerPaths,
  type PreparedInstallerOperation,
  type ProcessIdentity,
  type ResourceIdentity,
  type TransactionResourceAdapter,
} from './macos-local-installer.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const SAFE_ID = /^[0-9a-f]{32}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const LEGACY_ADOPTION_IDENTITY: LegacyAdoptionIdentity = {
  sourceCommit: '59e2b9a618af6faba6c54390970e62484ea501c1',
  version: '0.8.0-provenance-safe.1',
  archiveSha256: '57a6cf608839f126b69b9bef75e5613b03ac432e7424b220ee2e238b19f6970f',
  releaseTreeSha256: '3f53a3e5950eeebb674f930154110252e5f16640280182548cfaaf774fc03fac',
};
const INJECTABLE_NODE_ENVIRONMENT = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_V8_COVERAGE',
  'NODE_COMPILE_CACHE',
  'NODE_COMPILE_CACHE_PORTABLE',
] as const;
const REQUIRED_COMMANDS = ['tar', 'launchctl', 'lsof', 'curl', 'ps'] as const;

export interface LegacyAdoptionIdentity {
  readonly sourceCommit: string;
  readonly version: string;
  readonly archiveSha256: string;
  readonly releaseTreeSha256: string;
}

interface ClientReceiptState {
  readonly config: ClientConfigReceipt;
  readonly fileMode: number;
  readonly directoryExisted: boolean;
  readonly directoryMode: number;
}

export interface LocalInstallReceiptPayload {
  readonly schemaVersion: 1;
  readonly sourceCommit: string;
  readonly version: string;
  readonly archiveSha256: string;
  readonly releaseTreeSha256: string;
  readonly port: number;
  readonly nodeExecutable: string;
  readonly codex: ClientReceiptState;
  readonly grok: ClientReceiptState;
}

interface SafeClientFile {
  readonly bytes: Uint8Array | null;
  readonly fileMode: number;
  readonly directoryExisted: boolean;
  readonly directoryMode: number;
}

interface DirectoryState {
  readonly exists: boolean;
  readonly mode: number;
}

interface ReleaseInventoryEntry {
  readonly name: string;
  readonly manifestSha256: string;
}

interface ReleaseInventoryState {
  readonly existed: boolean;
  readonly entries: readonly ReleaseInventoryEntry[];
}

interface ReleasePointerState {
  readonly target: string | null;
}

interface ReleaseInventoryAdapter extends TransactionResourceAdapter {
  readState(): Promise<ReleaseInventoryState>;
}

interface AppDependencies {
  readonly entryFile: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly runner: CommandRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly processIdentity: ProcessIdentity;
  readonly isProcessAlive: (identity: ProcessIdentity) => Promise<boolean>;
  readonly nodeExecutable: string;
  readonly transactionId: string;
  readonly nonce: () => string;
  readonly output: (line: string) => void;
  readonly legacyAdoptionIdentity: LegacyAdoptionIdentity;
}

export interface RunMacosInstallAppOptions {
  readonly entryFile?: string;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly runner?: CommandRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly processIdentity?: ProcessIdentity;
  readonly isProcessAlive?: (identity: ProcessIdentity) => Promise<boolean>;
  readonly nodeExecutable?: string;
  readonly transactionId?: string;
  readonly nonce?: () => string;
  readonly output?: (line: string) => void;
  readonly installSignalHandlers?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly commandAvailable?: (command: string) => Promise<boolean>;
  /** Trusted hashes captured by the verified bootstrap; never sourced from disk or environment. */
  readonly expectedBundleHashes?: ExpectedInstallerBundleHashes;
  /** Tests may substitute a pinned historical bundle identity; production never reads this from env. */
  readonly legacyAdoptionIdentity?: LegacyAdoptionIdentity;
  /** Dependency injection for deterministic process-death tests; never read from the environment. */
  readonly hooks?: InstallerHooks;
}

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function validateLegacyAdoptionIdentity(value: LegacyAdoptionIdentity): LegacyAdoptionIdentity {
  if (
    !SOURCE_COMMIT.test(value.sourceCommit)
    || value.version.length === 0
    || value.version.includes('/')
    || !/^[0-9a-f]{64}$/u.test(value.archiveSha256)
    || !/^[0-9a-f]{64}$/u.test(value.releaseTreeSha256)
  ) throw new InstallerValidationError('legacy adoption identity is invalid');
  return value;
}

async function executableAvailable(command: string, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin')
        .split(path.delimiter)
        .filter((directory) => directory !== '')
        .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return true;
    } catch (error) {
      if (errno(error) === 'ENOENT' || errno(error) === 'EACCES' || errno(error) === 'ENOTDIR') continue;
      throw error;
    }
  }
  return false;
}

async function lstatOrAbsent(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function readOwnerRegularNoFollow(
  file: string,
  uid: number,
  label: string,
): Promise<{ readonly bytes: Uint8Array; readonly mode: number }> {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== uid) {
    throw new InstallerValidationError(`${label} is not a regular owner file: ${file}`);
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes: Uint8Array;
  let opened;
  let afterHandle;
  try {
    opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new InstallerValidationError(`${label} changed while being opened: ${file}`);
    }
    bytes = await handle.readFile();
    afterHandle = await handle.stat();
  } finally {
    await handle.close();
  }
  if (opened === undefined || afterHandle === undefined) {
    throw new InstallerValidationError(`${label} could not be read: ${file}`);
  }
  const afterPath = await fs.lstat(file);
  if (
    !afterPath.isFile()
    || afterPath.isSymbolicLink()
    || afterPath.uid !== uid
    || opened.dev !== afterHandle.dev
    || opened.ino !== afterHandle.ino
    || opened.size !== afterHandle.size
    || opened.mtimeMs !== afterHandle.mtimeMs
    || afterHandle.dev !== afterPath.dev
    || afterHandle.ino !== afterPath.ino
    || afterHandle.size !== afterPath.size
    || afterHandle.mtimeMs !== afterPath.mtimeMs
    || bytes.byteLength !== afterHandle.size
  ) throw new InstallerValidationError(`${label} changed while being read: ${file}`);
  return { bytes, mode: afterPath.mode & 0o777 };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateMode(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new InstallerValidationError(`${label} mode is invalid`);
  }
  return value as number;
}

function managedAppliedRhs(
  receipt: ClientConfigReceipt,
  table: string,
  key: string,
): string {
  const edit = receipt.edits.find((candidate) =>
    candidate.kind !== 'insert-table' && candidate.table === table && candidate.key === key
  );
  if (edit === undefined || edit.kind === 'insert-table') {
    throw new InstallerValidationError(`receipt is missing managed ${table}.${key}`);
  }
  if (edit.kind === 'replace') {
    return Buffer.from(edit.appliedRhsBase64, 'base64').toString('utf8');
  }
  const line = Buffer.from(edit.appliedLineBase64, 'base64').toString('utf8');
  const match = /^[A-Za-z0-9_-]+[\t ]*=[\t ]*(.+)$/u.exec(line);
  if (!match) throw new InstallerValidationError(`receipt has malformed managed ${table}.${key}`);
  return match[1]!;
}

export function validateLocalInstallReceipt(value: unknown): LocalInstallReceiptPayload {
  if (!plainObject(value) || !exactKeys(value, [
    'schemaVersion', 'sourceCommit', 'version', 'archiveSha256', 'releaseTreeSha256',
    'port', 'nodeExecutable', 'codex', 'grok',
  ])) throw new InstallerValidationError('local install receipt has an invalid schema');
  if (
    value.schemaVersion !== 1
    || typeof value.sourceCommit !== 'string'
    || !SOURCE_COMMIT.test(value.sourceCommit)
    || typeof value.version !== 'string'
    || value.version.length === 0
    || typeof value.archiveSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.archiveSha256)
    || typeof value.releaseTreeSha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.releaseTreeSha256)
    || !Number.isSafeInteger(value.port)
    || (value.port as number) < 1
    || (value.port as number) > 65_535
    || typeof value.nodeExecutable !== 'string'
    || !path.isAbsolute(value.nodeExecutable)
  ) throw new InstallerValidationError('local install receipt has invalid fixed fields');

  const client = (raw: unknown, kind: 'codex' | 'grok'): ClientReceiptState => {
    if (!plainObject(raw) || !exactKeys(raw, [
      'config', 'fileMode', 'directoryExisted', 'directoryMode',
    ]) || typeof raw.directoryExisted !== 'boolean') {
      throw new InstallerValidationError(`${kind} receipt state is invalid`);
    }
    try {
      const config = validateClientConfigReceipt(raw.config, kind);
      const fileMode = validateMode(raw.fileMode, `${kind} file`);
      const directoryMode = validateMode(raw.directoryMode, `${kind} directory`);
      if (
        (fileMode & 0o022) !== 0
        || (directoryMode & 0o022) !== 0
        || (!config.fileExisted && fileMode !== 0o600)
        || (!raw.directoryExisted && directoryMode !== 0o700)
        || (config.fileExisted && !raw.directoryExisted)
      ) throw new InstallerValidationError(`${kind} receipt modes or existence relationship are unsafe`);
      return {
        config,
        fileMode,
        directoryExisted: raw.directoryExisted,
        directoryMode,
      };
    } catch (error) {
      throw new InstallerValidationError(`${kind} receipt is invalid: ${(error as Error).message}`);
    }
  };

  const codex = client(value.codex, 'codex');
  const grok = client(value.grok, 'grok');
  const port = value.port as number;
  if (
    managedAppliedRhs(codex.config, 'model_providers.pxpipe_local', 'base_url')
      !== JSON.stringify(`http://127.0.0.1:${port}/_pxpipe/codex`)
    || managedAppliedRhs(grok.config, 'endpoints', 'cli_chat_proxy_base_url')
      !== JSON.stringify(`http://127.0.0.1:${port}/_pxpipe/grok/v1`)
  ) throw new InstallerValidationError('client receipt URLs do not match the installed port');

  return {
    schemaVersion: 1,
    sourceCommit: value.sourceCommit,
    version: value.version,
    archiveSha256: value.archiveSha256,
    releaseTreeSha256: value.releaseTreeSha256,
    port,
    nodeExecutable: value.nodeExecutable,
    codex,
    grok,
  };
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_INSTALL_PORT;
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new InstallerValidationError('PXPIPE_PORT must be an integer from 1 to 65535');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new InstallerValidationError('PXPIPE_PORT must be an integer from 1 to 65535');
  }
  return port;
}

function stateBytes(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

function syntheticIdentity(uid: number, bytes: Uint8Array): ResourceIdentity {
  return { exists: true, uid, mode: 0o600, sha256: sha256(bytes) };
}

function presentIdentity(uid: number, mode: number, bytes: Uint8Array): ResourceIdentity {
  return { exists: true, uid, mode, sha256: sha256(bytes) };
}

async function readSafeClientFile(file: string, uid: number): Promise<SafeClientFile> {
  const directory = path.dirname(file);
  const directoryStat = await lstatOrAbsent(directory);
  let directoryExisted = false;
  let directoryMode = 0o700;
  if (directoryStat !== undefined) {
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || directoryStat.uid !== uid
      || (directoryStat.mode & 0o022) !== 0
    ) throw new InstallerValidationError(`client config directory is not safely owner-controlled: ${directory}`);
    directoryExisted = true;
    directoryMode = directoryStat.mode & 0o777;
  }
  const fileStat = await lstatOrAbsent(file);
  if (fileStat === undefined) {
    return { bytes: null, fileMode: 0o600, directoryExisted, directoryMode };
  }
  const read = await readOwnerRegularNoFollow(file, uid, 'client config');
  return {
    bytes: read.bytes,
    fileMode: read.mode,
    directoryExisted,
    directoryMode,
  };
}

async function validateLaunchAgentPath(paths: MacosInstallerPaths, uid: number): Promise<void> {
  const directory = path.dirname(paths.launchAgent);
  const parent = path.dirname(directory);
  for (const candidate of [parent, directory]) {
    const stat = await lstatOrAbsent(candidate);
    if (stat === undefined) continue;
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || (stat.mode & 0o022) !== 0
    ) throw new InstallerValidationError(`LaunchAgent directory is unsafe: ${candidate}`);
  }
  const plist = await lstatOrAbsent(paths.launchAgent);
  if (plist !== undefined && (
    !plist.isFile()
    || plist.isSymbolicLink()
    || plist.uid !== uid
    || (plist.mode & 0o777) !== 0o600
  )) throw new InstallerValidationError('existing pxpipe LaunchAgent is not a regular owner-only file');
}

interface LocalLogPaths {
  readonly directory: string;
  readonly stdout: string;
  readonly stderr: string;
}

function localLogPaths(home: string): LocalLogPaths {
  const directory = path.join(home, 'Library', 'Logs', 'pxpipe');
  return {
    directory,
    stdout: path.join(directory, 'pxpipe.out.log'),
    stderr: path.join(directory, 'pxpipe.err.log'),
  };
}

async function validateLocalLogPaths(logs: LocalLogPaths, uid: number): Promise<void> {
  for (const directory of [path.dirname(logs.directory), logs.directory]) {
    const stat = await lstatOrAbsent(directory);
    if (stat === undefined) continue;
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || (stat.mode & 0o022) !== 0
    ) throw new InstallerValidationError(`local log directory is unsafe: ${directory}`);
  }
  for (const file of [logs.stdout, logs.stderr]) {
    const stat = await lstatOrAbsent(file);
    if (stat === undefined) continue;
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || (stat.mode & 0o022) !== 0
    ) throw new InstallerValidationError(`local log is not an owner-safe regular file: ${file}`);
  }
}

async function ensureLocalLogPaths(logs: LocalLogPaths, uid: number): Promise<void> {
  await fs.mkdir(logs.directory, { recursive: true, mode: 0o700 });
  await validateLocalLogPaths(logs, uid);
  for (const file of [logs.stdout, logs.stderr]) {
    const handle = await fs.open(
      file,
      fsConstants.O_APPEND
        | fsConstants.O_CREAT
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_WRONLY,
      0o600,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.uid !== uid || (opened.mode & 0o022) !== 0) {
        throw new InstallerValidationError(`local log is not an owner-safe regular file: ${file}`);
      }
    } finally {
      await handle.close();
    }
  }
  await validateLocalLogPaths(logs, uid);
  await fsyncDirectory(logs.directory);
  await fsyncDirectory(path.dirname(logs.directory));
}

function xmlLocal(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

function buildLocalLaunchAgentPlist(
  paths: MacosInstallerPaths,
  port: number,
  nodeExecutable: string,
): Uint8Array {
  const base = decoder.decode(buildLaunchAgentPlist(
    path.join(paths.current, 'bin', 'cli.js'),
    port,
    nodeExecutable,
  ));
  const marker = '</dict>\n</plist>\n';
  const index = base.lastIndexOf(marker);
  if (index < 0) throw new InstallerValidationError('generated LaunchAgent shape is invalid');
  const logs = localLogPaths(paths.home);
  const fields = [
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xmlLocal(logs.stdout)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlLocal(logs.stderr)}</string>`,
  ].join('\n');
  return encoder.encode(`${base.slice(0, index)}${fields}\n${base.slice(index)}`);
}

function buildPinnedLegacyLaunchAgentPlist(
  paths: MacosInstallerPaths,
  port: number,
  nodeExecutable: string,
): Uint8Array {
  const logs = localLogPaths(paths.home);
  const cli = path.join(paths.current, 'bin', 'cli.js');
  return encoder.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>com.pxpipe.proxy</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xmlLocal(nodeExecutable)}</string>\n    <string>${xmlLocal(cli)}</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n    <key>HOST</key><string>127.0.0.1</string>\n    <key>PORT</key><string>${port}</string>\n    <key>PXPIPE_MODELS</key><string>${xmlLocal(INSTALLED_MODELS)}</string>\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Background</string>\n  <key>StandardOutPath</key><string>${xmlLocal(logs.stdout)}</string>\n  <key>StandardErrorPath</key><string>${xmlLocal(logs.stderr)}</string>\n</dict>\n</plist>\n`);
}

function createDirectoryAdapter(
  name: 'codexDirectory' | 'grokDirectory',
  directory: string,
  uid: number,
): TransactionResourceAdapter {
  async function capture(): Promise<CapturedResource> {
    const stat = await lstatOrAbsent(directory);
    let state: DirectoryState;
    if (stat === undefined) {
      state = { exists: false, mode: 0o700 };
    } else {
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
        throw new InstallerValidationError(`managed directory is unsafe: ${directory}`);
      }
      state = { exists: true, mode: stat.mode & 0o777 };
    }
    const snapshot = stateBytes(state);
    return { identity: syntheticIdentity(uid, snapshot), snapshot };
  }
  return {
    name,
    displayPath: directory,
    capture,
    async currentIdentity() {
      return (await capture()).identity;
    },
    async restore(_prior, snapshot) {
      if (snapshot === null) throw new InstallerValidationError(`missing directory snapshot: ${directory}`);
      const state = JSON.parse(decoder.decode(snapshot)) as DirectoryState;
      if (state.exists) {
        await fs.mkdir(directory, { recursive: false, mode: state.mode }).catch((error) => {
          if (errno(error) !== 'EEXIST') throw error;
        });
        await fs.chmod(directory, state.mode);
      } else {
        try {
          await fs.rmdir(directory);
          await fsyncDirectory(path.dirname(directory));
        } catch (error) {
          if (errno(error) !== 'ENOENT') throw error;
        }
      }
    },
  };
}

function createClientFileAdapter(
  name: 'codexConfig' | 'grokConfig',
  file: string,
): TransactionResourceAdapter {
  const base = createFileResourceAdapter(name, file);
  return {
    ...base,
    async restore(prior, snapshot) {
      if (prior.exists) {
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      }
      await base.restore(prior, snapshot);
    },
  };
}

function desiredDirectoryIdentity(uid: number, exists: boolean, mode: number): ResourceIdentity {
  return syntheticIdentity(uid, stateBytes({ exists, mode } satisfies DirectoryState));
}

function createReleaseMaterialAdapter(
  paths: MacosInstallerPaths,
  uid: number,
): ReleaseInventoryAdapter {
  async function capture(): Promise<CapturedResource> {
    const releasesStat = await lstatOrAbsent(paths.releases);
    const entries: ReleaseInventoryEntry[] = [];
    if (releasesStat !== undefined) {
      if (!releasesStat.isDirectory() || releasesStat.isSymbolicLink() || releasesStat.uid !== uid) {
        throw new InstallerValidationError(`release directory is unsafe: ${paths.releases}`);
      }
      for (const name of (await fs.readdir(paths.releases)).sort()) {
        if (!SOURCE_COMMIT.test(name)) {
          throw new InstallerValidationError('release directory contains an unmanaged entry');
        }
        const directory = path.join(paths.releases, name);
        const stat = await fs.lstat(directory);
        const receipt = path.join(directory, '.pxpipe-manifest.json');
        const receiptStat = await lstatOrAbsent(receipt);
        if (
          !stat.isDirectory()
          || stat.isSymbolicLink()
          || stat.uid !== uid
          || receiptStat === undefined
          || !receiptStat.isFile()
          || receiptStat.isSymbolicLink()
          || receiptStat.uid !== uid
        ) throw new InstallerValidationError(`release inventory contains an unsafe release: ${directory}`);
        entries.push({
          name,
          manifestSha256: sha256((await readOwnerRegularNoFollow(
            receipt,
            uid,
            'release manifest',
          )).bytes),
        });
      }
    }
    const snapshot = stateBytes({
      existed: releasesStat !== undefined,
      entries,
    } satisfies ReleaseInventoryState);
    return { identity: syntheticIdentity(uid, snapshot), snapshot };
  }
  return {
    name: 'releaseMaterial',
    displayPath: paths.releases,
    capture,
    async currentIdentity() {
      return (await capture()).identity;
    },
    async readState() {
      const current = await capture();
      if (current.snapshot === null) throw new InstallerValidationError('release state snapshot is missing');
      return JSON.parse(decoder.decode(current.snapshot)) as ReleaseInventoryState;
    },
    async restore(prior, snapshot) {
      if (!prior.exists || snapshot === null || sha256(snapshot) !== prior.sha256) {
        throw new InstallerValidationError('release-inventory snapshot is invalid');
      }
      const priorState = JSON.parse(decoder.decode(snapshot)) as ReleaseInventoryState;
      const current = await capture();
      if (current.snapshot === null) throw new InstallerValidationError('current release inventory is invalid');
      const currentState = JSON.parse(decoder.decode(current.snapshot)) as ReleaseInventoryState;
      const priorNames = new Set(priorState.entries.map((entry) => entry.name));
      for (const entry of currentState.entries) {
        if (!priorNames.has(entry.name)) {
          await fs.rm(path.join(paths.releases, entry.name), { recursive: true, force: true });
        }
      }
      if (!priorState.existed) {
        try {
          await fs.rmdir(paths.releases);
        } catch (error) {
          if (errno(error) !== 'ENOENT' && errno(error) !== 'ENOTEMPTY') throw error;
        }
      }
      await fsyncDirectory(paths.installRoot);
    },
  };
}

function desiredReleaseMaterialIdentity(uid: number, state: ReleaseInventoryState): ResourceIdentity {
  return syntheticIdentity(uid, stateBytes(state));
}

function createReleasePointerAdapter(
  paths: MacosInstallerPaths,
  uid: number,
): TransactionResourceAdapter {
  async function capture(): Promise<CapturedResource> {
    const stat = await lstatOrAbsent(paths.current);
    const state: ReleasePointerState = { target: null };
    if (stat !== undefined) {
      if (!stat.isSymbolicLink() || stat.uid !== uid) {
        throw new InstallerValidationError(`release pointer is not an owner symlink: ${paths.current}`);
      }
      (state as { target: string | null }).target = await fs.readlink(paths.current);
    }
    const snapshot = stateBytes(state);
    return { identity: syntheticIdentity(uid, snapshot), snapshot };
  }
  async function replace(target: string | null): Promise<void> {
    if (target === null) {
      await fs.rm(paths.current, { force: true });
    } else {
      const temporary = path.join(paths.installRoot, `.current-${randomBytes(16).toString('hex')}`);
      await fs.symlink(target, temporary);
      await fs.rename(temporary, paths.current);
    }
    await fsyncDirectory(paths.installRoot);
  }
  return {
    name: 'releasePointer',
    displayPath: paths.current,
    capture,
    async currentIdentity() {
      return (await capture()).identity;
    },
    async restore(prior, snapshot) {
      if (!prior.exists || snapshot === null || sha256(snapshot) !== prior.sha256) {
        throw new InstallerValidationError('release-pointer snapshot is invalid');
      }
      const state = JSON.parse(decoder.decode(snapshot)) as ReleasePointerState;
      await replace(state.target);
    },
  };
}

function desiredReleasePointerIdentity(uid: number, target: string | null): ResourceIdentity {
  return syntheticIdentity(uid, stateBytes({ target } satisfies ReleasePointerState));
}

function createServiceStateAdapter(
  paths: MacosInstallerPaths,
  uid: number,
  runner: CommandRunner,
  start: () => Promise<void>,
  stop: () => Promise<void>,
): TransactionResourceAdapter {
  const label = `gui/${uid}/com.pxpipe.proxy`;
  async function loaded(): Promise<boolean> {
    return serviceLoadedStrict(uid, runner);
  }
  async function capture(): Promise<CapturedResource> {
    const snapshot = stateBytes({ loaded: await loaded() });
    return { identity: syntheticIdentity(uid, snapshot), snapshot };
  }
  return {
    name: 'serviceState',
    restoreWhenPriorEqualsApplied: true,
    // Journal paths are deliberately absolute; this is a synthetic resource,
    // not a file that is ever opened.
    displayPath: path.join(paths.stateRoot, 'service-state'),
    capture,
    async currentIdentity() {
      return (await capture()).identity;
    },
    async restore(_prior, snapshot) {
      if (snapshot === null) throw new InstallerValidationError('service-state snapshot is missing');
      const prior = JSON.parse(decoder.decode(snapshot)) as { loaded: boolean };
      if (prior.loaded) {
        await stop();
        await start();
      } else await stop();
    },
  };
}

function desiredServiceIdentity(uid: number, loaded: boolean): ResourceIdentity {
  return syntheticIdentity(uid, stateBytes({ loaded }));
}

async function serviceLoadedStrict(uid: number, runner: CommandRunner): Promise<boolean> {
  const label = `gui/${uid}/com.pxpipe.proxy`;
  const inspected = await runner('launchctl', ['print', label]);
  let stdout: string;
  let stderr: string;
  try {
    stdout = decoder.decode(inspected.stdout);
    stderr = decoder.decode(inspected.stderr);
  } catch {
    throw new InstallerValidationError('launchctl returned malformed service status');
  }
  if (inspected.code === 0) {
    if (stdout.trim() === '' || stderr !== '') {
      throw new InstallerValidationError('launchctl returned malformed service status');
    }
    return true;
  }
  const missing = [
    'Bad request.',
    `Could not find service "com.pxpipe.proxy" in domain for user gui: ${uid}`,
  ].join('\n');
  if (
    inspected.code === 113
    && stdout === ''
    && (stderr === missing || stderr === `${missing}\n`)
  ) return false;
  throw new InstallerValidationError(`launchctl could not inspect the pxpipe service (exit ${inspected.code})`);
}

interface LoadedJobExpectation {
  readonly paths: MacosInstallerPaths;
  readonly nodeExecutable: string;
  readonly port: number;
  readonly environment: 'managed' | 'legacy';
}

interface LoadedJobState {
  readonly state: string;
  readonly pid: string | undefined;
}

function oneTopLevelScalar(lines: readonly string[], name: string): string {
  const prefix = `\t${name} = `;
  const matches = lines.filter((line) => line.startsWith(prefix));
  if (matches.length !== 1) {
    throw new InstallerValidationError(`loaded launchd job has invalid top-level ${name}`);
  }
  return matches[0]!.slice(prefix.length);
}

function topLevelBlock(lines: readonly string[], name: string): string[] {
  const opening = `\t${name} = {`;
  const indexes = lines
    .map((line, index) => line === opening ? index : -1)
    .filter((index) => index >= 0);
  if (indexes.length !== 1) {
    throw new InstallerValidationError(`loaded launchd job has invalid ${name} block`);
  }
  const start = indexes[0]!;
  const end = lines.indexOf('\t}', start + 1);
  if (end < 0) throw new InstallerValidationError(`loaded launchd job has unterminated ${name} block`);
  const values = lines.slice(start + 1, end);
  if (values.some((line) => !line.startsWith('\t\t'))) {
    throw new InstallerValidationError(`loaded launchd job has malformed ${name} block`);
  }
  return values.map((line) => line.slice(2));
}

function validateLoadedJobOutput(
  output: string,
  uid: number,
  expected: LoadedJobExpectation,
): LoadedJobState {
  const lines = output.endsWith('\n') ? output.slice(0, -1).split('\n') : output.split('\n');
  if (lines[0] !== `gui/${uid}/com.pxpipe.proxy = {`) {
    throw new InstallerValidationError('loaded launchd job identity is malformed');
  }
  const logs = localLogPaths(expected.paths.home);
  const expectedCli = path.join(expected.paths.current, 'bin', 'cli.js');
  if (
    oneTopLevelScalar(lines, 'path') !== expected.paths.launchAgent
    || oneTopLevelScalar(lines, 'type') !== 'LaunchAgent'
    || oneTopLevelScalar(lines, 'program') !== expected.nodeExecutable
    || oneTopLevelScalar(lines, 'stdout path') !== logs.stdout
    || oneTopLevelScalar(lines, 'stderr path') !== logs.stderr
  ) throw new InstallerValidationError('loaded launchd job does not match the managed service definition');

  const argumentsBlock = topLevelBlock(lines, 'arguments');
  if (
    argumentsBlock.length !== 2
    || argumentsBlock[0] !== expected.nodeExecutable
    || argumentsBlock[1] !== expectedCli
  ) throw new InstallerValidationError('loaded launchd job arguments do not match the managed service');

  const environmentBlock = topLevelBlock(lines, 'environment');
  const environment = new Map<string, string>();
  for (const line of environmentBlock) {
    const separator = line.indexOf(' => ');
    if (separator <= 0) throw new InstallerValidationError('loaded launchd job environment is malformed');
    const key = line.slice(0, separator);
    const value = line.slice(separator + 4);
    if (environment.has(key)) throw new InstallerValidationError('loaded launchd job environment has duplicates');
    environment.set(key, value);
  }
  const expectedEnvironment = new Map<string, string>([
    ['HOST', '127.0.0.1'],
    ['PORT', String(expected.port)],
    ['PXPIPE_MODELS', INSTALLED_MODELS],
    ...(expected.environment === 'managed'
      ? [
          ['PXPIPE_CODEX_UPSTREAM', CODEX_SUBSCRIPTION_UPSTREAM],
          ['PXPIPE_GROK_UPSTREAM', GROK_SUBSCRIPTION_UPSTREAM],
        ] as Array<[string, string]>
      : []),
  ]);
  for (const [key, value] of expectedEnvironment) {
    if (environment.get(key) !== value) {
      throw new InstallerValidationError(`loaded launchd job environment does not match ${key}`);
    }
  }
  for (const [key, value] of environment) {
    if (expectedEnvironment.has(key)) continue;
    if (key === 'OSLogRateLimit') continue;
    if (key === 'XPC_SERVICE_NAME' && value === 'com.pxpipe.proxy') continue;
    throw new InstallerValidationError(`loaded launchd job has unexpected environment field: ${key}`);
  }

  const state = oneTopLevelScalar(lines, 'state');
  const pidLines = lines.filter((line) => line.startsWith('\tpid = '));
  if (pidLines.length > 1) throw new InstallerValidationError('loaded launchd job has duplicate top-level pid');
  const pid = pidLines.length === 1 ? pidLines[0]!.slice('\tpid = '.length) : undefined;
  if (pid !== undefined && !/^[1-9][0-9]*$/u.test(pid)) {
    throw new InstallerValidationError('loaded launchd job has malformed top-level pid');
  }
  return { state, pid };
}

async function inspectExpectedLoadedJob(
  uid: number,
  runner: CommandRunner,
  expected: LoadedJobExpectation,
): Promise<LoadedJobState | undefined> {
  const label = `gui/${uid}/com.pxpipe.proxy`;
  const inspected = await runner('launchctl', ['print', label]);
  if (inspected.code !== 0) {
    if (!await serviceLoadedStrict(uid, async () => inspected)) return undefined;
    throw new InstallerValidationError('launchctl returned inconsistent service state');
  }
  let output: string;
  let errorOutput: string;
  try {
    output = decoder.decode(inspected.stdout);
    errorOutput = decoder.decode(inspected.stderr);
  } catch {
    throw new InstallerValidationError('launchctl returned malformed service status');
  }
  if (errorOutput !== '' || output.trim() === '') {
    throw new InstallerValidationError('launchctl returned malformed service status');
  }
  return validateLoadedJobOutput(output, uid, expected);
}

async function verifyServiceOwnsListener(
  uid: number,
  port: number,
  runner: CommandRunner,
  sleep: (milliseconds: number) => Promise<void>,
  expectedJob: LoadedJobExpectation,
): Promise<void> {
  const label = `gui/${uid}/com.pxpipe.proxy`;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const inspected = await runner('launchctl', ['print', label]);
    if (inspected.code !== 0) {
      if (!await serviceLoadedStrict(uid, async () => inspected)) {
        await sleep(100);
        continue;
      }
      throw new InstallerValidationError('installed launchd job is not running');
    }
    if (inspected.stderr.byteLength !== 0) {
      throw new InstallerValidationError('launchctl returned malformed running-state output');
    }
    let loadedJob: LoadedJobState;
    try {
      loadedJob = validateLoadedJobOutput(decoder.decode(inspected.stdout), uid, expectedJob);
    } catch (error) {
      if (error instanceof InstallerValidationError) throw error;
      throw new InstallerValidationError('launchctl returned malformed running-state output');
    }
    if (loadedJob.state !== 'running') {
      await sleep(100);
      continue;
    }
    if (loadedJob.pid === undefined) throw new InstallerValidationError('launchctl did not report one running pxpipe PID');
    const jobPid = loadedJob.pid;

    const listeners = await runner('lsof', [
      '-w', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
    ]);
    if (listeners.code === 1 && listeners.stdout.byteLength === 0 && listeners.stderr.byteLength === 0) {
      await sleep(100);
      continue;
    }
    if (listeners.code !== 0 || listeners.stderr.byteLength !== 0) {
      throw new InstallerValidationError('lsof could not prove installed listener ownership');
    }
    let listenerPids: string[];
    try {
      listenerPids = decoder.decode(listeners.stdout).split(/\r?\n/u).filter(Boolean);
    } catch {
      throw new InstallerValidationError('lsof returned malformed listener output');
    }
    if (listenerPids.length !== 1 || !/^[1-9][0-9]*$/u.test(listenerPids[0]!) || listenerPids[0] !== jobPid) {
      throw new InstallerValidationError('selected port is not owned solely by the installed pxpipe job');
    }

    const binding = await runner('lsof', [
      '-w', '-nP', '-a', '-p', jobPid, `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn',
    ]);
    if (binding.code === 1 && binding.stdout.byteLength === 0 && binding.stderr.byteLength === 0) {
      await sleep(100);
      continue;
    }
    if (binding.code !== 0 || binding.stderr.byteLength !== 0) {
      throw new InstallerValidationError('lsof could not prove the installed listener binding');
    }
    let bindingLines: string[];
    try {
      bindingLines = decoder.decode(binding.stdout).split(/\r?\n/u).filter(Boolean);
    } catch {
      throw new InstallerValidationError('lsof returned malformed listener binding output');
    }
    const processLines = bindingLines.filter((line) => line.startsWith('p'));
    const descriptorLines = bindingLines.filter((line) => line.startsWith('f'));
    const nameLines = bindingLines.filter((line) => line.startsWith('n'));
    if (
      processLines.length !== 1
      || processLines[0] !== `p${jobPid}`
      || descriptorLines.length === 0
      || descriptorLines.some((line) => line.length === 1)
      || nameLines.length !== 1
      || nameLines[0] !== `n127.0.0.1:${port}`
      || processLines.length + descriptorLines.length + nameLines.length !== bindingLines.length
    ) throw new InstallerValidationError('installed pxpipe listener is not bound exactly to 127.0.0.1');
    return;
  }
  throw new InstallerValidationError('installed pxpipe job did not acquire its selected port');
}

async function waitForPortFreeApp(
  port: number,
  runner: CommandRunner,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const inspected = await runner('lsof', [
      '-w', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
    ]);
    if (inspected.code === 1 && inspected.stdout.byteLength === 0 && inspected.stderr.byteLength === 0) return;
    if (inspected.code !== 0 || inspected.stderr.byteLength !== 0) {
      throw new InstallerValidationError(`lsof could not prove port ${port} is free`);
    }
    let listenerPids: string[];
    try {
      listenerPids = decoder.decode(inspected.stdout).split(/\r?\n/u).filter(Boolean);
    } catch {
      throw new InstallerValidationError('lsof returned malformed listener state');
    }
    if (listenerPids.length === 0 || listenerPids.some((pid) => !/^[1-9][0-9]*$/u.test(pid))) {
      throw new InstallerValidationError('lsof returned malformed listener state');
    }
    await sleep(100);
  }
  throw new InstallerValidationError(`port ${port} remains in use`);
}

async function ensureClientDirectory(directory: string, desiredMode: number, uid: number): Promise<void> {
  const stat = await lstatOrAbsent(directory);
  if (stat === undefined) {
    await fs.mkdir(directory, { mode: 0o700 });
    await fsyncDirectory(path.dirname(directory));
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
    throw new InstallerValidationError(`client directory became unsafe: ${directory}`);
  }
  if ((stat.mode & 0o777) !== desiredMode) {
    throw new InstallerValidationError(`client directory mode changed during installation: ${directory}`);
  }
}

async function writeClientCandidate(
  file: string,
  candidate: Uint8Array | null,
  mode: number,
  prior: ResourceIdentity,
  adapter: TransactionResourceAdapter,
): Promise<void> {
  const current = await adapter.currentIdentity();
  if (!sameResourceIdentity(current, prior)) {
    throw new InstallerValidationError(`client config changed before write: ${file}`);
  }
  if (candidate === null) {
    await fs.rm(file, { force: true });
    await fsyncDirectory(path.dirname(file));
  } else {
    await atomicWriteFsync(file, candidate, { mode, label: `client:${path.basename(path.dirname(file))}` });
  }
}

function manifestBytes(manifest: BundleManifest): Uint8Array {
  return encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
}

async function releaseTreeSha256(root: string, uid: number): Promise<string> {
  const records: Array<{ path: string; type: 'directory' | 'file'; mode: number; sha256?: string }> = [];
  const visit = async (directory: string, relative: string): Promise<void> => {
    const before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || before.uid !== uid) {
      throw new InstallerValidationError(`release tree contains an unsafe directory: ${directory}`);
    }
    records.push({ path: relative, type: 'directory', mode: before.mode & 0o777 });
    for (const entry of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, entry);
      const childRelative = relative ? `${relative}/${entry}` : entry;
      const child = await fs.lstat(absolute);
      if (child.isDirectory() && !child.isSymbolicLink()) {
        await visit(absolute, childRelative);
      } else if (child.isFile() && !child.isSymbolicLink() && child.uid === uid) {
        const read = await readOwnerRegularNoFollow(absolute, uid, 'release file');
        records.push({
          path: childRelative,
          type: 'file',
          mode: read.mode,
          sha256: sha256(read.bytes),
        });
      } else {
        throw new InstallerValidationError(`release tree contains an unsafe entry: ${absolute}`);
      }
    }
    const after = await fs.lstat(directory);
    if (
      !after.isDirectory()
      || after.isSymbolicLink()
      || after.uid !== uid
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs
    ) throw new InstallerValidationError(`release directory changed while being hashed: ${directory}`);
  };
  await visit(root, '');
  return sha256(stateBytes(records));
}

interface InstalledManifest {
  readonly version: string;
  readonly sourceCommit: string;
  readonly archive: string;
  readonly sha256: string;
  readonly installerSha256?: string;
}

function parseManifestReceipt(bytes: Uint8Array): InstalledManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new InstallerValidationError('installed release manifest is invalid');
  }
  if (!plainObject(parsed)) throw new InstallerValidationError('installed release manifest is invalid');
  const keys = Object.keys(parsed).sort().join(',');
  if (
    keys !== 'archive,sha256,sourceCommit,version'
    && keys !== 'archive,installer,installerSha256,sha256,sourceCommit,version'
  ) throw new InstallerValidationError('installed release manifest is invalid');
  if (
    typeof parsed.version !== 'string'
    || parsed.version.length === 0
    || parsed.version.includes('/')
    || typeof parsed.sourceCommit !== 'string'
    || !SOURCE_COMMIT.test(parsed.sourceCommit)
    || typeof parsed.archive !== 'string'
    || parsed.archive !== `pxpipe-proxy-${parsed.version}-${parsed.sourceCommit}.tgz`
    || typeof parsed.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/u.test(parsed.sha256)
  ) throw new InstallerValidationError('installed release manifest is invalid');
  if (keys.includes('installer')) {
    if (
      parsed.installer !== INSTALLER_PROGRAM_NAME
      || typeof parsed.installerSha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(parsed.installerSha256)
    ) throw new InstallerValidationError('installed release manifest is invalid');
  }
  return {
    version: parsed.version,
    sourceCommit: parsed.sourceCommit,
    archive: parsed.archive,
    sha256: parsed.sha256,
    ...(typeof parsed.installerSha256 === 'string'
      ? { installerSha256: parsed.installerSha256 }
      : {}),
  };
}

function decodeGeneratedXmlText(value: string, label: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(value)) {
    throw new InstallerValidationError(`${label} contains an unsupported XML entity`);
  }
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function parseGeneratedServicePlist(
  paths: MacosInstallerPaths,
  plistText: string,
): { readonly nodeExecutable: string; readonly port: number } {
  const argumentsMatch = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>\s*<\/array>/u.exec(plistText);
  const ports = [...plistText.matchAll(/<key>PORT<\/key>\s*<string>([1-9][0-9]*)<\/string>/gu)]
    .map((match) => Number(match[1]));
  if (argumentsMatch === null || ports.length !== 1 || ports[0]! > 65_535) {
    throw new InstallerValidationError('receipt-free service plist is malformed');
  }
  const nodeExecutable = decodeGeneratedXmlText(argumentsMatch[1]!, 'receipt-free Node path');
  const releaseCli = decodeGeneratedXmlText(argumentsMatch[2]!, 'receipt-free command path');
  if (!path.isAbsolute(nodeExecutable) || releaseCli !== path.join(paths.current, 'bin', 'cli.js')) {
    throw new InstallerValidationError('receipt-free service command is invalid');
  }
  return { nodeExecutable, port: ports[0]! };
}

async function validateManagedInstallationArtifacts(
  paths: MacosInstallerPaths,
  receipt: LocalInstallReceiptPayload,
  uid: number,
  runner: CommandRunner,
  sleep: (milliseconds: number) => Promise<void>,
  proveRuntime: boolean,
): Promise<void> {
  const current = await lstatOrAbsent(paths.current);
  const expectedRelease = path.join(paths.releases, receipt.sourceCommit);
  if (current === undefined || !current.isSymbolicLink() || current.uid !== uid) {
    throw new InstallerValidationError('managed current release link drifted');
  }
  const currentTarget = path.resolve(path.dirname(paths.current), await fs.readlink(paths.current));
  if (currentTarget !== expectedRelease) {
    throw new InstallerValidationError('managed current release link drifted');
  }
  const release = await lstatOrAbsent(expectedRelease);
  if (
    release === undefined
    || !release.isDirectory()
    || release.isSymbolicLink()
    || release.uid !== uid
    || (release.mode & 0o022) !== 0
  ) throw new InstallerValidationError('managed release directory drifted');
  const installedManifest = parseManifestReceipt((await readOwnerRegularNoFollow(
    path.join(expectedRelease, '.pxpipe-manifest.json'),
    uid,
    'managed release manifest',
  )).bytes);
  if (
    installedManifest.sourceCommit !== receipt.sourceCommit
    || installedManifest.version !== receipt.version
    || installedManifest.archive !== `pxpipe-proxy-${receipt.version}-${receipt.sourceCommit}.tgz`
    || installedManifest.sha256 !== receipt.archiveSha256
  ) throw new InstallerValidationError('managed release manifest drifted');
  if (await releaseTreeSha256(expectedRelease, uid) !== receipt.releaseTreeSha256) {
    throw new InstallerValidationError('managed release tree drifted');
  }

  const plist = await readOwnerRegularNoFollow(
    paths.launchAgent,
    uid,
    'managed LaunchAgent',
  );
  if (
    plist.mode !== 0o600
    || !Buffer.from(plist.bytes).equals(Buffer.from(buildLocalLaunchAgentPlist(
      paths,
      receipt.port,
      receipt.nodeExecutable,
    )))
  ) throw new InstallerValidationError('managed LaunchAgent drifted');
  const logs = localLogPaths(paths.home);
  await validateLocalLogPaths(logs, uid);
  for (const artifact of [logs.directory, logs.stdout, logs.stderr]) {
    if (await lstatOrAbsent(artifact) === undefined) {
      throw new InstallerValidationError(`managed service artifact is missing: ${artifact}`);
    }
  }
  const expectedJob: LoadedJobExpectation = {
    paths,
    nodeExecutable: receipt.nodeExecutable,
    port: receipt.port,
    environment: 'managed',
  };
  if (await inspectExpectedLoadedJob(uid, runner, expectedJob) === undefined) {
    throw new InstallerValidationError('managed launchd service is not loaded');
  }
  if (proveRuntime) {
    await verifyServiceOwnsListener(uid, receipt.port, runner, sleep, expectedJob);
    await createMacosServiceOperations({
      paths,
      uid,
      port: receipt.port,
      runner,
      sleep,
    }).healthCheck();
  }
}

async function validateLegacyService(
  paths: MacosInstallerPaths,
  uid: number,
  runner: CommandRunner,
  sleep: (milliseconds: number) => Promise<void>,
  allowedIdentity: LegacyAdoptionIdentity,
): Promise<number | undefined> {
  const current = await lstatOrAbsent(paths.current);
  const plist = await lstatOrAbsent(paths.launchAgent);
  const loaded = await serviceLoadedStrict(uid, runner);
  if (current === undefined && plist === undefined) {
    if (loaded) throw new InstallerValidationError('receipt-free launchd service exists without managed artifacts');
    return undefined;
  }
  if (current === undefined || plist === undefined || !current.isSymbolicLink() || !plist.isFile() || plist.isSymbolicLink()) {
    throw new InstallerValidationError('receipt-free service is incomplete and cannot be adopted');
  }
  if (current.uid !== uid || plist.uid !== uid) throw new InstallerValidationError('receipt-free service ownership is invalid');
  const target = await fs.readlink(paths.current);
  const resolvedTarget = path.resolve(path.dirname(paths.current), target);
  const releasesPrefix = `${path.resolve(paths.releases)}${path.sep}`;
  if (!resolvedTarget.startsWith(releasesPrefix) || !SOURCE_COMMIT.test(path.basename(resolvedTarget))) {
    throw new InstallerValidationError('receipt-free current link is not a verified release');
  }
  const releaseStat = await fs.lstat(resolvedTarget);
  if (
    !releaseStat.isDirectory()
    || releaseStat.isSymbolicLink()
    || releaseStat.uid !== uid
    || (releaseStat.mode & 0o022) !== 0
  ) throw new InstallerValidationError('receipt-free release directory is unsafe');
  const receiptPath = path.join(resolvedTarget, '.pxpipe-manifest.json');
  const receiptStat = await lstatOrAbsent(receiptPath);
  if (receiptStat === undefined || !receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.uid !== uid) {
    throw new InstallerValidationError('receipt-free release lacks its manifest');
  }
  const releaseManifest = parseManifestReceipt((await readOwnerRegularNoFollow(
    receiptPath,
    uid,
    'receipt-free release manifest',
  )).bytes);
  if (releaseManifest.sourceCommit !== path.basename(resolvedTarget)) {
    throw new InstallerValidationError('receipt-free release source does not match its path');
  }
  if (
    releaseManifest.sourceCommit !== allowedIdentity.sourceCommit
    || releaseManifest.version !== allowedIdentity.version
    || releaseManifest.sha256 !== allowedIdentity.archiveSha256
  ) throw new InstallerValidationError('receipt-free release is not the approved legacy build');
  const required = [
    path.join(resolvedTarget, 'package.json'),
    path.join(resolvedTarget, 'bin', 'cli.js'),
    path.join(resolvedTarget, 'dist', 'node.js'),
  ];
  for (const file of required) await readOwnerRegularNoFollow(file, uid, 'receipt-free release file');
  const packageJson = JSON.parse(decoder.decode((await readOwnerRegularNoFollow(
    required[0]!,
    uid,
    'receipt-free package.json',
  )).bytes)) as { name?: unknown; version?: unknown };
  if (packageJson.name !== 'pxpipe-proxy' || packageJson.version !== releaseManifest.version) {
    throw new InstallerValidationError('receipt-free package version does not match its manifest');
  }
  if (
    releaseManifest.installerSha256 !== undefined
    && sha256((await readOwnerRegularNoFollow(
      path.join(resolvedTarget, 'dist', 'macos-local-installer.js'),
      uid,
      'receipt-free packaged installer',
    )).bytes) !== releaseManifest.installerSha256
  ) throw new InstallerValidationError('receipt-free packaged installer does not match its manifest');

  const plistText = decoder.decode((await readOwnerRegularNoFollow(
    paths.launchAgent,
    uid,
    'receipt-free LaunchAgent',
  )).bytes);
  const service = parseGeneratedServicePlist(paths, plistText);
  const expectedCurrent = decoder.decode(buildLocalLaunchAgentPlist(
    paths,
    service.port,
    service.nodeExecutable,
  ));
  const expectedPinnedLegacy = decoder.decode(buildPinnedLegacyLaunchAgentPlist(
    paths,
    service.port,
    service.nodeExecutable,
  ));
  const environment = plistText === expectedPinnedLegacy
    ? 'legacy'
    : plistText === expectedCurrent
      ? 'managed'
      : undefined;
  if (environment === undefined) {
    throw new InstallerValidationError('receipt-free service failed adoption checks');
  }
  const logs = localLogPaths(paths.home);
  for (const artifact of [logs.directory, logs.stdout, logs.stderr]) {
    if (await lstatOrAbsent(artifact) === undefined) {
      throw new InstallerValidationError(`receipt-free service artifact is missing: ${artifact}`);
    }
  }

  const versionResult = await runner(service.nodeExecutable, [required[1]!, '--version']);
  if (
    versionResult.code !== 0
    || decoder.decode(versionResult.stderr) !== ''
    || decoder.decode(versionResult.stdout).trim() !== releaseManifest.version
  ) throw new InstallerValidationError('receipt-free packaged command reported the wrong version');

  if (await releaseTreeSha256(resolvedTarget, uid) !== allowedIdentity.releaseTreeSha256) {
    throw new InstallerValidationError('receipt-free release tree is not the approved legacy build');
  }
  if (!loaded) throw new InstallerValidationError('receipt-free service failed adoption checks');
  const expectedJob: LoadedJobExpectation = {
    paths,
    nodeExecutable: service.nodeExecutable,
    port: service.port,
    environment,
  };
  if (await inspectExpectedLoadedJob(uid, runner, expectedJob) === undefined) {
    throw new InstallerValidationError('receipt-free service failed adoption checks');
  }
  await verifyServiceOwnsListener(uid, service.port, runner, sleep, expectedJob);
  await createMacosServiceOperations({ paths, uid, port: service.port, runner, sleep }).healthCheck();
  return service.port;
}

async function directoryWillRemain(directory: string, managedFile: string): Promise<boolean> {
  const stat = await lstatOrAbsent(directory);
  if (stat === undefined) return false;
  const entries = await fs.readdir(directory);
  return entries.some((entry) => entry !== path.basename(managedFile));
}

async function cleanupAppDebris(paths: MacosInstallerPaths): Promise<void> {
  for (const [directory, pattern] of [
    [paths.stateRoot, /^\.candidate-[0-9a-f]{32}$/u],
    [paths.installRoot, /^\.current-[0-9a-f]{32}$/u],
  ] as const) {
    const entries = await fs.readdir(directory).catch((error) => {
      if (errno(error) === 'ENOENT') return [] as string[];
      throw error;
    });
    let changed = false;
    for (const entry of entries) {
      if (!pattern.test(entry)) continue;
      await fs.rm(path.join(directory, entry), { recursive: true, force: true });
      changed = true;
    }
    if (changed) await fsyncDirectory(directory);
  }
}

class LocalOperationAdapter implements InstallerOperationAdapter {
  readonly recoveryResources: readonly TransactionResourceAdapter[];
  private readonly releaseMaterial: ReleaseInventoryAdapter;
  private readonly releasePointer: TransactionResourceAdapter;
  private readonly serviceDefinition: TransactionResourceAdapter;
  private readonly serviceState: TransactionResourceAdapter;
  private readonly codexFile: TransactionResourceAdapter;
  private readonly grokFile: TransactionResourceAdapter;
  private readonly codexDirectory: TransactionResourceAdapter;
  private readonly grokDirectory: TransactionResourceAdapter;
  private stagingDirectory: string | undefined;
  private extractedPackage: Awaited<ReturnType<typeof extractVerifiedPackage>> | undefined;
  private desiredRelease: string;
  private candidateReleaseSha256: string | undefined;
  private plistBytes: Uint8Array = new Uint8Array();
  private codexState: SafeClientFile | undefined;
  private grokState: SafeClientFile | undefined;
  private codexInstall: ClientConfigCandidate | undefined;
  private grokInstall: ClientConfigCandidate | undefined;
  private codexUninstall: ClientUninstallCandidate | undefined;
  private grokUninstall: ClientUninstallCandidate | undefined;
  private removeCodexDirectory = false;
  private removeGrokDirectory = false;
  private preparedPrior = new Map<string, ResourceIdentity>();
  private preparedResources: PreparedInstallerOperation['resources'] = [];
  private priorReleaseMaterial: ReleaseInventoryState | undefined;
  private priorReceiptPort: number | undefined;

  constructor(
    private readonly operation: InstallerOperation,
    private readonly paths: MacosInstallerPaths,
    private readonly uid: number,
    private readonly port: number,
    private readonly verified: Awaited<ReturnType<typeof validateInstallerBundle>>,
    private readonly runner: CommandRunner,
    private readonly sleep: ((milliseconds: number) => Promise<void>) | undefined,
    private readonly nodeExecutable: string,
    private readonly transactionId: string,
    private readonly nonce: () => string,
    private readonly legacyAdoptionIdentity: LegacyAdoptionIdentity,
  ) {
    const service = createMacosServiceOperations({ paths, uid, port, runner, sleep });
    this.desiredRelease = path.join(paths.releases, verified.manifest.sourceCommit);
    this.releaseMaterial = createReleaseMaterialAdapter(paths, uid);
    this.releasePointer = createReleasePointerAdapter(paths, uid);
    this.serviceDefinition = createFileResourceAdapter('serviceDefinition', paths.launchAgent);
    this.serviceState = createServiceStateAdapter(
      paths,
      uid,
      runner,
      () => service.start(),
      () => service.stop(),
    );
    this.codexFile = createClientFileAdapter('codexConfig', paths.codexConfig);
    this.grokFile = createClientFileAdapter('grokConfig', paths.grokConfig);
    this.codexDirectory = createDirectoryAdapter('codexDirectory', path.dirname(paths.codexConfig), uid);
    this.grokDirectory = createDirectoryAdapter('grokDirectory', path.dirname(paths.grokConfig), uid);
    // Core rolls back in reverse: pointer, plist, launchd state, clients,
    // directories, then removal of only the newly materialized release.
    this.recoveryResources = [
      this.releaseMaterial,
      this.codexDirectory,
      this.grokDirectory,
      this.codexFile,
      this.grokFile,
      this.serviceState,
      this.serviceDefinition,
      this.releasePointer,
    ];
  }

  private async capturePrepared(): Promise<void> {
    this.preparedPrior = new Map();
    for (const resource of this.recoveryResources) {
      if (resource === this.releaseMaterial) {
        const captured = await resource.capture();
        if (captured.snapshot === null) throw new InstallerValidationError('release inventory snapshot is missing');
        this.priorReleaseMaterial = JSON.parse(decoder.decode(captured.snapshot)) as ReleaseInventoryState;
        this.preparedPrior.set(resource.name, captured.identity);
      } else {
        this.preparedPrior.set(resource.name, await resource.currentIdentity());
      }
    }
  }

  private prior(resource: TransactionResourceAdapter): ResourceIdentity {
    const identity = this.preparedPrior.get(resource.name);
    if (identity === undefined) throw new InstallerValidationError(`missing preflight identity for ${resource.name}`);
    return identity;
  }

  private resources(values: ReadonlyMap<string, ResourceIdentity>): PreparedInstallerOperation['resources'] {
    return this.recoveryResources.map((adapter) => {
      const applied = values.get(adapter.name);
      if (applied === undefined) throw new InstallerValidationError(`missing applied identity for ${adapter.name}`);
      return { adapter, applied };
    });
  }

  async preflight(
    operation: InstallerOperation,
    receiptEnvelope: Parameters<InstallerOperationAdapter['preflight']>[1],
  ): Promise<PreparedInstallerOperation> {
    if (operation !== this.operation) throw new InstallerValidationError('operation changed during install');
    await cleanupAppDebris(this.paths);
    await validateLaunchAgentPath(this.paths, this.uid);
    await validateLocalLogPaths(localLogPaths(this.paths.home), this.uid);
    const retrySleep = this.sleep
      ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    this.codexState = await readSafeClientFile(this.paths.codexConfig, this.uid);
    this.grokState = await readSafeClientFile(this.paths.grokConfig, this.uid);
    const receipt = receiptEnvelope?.envelope.payload as LocalInstallReceiptPayload | undefined;

    if (receipt !== undefined) {
      this.priorReceiptPort = receipt.port;
      if (
        this.codexState.fileMode !== receipt.codex.fileMode
        || this.grokState.fileMode !== receipt.grok.fileMode
        || this.codexState.directoryMode !== receipt.codex.directoryMode
        || this.grokState.directoryMode !== receipt.grok.directoryMode
      ) throw new InstallerValidationError('managed client ownership or mode changed');
      await validateManagedInstallationArtifacts(
        this.paths,
        receipt,
        this.uid,
        this.runner,
        retrySleep,
        operation === 'install',
      );
    }

    if (receipt === undefined) {
      const footprints = [
        ...(this.codexState.bytes === null ? [] : findLegacyFootprints('codex', this.codexState.bytes)),
        ...(this.grokState.bytes === null ? [] : findLegacyFootprints('grok', this.grokState.bytes)),
      ];
      if (footprints.length > 0) {
        throw new InstallerValidationError(`managed client footprint exists without a receipt: ${footprints.join(', ')}`);
      }
      this.priorReceiptPort = await validateLegacyService(
        this.paths,
        this.uid,
        this.runner,
        retrySleep,
        this.legacyAdoptionIdentity,
      );
      if (operation === 'uninstall') {
        const current = await lstatOrAbsent(this.paths.current);
        const plist = await lstatOrAbsent(this.paths.launchAgent);
        if (current === undefined && plist === undefined) {
          return { noOp: true, resources: [], intendedReceiptBytes: null };
        }
        throw new InstallerValidationError('service exists without a managed receipt');
      }
    }

    await this.capturePrepared();
    const applied = new Map<string, ResourceIdentity>();

    if (operation === 'install') {
      try {
        this.codexInstall = buildClientCandidate(
          'codex',
          this.codexState.bytes,
          this.port,
          receipt?.codex.config,
        );
        this.grokInstall = buildClientCandidate(
          'grok',
          this.grokState.bytes,
          this.port,
          receipt?.grok.config,
        );
      } catch (error) {
        throw new InstallerValidationError(`client configuration cannot be managed safely: ${(error as Error).message}`);
      }
      this.plistBytes = buildLocalLaunchAgentPlist(
        this.paths,
        this.port,
        this.nodeExecutable,
      );

      const currentTarget = await lstatOrAbsent(this.paths.current);
      const currentLink = currentTarget?.isSymbolicLink() ? await fs.readlink(this.paths.current) : undefined;
      const plistCurrent = await lstatOrAbsent(this.paths.launchAgent);
      const plistEqual = plistCurrent?.isFile()
        ? Buffer.from(await fs.readFile(this.paths.launchAgent)).equals(Buffer.from(this.plistBytes))
        : false;
      let releaseMatchesReceipt = false;
      if (
        receipt !== undefined
        && receipt.sourceCommit === this.verified.manifest.sourceCommit
        && receipt.archiveSha256 === this.verified.manifest.sha256
      ) {
        const releaseStat = await lstatOrAbsent(this.desiredRelease);
        releaseMatchesReceipt = releaseStat !== undefined
          && releaseStat.isDirectory()
          && !releaseStat.isSymbolicLink()
          && await releaseTreeSha256(this.desiredRelease, this.uid) === receipt.releaseTreeSha256;
      }
      const noOp = receipt !== undefined
        && receipt.sourceCommit === this.verified.manifest.sourceCommit
        && receipt.version === this.verified.manifest.version
        && receipt.port === this.port
        && receipt.nodeExecutable === this.nodeExecutable
        && releaseMatchesReceipt
        && !this.codexInstall.changed
        && !this.grokInstall.changed
        && currentLink !== undefined
        && path.resolve(path.dirname(this.paths.current), currentLink) === this.desiredRelease
        && plistEqual;
      if (noOp) {
        return { noOp: true, resources: [], intendedReceiptBytes: receiptEnvelope!.bytes };
      }

      this.stagingDirectory = path.join(this.paths.stateRoot, `.candidate-${this.nonce()}`);
      this.extractedPackage = await extractVerifiedPackage(this.verified, this.stagingDirectory, this.runner);
      await fs.writeFile(
        path.join(this.extractedPackage.packageDirectory, '.pxpipe-manifest.json'),
        manifestBytes(this.verified.manifest),
        { mode: 0o600 },
      );
      this.candidateReleaseSha256 = await releaseTreeSha256(
        this.extractedPackage.packageDirectory,
        this.uid,
      );
      const sameSourceRelease = await lstatOrAbsent(this.desiredRelease);
      if (
        sameSourceRelease !== undefined
        && (
          !sameSourceRelease.isDirectory()
          || sameSourceRelease.isSymbolicLink()
          || await releaseTreeSha256(this.desiredRelease, this.uid) !== this.candidateReleaseSha256
        )
      ) throw new InstallerValidationError('same source commit release files differ from the verified package');

      if (this.priorReleaseMaterial === undefined) {
        throw new InstallerValidationError('release inventory was not captured');
      }
      const releaseEntries = this.priorReleaseMaterial.entries.filter((entry) =>
        entry.name !== this.verified.manifest.sourceCommit
      );
      releaseEntries.push({
        name: this.verified.manifest.sourceCommit,
        manifestSha256: sha256(manifestBytes(this.verified.manifest)),
      });
      releaseEntries.sort((left, right) => left.name.localeCompare(right.name));
      applied.set('releaseMaterial', desiredReleaseMaterialIdentity(this.uid, {
        existed: true,
        entries: releaseEntries,
      }));
      applied.set('releasePointer', desiredReleasePointerIdentity(this.uid, this.desiredRelease));
      applied.set('serviceDefinition', presentIdentity(this.uid, 0o600, this.plistBytes));
      applied.set('serviceState', desiredServiceIdentity(this.uid, true));
      applied.set('codexDirectory', desiredDirectoryIdentity(
        this.uid,
        true,
        this.codexState.directoryExisted ? this.codexState.directoryMode : 0o700,
      ));
      applied.set('grokDirectory', desiredDirectoryIdentity(
        this.uid,
        true,
        this.grokState.directoryExisted ? this.grokState.directoryMode : 0o700,
      ));
      applied.set('codexConfig', presentIdentity(this.uid, this.codexState.fileMode, this.codexInstall.bytes));
      applied.set('grokConfig', presentIdentity(this.uid, this.grokState.fileMode, this.grokInstall.bytes));
      const payload: LocalInstallReceiptPayload = {
        schemaVersion: 1,
        sourceCommit: this.verified.manifest.sourceCommit,
        version: this.verified.manifest.version,
        archiveSha256: this.verified.manifest.sha256,
        releaseTreeSha256: this.candidateReleaseSha256,
        port: this.port,
        nodeExecutable: this.nodeExecutable,
        codex: {
          config: this.codexInstall.receipt,
          fileMode: this.codexState.fileMode,
          directoryExisted: receipt?.codex.directoryExisted ?? this.codexState.directoryExisted,
          directoryMode: receipt?.codex.directoryMode ?? this.codexState.directoryMode,
        },
        grok: {
          config: this.grokInstall.receipt,
          fileMode: this.grokState.fileMode,
          directoryExisted: receipt?.grok.directoryExisted ?? this.grokState.directoryExisted,
          directoryMode: receipt?.grok.directoryMode ?? this.grokState.directoryMode,
        },
      };
      this.preparedResources = this.resources(applied);
      return {
        noOp: false,
        resources: this.preparedResources,
        intendedReceiptBytes: serializeReceipt(this.transactionId, payload),
      };
    }

    if (receipt === undefined || this.codexState.bytes === null || this.grokState.bytes === null) {
      throw new InstallerValidationError('managed install receipt or client file is missing');
    }
    try {
      this.codexUninstall = buildUninstallCandidate(this.codexState.bytes, receipt.codex.config);
      this.grokUninstall = buildUninstallCandidate(this.grokState.bytes, receipt.grok.config);
    } catch (error) {
      throw new InstallerValidationError(`managed client configuration drifted: ${(error as Error).message}`);
    }
    this.plistBytes = new Uint8Array();
    const codexRemain = this.codexUninstall.bytes !== null
      || receipt.codex.directoryExisted
      || await directoryWillRemain(path.dirname(this.paths.codexConfig), this.paths.codexConfig);
    const grokRemain = this.grokUninstall.bytes !== null
      || receipt.grok.directoryExisted
      || await directoryWillRemain(path.dirname(this.paths.grokConfig), this.paths.grokConfig);
    this.removeCodexDirectory = !codexRemain;
    this.removeGrokDirectory = !grokRemain;
    if (this.priorReleaseMaterial === undefined) {
      throw new InstallerValidationError('release inventory was not captured');
    }
    applied.set('releaseMaterial', desiredReleaseMaterialIdentity(this.uid, this.priorReleaseMaterial));
    applied.set('releasePointer', desiredReleasePointerIdentity(this.uid, null));
    applied.set('serviceDefinition', { exists: false });
    applied.set('serviceState', desiredServiceIdentity(this.uid, false));
    applied.set('codexDirectory', desiredDirectoryIdentity(
      this.uid,
      codexRemain,
      receipt.codex.directoryMode,
    ));
    applied.set('grokDirectory', desiredDirectoryIdentity(
      this.uid,
      grokRemain,
      receipt.grok.directoryMode,
    ));
    applied.set(
      'codexConfig',
      this.codexUninstall.bytes === null
        ? { exists: false }
        : presentIdentity(this.uid, receipt.codex.fileMode, this.codexUninstall.bytes),
    );
    applied.set(
      'grokConfig',
      this.grokUninstall.bytes === null
        ? { exists: false }
        : presentIdentity(this.uid, receipt.grok.fileMode, this.grokUninstall.bytes),
    );
    this.preparedResources = this.resources(applied);
    return { noOp: false, resources: this.preparedResources, intendedReceiptBytes: null };
  }

  async materializeRelease(): Promise<void> {
    if (this.extractedPackage === undefined || this.candidateReleaseSha256 === undefined) {
      throw new InstallerValidationError('package was not preflighted');
    }
    await fs.mkdir(this.paths.releases, { recursive: true, mode: 0o700 });
    const existing = await lstatOrAbsent(this.desiredRelease);
    if (existing === undefined) {
      await fs.rename(this.extractedPackage.packageDirectory, this.desiredRelease);
      await fsyncDirectory(this.paths.releases);
    } else {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new InstallerValidationError('release path is not a normal directory');
      }
      const installed = parseManifestReceipt(
        (await readOwnerRegularNoFollow(
          path.join(this.desiredRelease, '.pxpipe-manifest.json'),
          this.uid,
          'installed release manifest',
        )).bytes,
      );
      if (installed.sourceCommit !== this.verified.manifest.sourceCommit || installed.sha256 !== this.verified.manifest.sha256) {
        throw new InstallerValidationError('same source commit is installed with different contents');
      }
      if (await releaseTreeSha256(this.desiredRelease, this.uid) !== this.candidateReleaseSha256) {
        throw new InstallerValidationError('same source commit release files differ from the verified package');
      }
    }
  }

  async switchService(): Promise<void> {
    const service = createMacosServiceOperations({
      paths: this.paths,
      uid: this.uid,
      port: this.port,
      runner: this.runner,
      sleep: this.sleep,
    });
    await service.stop();
    const sleep = this.sleep
      ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    if (this.priorReceiptPort !== undefined) {
      await waitForPortFreeApp(this.priorReceiptPort, this.runner, sleep);
    }
    if (this.priorReceiptPort !== this.port) {
      await waitForPortFreeApp(this.port, this.runner, sleep);
    }
    const temporary = path.join(this.paths.installRoot, `.current-${this.nonce()}`);
    await fs.symlink(this.desiredRelease, temporary);
    await fs.rename(temporary, this.paths.current);
    await fsyncDirectory(this.paths.installRoot);
    await ensureLocalLogPaths(localLogPaths(this.paths.home), this.uid);
    await fs.mkdir(path.dirname(this.paths.launchAgent), { recursive: true, mode: 0o700 });
    await atomicWriteFsync(this.paths.launchAgent, this.plistBytes, { mode: 0o600, label: 'launch-agent' });
  }

  async startService(): Promise<void> {
    await createMacosServiceOperations({
      paths: this.paths, uid: this.uid, port: this.port, runner: this.runner, sleep: this.sleep,
    }).start();
  }

  async healthCheckService(): Promise<void> {
    const sleep = this.sleep
      ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    await verifyServiceOwnsListener(this.uid, this.port, this.runner, sleep, {
      paths: this.paths,
      nodeExecutable: this.nodeExecutable,
      port: this.port,
      environment: 'managed',
    });
    await createMacosServiceOperations({
      paths: this.paths, uid: this.uid, port: this.port, runner: this.runner, sleep: this.sleep,
    }).healthCheck();
  }

  async applyCodex(): Promise<void> {
    if (!this.codexState || !this.codexInstall) throw new InstallerValidationError('Codex candidate is missing');
    await ensureClientDirectory(
      path.dirname(this.paths.codexConfig),
      this.codexState.directoryExisted ? this.codexState.directoryMode : 0o700,
      this.uid,
    );
    await writeClientCandidate(
      this.paths.codexConfig,
      this.codexInstall.bytes,
      this.codexState.fileMode,
      this.prior(this.codexFile),
      this.codexFile,
    );
  }

  async applyGrok(): Promise<void> {
    if (!this.grokState || !this.grokInstall) throw new InstallerValidationError('Grok candidate is missing');
    await ensureClientDirectory(
      path.dirname(this.paths.grokConfig),
      this.grokState.directoryExisted ? this.grokState.directoryMode : 0o700,
      this.uid,
    );
    await writeClientCandidate(
      this.paths.grokConfig,
      this.grokInstall.bytes,
      this.grokState.fileMode,
      this.prior(this.grokFile),
      this.grokFile,
    );
  }

  async restoreCodex(): Promise<void> {
    if (!this.codexState || !this.codexUninstall) throw new InstallerValidationError('Codex reversal is missing');
    await writeClientCandidate(
      this.paths.codexConfig,
      this.codexUninstall.bytes,
      this.codexState.fileMode,
      this.prior(this.codexFile),
      this.codexFile,
    );
    if (this.removeCodexDirectory && !await directoryWillRemain(
      path.dirname(this.paths.codexConfig),
      this.paths.codexConfig,
    )) await fs.rmdir(path.dirname(this.paths.codexConfig));
  }

  async restoreGrok(): Promise<void> {
    if (!this.grokState || !this.grokUninstall) throw new InstallerValidationError('Grok reversal is missing');
    await writeClientCandidate(
      this.paths.grokConfig,
      this.grokUninstall.bytes,
      this.grokState.fileMode,
      this.prior(this.grokFile),
      this.grokFile,
    );
    if (this.removeGrokDirectory && !await directoryWillRemain(
      path.dirname(this.paths.grokConfig),
      this.paths.grokConfig,
    )) await fs.rmdir(path.dirname(this.paths.grokConfig));
  }

  async stopAndRemoveService(): Promise<void> {
    const servicePort = this.priorReceiptPort ?? this.port;
    await createMacosServiceOperations({
      paths: this.paths, uid: this.uid, port: servicePort, runner: this.runner, sleep: this.sleep,
    }).stop();
    const sleep = this.sleep
      ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    await waitForPortFreeApp(servicePort, this.runner, sleep);
    await fs.rm(this.paths.launchAgent, { force: true });
    await fsyncDirectory(path.dirname(this.paths.launchAgent));
    await fs.rm(this.paths.current, { force: true });
    await fsyncDirectory(this.paths.installRoot);
  }

  async validateApplied(operation: InstallerOperation): Promise<void> {
    if (
      operation === 'install'
      && (
        this.candidateReleaseSha256 === undefined
        || await releaseTreeSha256(this.desiredRelease, this.uid) !== this.candidateReleaseSha256
      )
    ) throw new InstallerValidationError('installed release changed before receipt commit');
    const resources = operation === 'uninstall'
      ? this.preparedResources.filter((resource) =>
          resource.adapter.name === 'codexConfig'
          || resource.adapter.name === 'grokConfig'
          || resource.adapter.name === 'codexDirectory'
          || resource.adapter.name === 'grokDirectory')
      : this.preparedResources;
    for (const resource of resources) {
      const current = await resource.adapter.currentIdentity();
      if (!sameResourceIdentity(current, resource.applied)) {
        const releaseDetail = resource.adapter === this.releaseMaterial
          ? ` state ${JSON.stringify(await this.releaseMaterial.readState())}`
          : '';
        throw new InstallerValidationError(
          `installed resource did not match candidate: ${resource.adapter.displayPath} `
          + `(expected ${JSON.stringify(resource.applied)}, current ${JSON.stringify(current)})${releaseDetail}`,
        );
      }
    }
  }

  async cleanupCommitted(operation: InstallerOperation): Promise<void> {
    if (operation === 'uninstall') {
      await fs.rm(this.paths.releases, { recursive: true, force: true });
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(decoder.decode((await readOwnerRegularNoFollow(
        this.paths.receipt,
        this.uid,
        'committed receipt',
      )).bytes));
    } catch (error) {
      throw new InstallerValidationError(`committed receipt cannot drive cleanup: ${(error as Error).message}`);
    }
    if (!plainObject(raw) || !Object.prototype.hasOwnProperty.call(raw, 'payload')) {
      throw new InstallerValidationError('committed receipt cannot drive cleanup');
    }
    const committed = validateLocalInstallReceipt(raw.payload);
    const release = path.join(this.paths.releases, committed.sourceCommit);
    const stat = await lstatOrAbsent(release);
    if (
      stat === undefined
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || await releaseTreeSha256(release, this.uid) !== committed.releaseTreeSha256
    ) {
      throw new InstallerValidationError('committed release does not match its durable receipt');
    }
  }

  async cleanupAttempt(): Promise<void> {
    if (this.stagingDirectory !== undefined) {
      await fs.rm(this.stagingDirectory, { recursive: true, force: true });
      await fsyncDirectory(this.paths.stateRoot);
      this.stagingDirectory = undefined;
    }
  }
}

function randomId(): string {
  return randomBytes(16).toString('hex');
}

async function dependencies(options: RunMacosInstallAppOptions): Promise<AppDependencies> {
  const runner = options.runner ?? runCommand;
  const env = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new InstallerValidationError('this installer is macOS-only');
  }
  for (const name of INJECTABLE_NODE_ENVIRONMENT) {
    if (env[name] !== undefined && env[name] !== '') {
      throw new InstallerValidationError(`unsafe Node environment variable is set: ${name}`);
    }
  }
  const processEntry = process.argv[1];
  if (options.entryFile === undefined && processEntry === undefined) {
    throw new InstallerValidationError('installer entry path is unavailable');
  }
  const entryFile = options.entryFile ?? path.resolve(processEntry!);
  const argv = options.argv ?? process.argv.slice(2);
  const home = options.home ?? env.HOME;
  if (!home) throw new InstallerValidationError('HOME is required');
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const commandAvailable = options.commandAvailable
    ?? ((command: string) => executableAvailable(command, env));
  for (const command of [nodeExecutable, ...REQUIRED_COMMANDS]) {
    if (!await commandAvailable(command)) {
      throw new InstallerValidationError(
        `required command not found: ${command === nodeExecutable ? 'node' : command}`,
      );
    }
  }
  const transactionId = options.transactionId ?? randomId();
  if (!SAFE_ID.test(transactionId)) throw new InstallerValidationError('invalid transaction ID');
  const processIdentity = options.processIdentity ?? await currentProcessIdentity(runner);
  return {
    entryFile,
    argv,
    env,
    home,
    runner,
    sleep: options.sleep,
    processIdentity,
    isProcessAlive: options.isProcessAlive ?? createProcessLivenessCheck(runner),
    nodeExecutable,
    transactionId,
    nonce: options.nonce ?? randomId,
    output: options.output ?? ((line) => console.log(line)),
    legacyAdoptionIdentity: validateLegacyAdoptionIdentity(
      options.legacyAdoptionIdentity ?? LEGACY_ADOPTION_IDENTITY,
    ),
  };
}

export async function runMacosInstallApp(
  options: RunMacosInstallAppOptions = {},
): Promise<'changed' | 'no-op'> {
  const deps = await dependencies(options);
  const operation = parseInstallerInvocation(deps.argv);
  const port = parsePort(deps.env.PXPIPE_PORT);
  const verified = await validateInstallerBundle(deps.entryFile, options.expectedBundleHashes);
  const paths = resolveMacosInstallerPaths(deps.home);
  const adapter = new LocalOperationAdapter(
    operation,
    paths,
    deps.processIdentity.uid,
    port,
    verified,
    deps.runner,
    deps.sleep,
    deps.nodeExecutable,
    deps.transactionId,
    deps.nonce,
    deps.legacyAdoptionIdentity,
  );
  let interrupted: NodeJS.Signals | undefined;
  const onSigint = () => { interrupted = 'SIGINT'; };
  const onSigterm = () => { interrupted = 'SIGTERM'; };
  const handleSignals = options.installSignalHandlers ?? true;
  if (handleSignals) {
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  }
  try {
    const result = await runInstallerOperation({
      paths,
      operation,
      lock: {
        process: deps.processIdentity,
        isProcessAlive: deps.isProcessAlive,
        nonce: deps.nonce,
      },
      adapter,
      transactionId: deps.transactionId,
      validateReceiptPayload: validateLocalInstallReceipt,
      hooks: {
        async checkpoint(name) {
          await options.hooks?.checkpoint(name);
          if (interrupted !== undefined) {
            const signal = interrupted;
            interrupted = undefined;
            throw new InstallerValidationError(`installation interrupted by ${signal}`);
          }
        },
      },
    });
    if (result === 'no-op') {
      deps.output(operation === 'install' ? '✓ pxpipe is already installed.' : '✓ pxpipe is already absent.');
    } else if (operation === 'install') {
      deps.output(`✓ pxpipe ${verified.manifest.version} is running at http://127.0.0.1:${port}/`);
      deps.output('  Run: codex');
      deps.output('  Run: grok');
    } else {
      deps.output('✓ pxpipe service and managed client settings were removed.');
    }
    return result;
  } finally {
    if (handleSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  }
}

async function main(): Promise<void> {
  try {
    await runMacosInstallApp();
  } catch (error) {
    console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// esbuild emits this module under a different build-time filename before the
// packager publishes it as the fixed helper name.  The fixed basename is the
// execution contract and survives that relocation; import.meta/argv equality
// does not on every Node/esbuild combination.
if (process.argv[1] !== undefined && path.basename(process.argv[1]) === INSTALLER_PROGRAM_NAME) {
  void main();
}
