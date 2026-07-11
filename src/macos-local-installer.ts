/**
 * Recovery-safe macOS installer primitives.
 *
 * The shell bootstrap verifies this bundle before entering Node.  This module
 * repeats every bundle check and owns the durable lock/journal transaction.
 * All mutation boundaries accept injected adapters so tests never need the
 * real home directory, launchd, subscription stores, or network.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MACOS_INSTALLER_SCHEMA_VERSION = 1 as const;
export const DEFAULT_INSTALL_PORT = 47_821;
export const INSTALLED_MODELS = 'claude-fable-5,gpt-5.6-sol,grok-4.5';
export const CODEX_SUBSCRIPTION_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
export const GROK_SUBSCRIPTION_UPSTREAM = 'https://cli-chat-proxy.grok.com';
export const INSTALLER_PROGRAM_NAME = '.pxpipe-installer.mjs';

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_COMMIT = /^[0-9a-f]{40}$/u;
const SAFE_ID = /^[0-9a-f]{32}$/u;

export type InstallerOperation = 'install' | 'uninstall';
export type JournalPhase = 'preparing' | 'ready' | 'committed' | 'conflicted';

export const INSTALLER_RESOURCE_NAMES = [
  'releaseMaterial',
  'releasePointer',
  'serviceDefinition',
  'serviceState',
  'codexConfig',
  'grokConfig',
  'codexDirectory',
  'grokDirectory',
] as const;

export type InstallerResourceName = typeof INSTALLER_RESOURCE_NAMES[number];

export interface MacosInstallerPaths {
  readonly home: string;
  readonly installRoot: string;
  readonly releases: string;
  readonly current: string;
  readonly launchAgent: string;
  readonly stateRoot: string;
  readonly lock: string;
  readonly receipt: string;
  readonly journal: string;
  readonly transactions: string;
  readonly codexConfig: string;
  readonly grokConfig: string;
}

export function resolveMacosInstallerPaths(home: string): MacosInstallerPaths {
  if (!path.isAbsolute(home) || home === path.parse(home).root) {
    throw new InstallerValidationError('home directory must be a non-root absolute path');
  }
  const installRoot = path.join(home, 'Library', 'Application Support', 'pxpipe');
  const stateRoot = path.join(installRoot, 'state');
  return {
    home,
    installRoot,
    releases: path.join(installRoot, 'releases'),
    current: path.join(installRoot, 'current'),
    launchAgent: path.join(home, 'Library', 'LaunchAgents', 'com.pxpipe.proxy.plist'),
    stateRoot,
    lock: path.join(stateRoot, 'installer.lock'),
    receipt: path.join(stateRoot, 'receipt-v1.json'),
    journal: path.join(stateRoot, 'journal-v1.json'),
    transactions: path.join(stateRoot, 'transactions'),
    codexConfig: path.join(home, '.codex', 'config.toml'),
    grokConfig: path.join(home, '.grok', 'config.toml'),
  };
}

export function parseInstallerInvocation(argv: readonly string[]): InstallerOperation {
  if (argv.length === 0) return 'install';
  if (argv.length === 1 && argv[0] === '--uninstall') return 'uninstall';
  throw new InstallerValidationError('usage: ./install.sh [--uninstall]');
}

export class InstallerValidationError extends Error {
  override readonly name = 'InstallerValidationError';
}

export class InstallerBusyError extends Error {
  override readonly name = 'InstallerBusyError';
}

export class InstallerConflictError extends Error {
  override readonly name = 'InstallerConflictError';

  constructor(readonly conflicts: readonly JournalConflict[]) {
    super(`installer recovery blocked by ${conflicts.length} conflicting resource(s)`);
  }
}

/** Tests throw this to model an uncatchable process death. */
export class InstallerCrashSimulation extends Error {
  override readonly name = 'InstallerCrashSimulation';
}

export interface InstallerHooks {
  checkpoint(name: string): void | Promise<void>;
}

const NO_HOOKS: InstallerHooks = { checkpoint: () => undefined };

export interface AtomicWriteOptions {
  readonly mode?: number;
  readonly hooks?: InstallerHooks;
  readonly label?: string;
  readonly nonce?: () => string;
}

function errno(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function currentUid(): number {
  const uid = process.getuid?.() ?? process.geteuid?.();
  if (uid === undefined) throw new InstallerValidationError('cannot determine current uid');
  return uid;
}

async function lstatOrAbsent(file: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
}

async function readRegularNoFollow(
  file: string,
  requiredMode?: number,
  requiredUid?: number,
): Promise<{ readonly bytes: Uint8Array; readonly stat: Stats }> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errno(error) === 'ELOOP') {
      throw new InstallerValidationError(`refusing symbolic link: ${file}`);
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || (requiredMode !== undefined && (before.mode & 0o777) !== requiredMode)
      || (requiredUid !== undefined && before.uid !== requiredUid)
    ) {
      throw new InstallerValidationError(`not an approved regular file: ${file}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || bytes.byteLength !== after.size
    ) throw new InstallerConflictError([]);
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Same-directory temp, file fsync, atomic rename, then parent fsync. */
export async function atomicWriteFsync(
  file: string,
  data: Uint8Array | string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const hooks = options.hooks ?? NO_HOOKS;
  const label = options.label ?? 'atomic-write';
  const nonce = options.nonce?.() ?? randomBytes(16).toString('hex');
  if (!SAFE_ID.test(nonce)) throw new InstallerValidationError('unsafe temporary-file nonce');
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${nonce}.tmp`);
  const mode = options.mode ?? 0o600;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    await hooks.checkpoint(`${label}:before-open`);
    handle = await fs.open(temporary, 'wx', mode);
    // open(2) applies the process umask.  The installer deliberately runs
    // with a restrictive umask, but exact rollback may need to preserve a
    // pre-existing 0644 owner file.  Set the requested mode on the still-open
    // descriptor before any bytes can be published.
    await handle.chmod(mode);
    await hooks.checkpoint(`${label}:after-open`);
    await handle.writeFile(data);
    await hooks.checkpoint(`${label}:after-write`);
    await handle.sync();
    await hooks.checkpoint(`${label}:after-fsync`);
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await hooks.checkpoint(`${label}:after-rename`);
    await fsyncDirectory(path.dirname(file));
    await hooks.checkpoint(`${label}:after-directory-fsync`);
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    // An injected crash models process death: descriptors close, but the next
    // lock holder—not the dead process—must own durable temp cleanup.
    if (!(error instanceof InstallerCrashSimulation)) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
    throw error;
  }
}

export type ReceiptIdentity =
  | { readonly kind: 'absent' }
  | { readonly kind: 'sha256'; readonly sha256: string };

export type ResourceIdentity =
  | { readonly exists: false }
  | {
      readonly exists: true;
      readonly uid: number;
      readonly mode: number;
      readonly sha256: string;
    };

export type UnsafeResourceReason =
  | 'symbolic-link'
  | 'non-file'
  | 'wrong-owner'
  | 'unsafe-mode'
  | 'unstable';

export interface UnsafeResourceIdentity {
  readonly kind: 'unsafe';
  readonly reason: UnsafeResourceReason;
  readonly uid: number;
  readonly mode: number;
}

export type ObservedResourceIdentity = ResourceIdentity | UnsafeResourceIdentity;

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function receiptIdentityFromBytes(data: Uint8Array): ReceiptIdentity {
  return { kind: 'sha256', sha256: sha256(data) };
}

export function sameReceiptIdentity(a: ReceiptIdentity, b: ReceiptIdentity): boolean {
  return a.kind === b.kind && (a.kind === 'absent' || a.sha256 === (b as { sha256: string }).sha256);
}

export function sameResourceIdentity(a: ResourceIdentity, b: ResourceIdentity): boolean {
  if (!a.exists || !b.exists) return a.exists === b.exists;
  return a.uid === b.uid && a.mode === b.mode && a.sha256 === b.sha256;
}

function isUnsafeResourceIdentity(value: ObservedResourceIdentity): value is UnsafeResourceIdentity {
  return 'kind' in value && value.kind === 'unsafe';
}

export async function readReceiptIdentity(file: string): Promise<ReceiptIdentity> {
  const stat = await lstatOrAbsent(file);
  if (stat === undefined) return { kind: 'absent' };
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new InstallerValidationError(`receipt is not a regular 0600 file: ${file}`);
  }
  return receiptIdentityFromBytes((await readRegularNoFollow(file, 0o600, uid)).bytes);
}

export interface InstallerReceiptEnvelope<T = unknown> {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly payload: T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseJsonBytes(bytes: Uint8Array, label: string): unknown {
  let text: string;
  try {
    text = UTF8_FATAL.decode(bytes);
  } catch {
    throw new InstallerValidationError(`${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InstallerValidationError(`${label} is not valid JSON`);
  }
}

export function serializeReceipt<T>(transactionId: string, payload: T): Uint8Array {
  if (!SAFE_ID.test(transactionId)) throw new InstallerValidationError('invalid receipt transaction ID');
  return new TextEncoder().encode(`${JSON.stringify({
    schemaVersion: MACOS_INSTALLER_SCHEMA_VERSION,
    transactionId,
    payload,
  })}\n`);
}

export function parseStrictReceiptBytes<T>(
  bytes: Uint8Array,
  validatePayload: (value: unknown) => T,
  label = 'receipt',
): InstallerReceiptEnvelope<T> {
  const parsed = parseJsonBytes(bytes, label);
  if (!isPlainObject(parsed) || !exactKeys(parsed, ['schemaVersion', 'transactionId', 'payload'])) {
    throw new InstallerValidationError(`${label} has an invalid schema`);
  }
  if (parsed.schemaVersion !== 1 || typeof parsed.transactionId !== 'string' || !SAFE_ID.test(parsed.transactionId)) {
    throw new InstallerValidationError(`${label} has invalid fixed fields`);
  }
  return {
    schemaVersion: 1,
    transactionId: parsed.transactionId,
    payload: validatePayload(parsed.payload),
  };
}

export async function loadStrictReceipt<T>(
  file: string,
  validatePayload: (value: unknown) => T,
): Promise<{ readonly envelope: InstallerReceiptEnvelope<T>; readonly bytes: Uint8Array } | undefined> {
  const stat = await lstatOrAbsent(file);
  if (stat === undefined) return undefined;
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new InstallerValidationError(`receipt must be a regular 0600 file: ${file}`);
  }
  const { bytes } = await readRegularNoFollow(file, 0o600, uid);
  return {
    envelope: parseStrictReceiptBytes(bytes, validatePayload),
    bytes,
  };
}

export interface ProcessIdentity {
  readonly uid: number;
  readonly pid: number;
  readonly startSignature: string;
}

interface LockRecord extends ProcessIdentity {
  readonly schemaVersion: 1;
  readonly operation: InstallerOperation;
  readonly candidateId: string;
}

export interface LockDependencies {
  readonly process: ProcessIdentity;
  readonly isProcessAlive: (identity: ProcessIdentity) => boolean | Promise<boolean>;
  readonly hooks?: InstallerHooks;
  readonly nonce?: () => string;
}

export interface InstallerLock {
  readonly record: LockRecord;
  readonly candidatePath: string;
  readonly quarantinedPaths: readonly string[];
  release(): Promise<void>;
}

function validateProcessIdentity(value: ProcessIdentity): void {
  if (!Number.isSafeInteger(value.uid) || value.uid < 0 || !Number.isSafeInteger(value.pid) || value.pid <= 0) {
    throw new InstallerValidationError('invalid installer process identity');
  }
  if (!value.startSignature || value.startSignature.length > 256 || /[\u0000-\u001f]/u.test(value.startSignature)) {
    throw new InstallerValidationError('invalid process start signature');
  }
}

function serializeLock(record: LockRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(record)}\n`);
}

function parseLock(bytes: Uint8Array): LockRecord {
  const parsed = parseJsonBytes(bytes, 'installer lock');
  if (!isPlainObject(parsed) || !exactKeys(parsed, [
    'schemaVersion', 'uid', 'pid', 'startSignature', 'operation', 'candidateId',
  ])) throw new InstallerValidationError('installer lock has an invalid schema');
  const record: LockRecord = {
    schemaVersion: 1,
    uid: parsed.uid as number,
    pid: parsed.pid as number,
    startSignature: parsed.startSignature as string,
    operation: parsed.operation as InstallerOperation,
    candidateId: parsed.candidateId as string,
  };
  validateProcessIdentity(record);
  if ((record.operation !== 'install' && record.operation !== 'uninstall') || !SAFE_ID.test(record.candidateId)) {
    throw new InstallerValidationError('installer lock has invalid fixed fields');
  }
  return record;
}

async function ensurePrivateDirectory(directory: string, uid: number): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(directory, uid);
}

async function requirePrivateDirectory(directory: string, uid: number): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    throw new InstallerValidationError(`installer state directory must be owner-controlled 0700: ${directory}`);
  }
}

async function validatePrivateTransactionDirectory(directory: string, uid: number): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o700) {
    throw new InstallerValidationError(`transaction directory must be owner-controlled 0700: ${directory}`);
  }
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const fileStat = await fs.lstat(file);
    if (
      !entry.isFile() || entry.isSymbolicLink()
      || !fileStat.isFile() || fileStat.isSymbolicLink()
      || fileStat.uid !== uid || (fileStat.mode & 0o777) !== 0o600
    ) throw new InstallerValidationError(`unsafe transaction artifact: ${file}`);
  }
}

async function ensureOwnedDirectoryChain(
  base: string,
  leaf: string,
  uid: number,
): Promise<void> {
  const relative = path.relative(base, leaf);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new InstallerValidationError('installer state path escapes home');
  }
  let current = base;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat = await lstatOrAbsent(current);
    if (stat === undefined) {
      if (current === base) throw new InstallerValidationError(`home directory is missing: ${base}`);
      await fs.mkdir(current, { mode: 0o700 });
      await fsyncDirectory(path.dirname(current));
      stat = await fs.lstat(current);
    }
    if (
      !stat.isDirectory()
      || stat.isSymbolicLink()
      || stat.uid !== uid
      || (stat.mode & 0o022) !== 0
    ) throw new InstallerValidationError(`unsafe installer directory: ${current}`);
  }
  const leafStat = await fs.lstat(leaf);
  if ((leafStat.mode & 0o777) !== 0o700) {
    throw new InstallerValidationError(`installer state directory must be 0700: ${leaf}`);
  }
}

/** Complete-and-fsynced candidate followed by atomic no-clobber hard-link claim. */
export async function acquireInstallerLock(
  paths: MacosInstallerPaths,
  operation: InstallerOperation,
  dependencies: LockDependencies,
): Promise<InstallerLock> {
  validateProcessIdentity(dependencies.process);
  const hooks = dependencies.hooks ?? NO_HOOKS;
  const candidateId = dependencies.nonce?.() ?? randomBytes(16).toString('hex');
  if (!SAFE_ID.test(candidateId)) throw new InstallerValidationError('unsafe lock candidate ID');
  await ensureOwnedDirectoryChain(paths.home, paths.stateRoot, dependencies.process.uid);
  await hooks.checkpoint('lock:state-ready');

  const processTag = sha256(`${dependencies.process.pid}\0${dependencies.process.startSignature}`).slice(0, 16);
  const candidatePath = path.join(
    paths.stateRoot,
    `.installer.lock.candidate-${processTag}-${candidateId}`,
  );
  const record: LockRecord = {
    schemaVersion: 1,
    ...dependencies.process,
    operation,
    candidateId,
  };
  await hooks.checkpoint('lock:before-candidate');
  await atomicWriteFsync(candidatePath, serializeLock(record), {
    mode: 0o600,
    hooks,
    label: 'lock:candidate',
    nonce: dependencies.nonce,
  });
  await hooks.checkpoint('lock:after-candidate');

  const quarantined: string[] = [];
  let ownsLock = false;
  try {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      await hooks.checkpoint('lock:before-link');
      try {
        await fs.link(candidatePath, paths.lock);
        await fsyncDirectory(paths.stateRoot);
        ownsLock = true;
        await hooks.checkpoint('lock:after-link');
        break;
      } catch (error) {
        if (errno(error) === 'ENOENT') {
          throw new InstallerBusyError('installer candidate was superseded by another lock owner');
        }
        if (errno(error) !== 'EEXIST') throw error;
      }

      let existing: LockRecord | undefined;
      let observedLock: Stats | undefined;
      try {
        const stat = await fs.lstat(paths.lock);
        if (
          !stat.isFile() || stat.isSymbolicLink()
          || stat.uid !== dependencies.process.uid || (stat.mode & 0o777) !== 0o600
        ) {
          throw new InstallerValidationError('existing installer lock is not a regular 0600 file');
        }
        observedLock = stat;
        existing = parseLock((await readRegularNoFollow(paths.lock, 0o600, dependencies.process.uid)).bytes);
      } catch (error) {
        if (errno(error) === 'ENOENT') continue;
        if (!(error instanceof InstallerValidationError)) throw error;
      }
      if (existing !== undefined && await dependencies.isProcessAlive(existing)) {
        throw new InstallerBusyError(`another ${existing.operation} is already running`);
      }

      const quarantineId = dependencies.nonce?.() ?? randomBytes(16).toString('hex');
      if (!SAFE_ID.test(quarantineId)) throw new InstallerValidationError('unsafe lock quarantine ID');
      const quarantine = path.join(paths.stateRoot, `.installer.lock.stale-${quarantineId}`);
      await hooks.checkpoint('lock:before-quarantine');
      try {
        // Recheck the inode immediately before rename.  A delayed stale
        // reclaimer must never move a newer contender's live lock.
        const currentLock = await fs.lstat(paths.lock);
        if (
          observedLock === undefined
          || currentLock.dev !== observedLock.dev
          || currentLock.ino !== observedLock.ino
        ) continue;
        await fs.rename(paths.lock, quarantine);
        await fsyncDirectory(paths.stateRoot);
        const moved = await fs.lstat(quarantine);
        if (moved.dev !== observedLock.dev || moved.ino !== observedLock.ino) {
          // The inode changed in the final lstat/rename interval. Restore the
          // complete lock without clobbering any still-newer claimant, then
          // fail closed instead of competing with it.
          try {
            await fs.link(quarantine, paths.lock);
            await fsyncDirectory(paths.stateRoot);
          } catch (restoreError) {
            if (errno(restoreError) !== 'EEXIST') throw restoreError;
          }
          throw new InstallerBusyError('installer lock changed during stale recovery');
        }
        quarantined.push(quarantine);
        await hooks.checkpoint('lock:after-quarantine');
      } catch (error) {
        if (errno(error) === 'ENOENT') continue;
        throw error;
      }
    }
    if (!ownsLock) throw new InstallerBusyError('could not claim installer lock after concurrent changes');
    // Once this complete record owns the fixed name, prior crash debris cannot
    // belong to a live installer. Clean only exact schema-owned names.
    const stalePattern = /^\.installer\.lock\.stale-[0-9a-f]{32}$/u;
    const candidatePattern = /^\.installer\.lock\.candidate-([0-9a-f]{16})-([0-9a-f]{32})$/u;
    const candidateTemporaryPattern = /^\.\.installer\.lock\.candidate-[0-9a-f]{16}-[0-9a-f]{32}\.[0-9a-f]{32}\.tmp$/u;
    let cleanedLockDebris = false;
    for (const entry of await fs.readdir(paths.stateRoot, { withFileTypes: true })) {
      const artifact = path.join(paths.stateRoot, entry.name);
      if (artifact === candidatePath) continue;
      const candidateMatch = candidatePattern.exec(entry.name);
      const isTemporary = candidateTemporaryPattern.test(entry.name);
      if (!stalePattern.test(entry.name) && candidateMatch === null && !isTemporary) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new InstallerValidationError(`unexpected lock artifact: ${entry.name}`);
      }
      const artifactStat = await fs.lstat(artifact);
      if (artifactStat.uid !== dependencies.process.uid || (artifactStat.mode & 0o777) !== 0o600) {
        throw new InstallerValidationError(`unsafe lock artifact: ${entry.name}`);
      }
      if (candidateMatch !== null) {
        const candidateRecord = parseLock(
          (await readRegularNoFollow(artifact, 0o600, dependencies.process.uid)).bytes,
        );
        const expectedTag = sha256(`${candidateRecord.pid}\0${candidateRecord.startSignature}`).slice(0, 16);
        if (candidateMatch[1] !== expectedTag || candidateMatch[2] !== candidateRecord.candidateId) {
          throw new InstallerValidationError(`lock candidate name does not match its record: ${entry.name}`);
        }
        if (await dependencies.isProcessAlive(candidateRecord)) continue;
      }
      await hooks.checkpoint(`lock:before-artifact-cleanup:${entry.name}`);
      await fs.unlink(artifact);
      cleanedLockDebris = true;
      await hooks.checkpoint(`lock:after-artifact-cleanup:${entry.name}`);
    }
    if (cleanedLockDebris) await fsyncDirectory(paths.stateRoot);
  } catch (error) {
    if (!(error instanceof InstallerCrashSimulation)) {
      await fs.rm(candidatePath, { force: true }).catch(() => undefined);
      await fsyncDirectory(paths.stateRoot).catch(() => undefined);
    }
    throw error;
  }

  return {
    record,
    candidatePath,
    quarantinedPaths: quarantined,
    async release(): Promise<void> {
      const candidateStat = await lstatOrAbsent(candidatePath);
      const lockStat = await lstatOrAbsent(paths.lock);
      if (
        lockStat === undefined
        || candidateStat === undefined
        || lockStat.dev !== candidateStat.dev
        || lockStat.ino !== candidateStat.ino
      ) throw new InstallerConflictError([]);
      await hooks.checkpoint('lock:before-release');
      await fs.unlink(candidatePath);
      await fsyncDirectory(paths.stateRoot);
      await hooks.checkpoint('lock:after-candidate-release');
      await fs.unlink(paths.lock);
      await fsyncDirectory(paths.stateRoot);
      await hooks.checkpoint('lock:after-release');
      for (const quarantine of quarantined) await fs.rm(quarantine, { force: true });
      if (quarantined.length > 0) await fsyncDirectory(paths.stateRoot);
    },
  };
}

export interface CapturedResource {
  readonly identity: ResourceIdentity;
  readonly snapshot: Uint8Array | null;
}

export interface TransactionResourceAdapter {
  readonly name: InstallerResourceName;
  readonly displayPath: string;
  /**
   * Force a compensating restore when a stateful resource has identical
   * before/after identity (for example, restart the prior loaded service after
   * its executable and plist have been restored).
   */
  readonly restoreWhenPriorEqualsApplied?: boolean;
  capture(): Promise<CapturedResource>;
  currentIdentity(): Promise<ResourceIdentity>;
  /** Rollback-only observation that can durably describe unsafe path state. */
  observeCurrentIdentity?(): Promise<ObservedResourceIdentity>;
  restore(prior: ResourceIdentity, snapshot: Uint8Array | null): Promise<void>;
}

export interface PreparedTransactionResource {
  readonly adapter: TransactionResourceAdapter;
  readonly applied: ResourceIdentity;
}

export function createFileResourceAdapter(
  name: InstallerResourceName,
  file: string,
  hooks: InstallerHooks = NO_HOOKS,
  expectedUid = process.getuid?.() ?? process.geteuid?.() ?? 0,
): TransactionResourceAdapter {
  function classifyUnsafe(stat: Stats): UnsafeResourceIdentity | undefined {
    const mode = stat.mode & 0o777;
    let reason: UnsafeResourceReason | undefined;
    if (stat.isSymbolicLink()) reason = 'symbolic-link';
    else if (!stat.isFile()) reason = 'non-file';
    else if (stat.uid !== expectedUid) reason = 'wrong-owner';
    else if ((mode & 0o022) !== 0) reason = 'unsafe-mode';
    return reason === undefined ? undefined : { kind: 'unsafe', reason, uid: stat.uid, mode };
  }

  async function capture(): Promise<CapturedResource> {
    const before = await lstatOrAbsent(file);
    if (before === undefined) return { identity: { exists: false }, snapshot: null };
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new InstallerValidationError(`managed path is not a regular file: ${file}`);
    }
    if (before.uid !== expectedUid || (before.mode & 0o022) !== 0) {
      throw new InstallerValidationError(`managed path has unsafe owner or mode: ${file}`);
    }
    const opened = await readRegularNoFollow(file);
    const bytes = opened.bytes;
    const after = opened.stat;
    await hooks.checkpoint(`capture:${name}:after-read`);
    const pathAfter = await lstatOrAbsent(file);
    if (
      pathAfter === undefined
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino || pathAfter.size !== after.size
      || pathAfter.mtimeMs !== after.mtimeMs || pathAfter.ctimeMs !== after.ctimeMs
      || bytes.byteLength !== after.size
    ) throw new InstallerConflictError([]);
    return {
      identity: { exists: true, uid: after.uid, mode: after.mode & 0o777, sha256: sha256(bytes) },
      snapshot: bytes,
    };
  }
  return {
    name,
    displayPath: file,
    capture,
    async currentIdentity(): Promise<ResourceIdentity> {
      return (await capture()).identity;
    },
    async observeCurrentIdentity(): Promise<ObservedResourceIdentity> {
      const stat = await lstatOrAbsent(file);
      if (stat === undefined) return { exists: false };
      const unsafe = classifyUnsafe(stat);
      if (unsafe !== undefined) return unsafe;
      try {
        return (await capture()).identity;
      } catch (error) {
        if (!(error instanceof InstallerConflictError) && !(error instanceof InstallerValidationError)) throw error;
        return { kind: 'unsafe', reason: 'unstable', uid: stat.uid, mode: stat.mode & 0o777 };
      }
    },
    async restore(prior: ResourceIdentity, snapshot: Uint8Array | null): Promise<void> {
      if (!prior.exists) {
        await fs.rm(file, { force: true });
        await fsyncDirectory(path.dirname(file));
        return;
      }
      if (snapshot === null || sha256(snapshot) !== prior.sha256) {
        throw new InstallerValidationError(`snapshot does not match prior identity: ${file}`);
      }
      await atomicWriteFsync(file, snapshot, {
        mode: prior.mode,
        hooks,
        label: `rollback:${name}`,
      });
    },
  };
}

interface JournalResource {
  readonly name: InstallerResourceName;
  readonly displayPath: string;
  readonly prior: ResourceIdentity;
  readonly applied: ResourceIdentity;
  readonly snapshotPath: string | null;
  readonly restored: boolean;
}

interface JournalExpectedResource {
  readonly name: InstallerResourceName;
  readonly displayPath: string;
  readonly applied: ResourceIdentity;
}

export interface JournalConflict {
  readonly name: InstallerResourceName;
  readonly displayPath: string;
  readonly prior: ResourceIdentity;
  readonly applied: ResourceIdentity;
  readonly current: ObservedResourceIdentity;
}

export interface JournalReceiptConflict {
  readonly prior: ReceiptIdentity;
  readonly intended: ReceiptIdentity;
  readonly current: ReceiptIdentity;
}

export interface InstallerJournal {
  readonly schemaVersion: 1;
  readonly transactionId: string;
  readonly operation: InstallerOperation;
  readonly phase: JournalPhase;
  readonly transactionDirectory: string;
  readonly priorReceipt: ReceiptIdentity;
  readonly intendedReceipt: ReceiptIdentity;
  /** Fsynced immediately before the receipt rename/removal commit boundary. */
  readonly receiptCommitStarted: boolean;
  readonly expectedResources: readonly JournalExpectedResource[];
  readonly resources: readonly JournalResource[];
  readonly conflicts: readonly JournalConflict[];
  readonly receiptConflict: JournalReceiptConflict | null;
}

function validateIdentity(value: unknown): ResourceIdentity {
  if (!isPlainObject(value)) throw new InstallerValidationError('invalid resource identity');
  if (exactKeys(value, ['exists']) && value.exists === false) return { exists: false };
  if (!exactKeys(value, ['exists', 'uid', 'mode', 'sha256']) || value.exists !== true) {
    throw new InstallerValidationError('invalid resource identity');
  }
  if (
    !Number.isSafeInteger(value.uid) || (value.uid as number) < 0
    || !Number.isSafeInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o777
    || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
  ) throw new InstallerValidationError('invalid resource identity');
  return { exists: true, uid: value.uid as number, mode: value.mode as number, sha256: value.sha256 };
}

function validateObservedIdentity(value: unknown): ObservedResourceIdentity {
  if (isPlainObject(value) && exactKeys(value, ['kind', 'reason', 'uid', 'mode']) && value.kind === 'unsafe') {
    const reasons: readonly UnsafeResourceReason[] = [
      'symbolic-link', 'non-file', 'wrong-owner', 'unsafe-mode', 'unstable',
    ];
    if (
      typeof value.reason !== 'string' || !reasons.includes(value.reason as UnsafeResourceReason)
      || !Number.isSafeInteger(value.uid) || (value.uid as number) < 0
      || !Number.isSafeInteger(value.mode) || (value.mode as number) < 0 || (value.mode as number) > 0o777
    ) throw new InstallerValidationError('invalid unsafe resource identity');
    return {
      kind: 'unsafe',
      reason: value.reason as UnsafeResourceReason,
      uid: value.uid as number,
      mode: value.mode as number,
    };
  }
  return validateIdentity(value);
}

function validateReceiptIdentity(value: unknown): ReceiptIdentity {
  if (!isPlainObject(value)) throw new InstallerValidationError('invalid receipt identity');
  if (exactKeys(value, ['kind']) && value.kind === 'absent') return { kind: 'absent' };
  if (!exactKeys(value, ['kind', 'sha256']) || value.kind !== 'sha256' || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)) {
    throw new InstallerValidationError('invalid receipt identity');
  }
  return { kind: 'sha256', sha256: value.sha256 };
}

function validateResourceName(value: unknown): InstallerResourceName {
  if (typeof value !== 'string' || !(INSTALLER_RESOURCE_NAMES as readonly string[]).includes(value)) {
    throw new InstallerValidationError('invalid journal resource name');
  }
  return value as InstallerResourceName;
}

function validateJournal(value: unknown, paths: MacosInstallerPaths): InstallerJournal {
  if (!isPlainObject(value) || !exactKeys(value, [
    'schemaVersion', 'transactionId', 'operation', 'phase', 'transactionDirectory',
    'priorReceipt', 'intendedReceipt', 'receiptCommitStarted', 'expectedResources',
    'resources', 'conflicts', 'receiptConflict',
  ])) throw new InstallerValidationError('journal has an invalid schema');
  if (value.schemaVersion !== 1 || typeof value.transactionId !== 'string' || !SAFE_ID.test(value.transactionId)) {
    throw new InstallerValidationError('journal has invalid fixed fields');
  }
  if (value.operation !== 'install' && value.operation !== 'uninstall') throw new InstallerValidationError('journal has invalid operation');
  if (typeof value.receiptCommitStarted !== 'boolean') throw new InstallerValidationError('journal receipt boundary flag is invalid');
  if (!['preparing', 'ready', 'committed', 'conflicted'].includes(value.phase as string)) {
    throw new InstallerValidationError('journal has invalid phase');
  }
  const expectedDirectory = path.join(paths.transactions, value.transactionId);
  if (value.transactionDirectory !== expectedDirectory) throw new InstallerValidationError('journal transaction path escapes fixed state');
  if (!Array.isArray(value.expectedResources) || !Array.isArray(value.resources) || !Array.isArray(value.conflicts)) {
    throw new InstallerValidationError('journal arrays are invalid');
  }
  const priorReceipt = validateReceiptIdentity(value.priorReceipt);
  const intendedReceipt = validateReceiptIdentity(value.intendedReceipt);
  if (
    (value.operation === 'install' && intendedReceipt.kind !== 'sha256')
    || (value.operation === 'uninstall' && intendedReceipt.kind !== 'absent')
  ) throw new InstallerValidationError('journal operation does not match intended receipt');
  const expectedNames = new Set<string>();
  const expectedResources = value.expectedResources.map((raw): JournalExpectedResource => {
    if (!isPlainObject(raw) || !exactKeys(raw, ['name', 'displayPath', 'applied'])) {
      throw new InstallerValidationError('journal expected resource has an invalid schema');
    }
    const name = validateResourceName(raw.name);
    if (expectedNames.has(name)) throw new InstallerValidationError('journal contains duplicate expected resources');
    expectedNames.add(name);
    if (typeof raw.displayPath !== 'string' || !path.isAbsolute(raw.displayPath)) {
      throw new InstallerValidationError('journal expected resource path is invalid');
    }
    return { name, displayPath: raw.displayPath, applied: validateIdentity(raw.applied) };
  });
  const names = new Set<string>();
  const resources = value.resources.map((raw, index): JournalResource => {
    if (!isPlainObject(raw) || !exactKeys(raw, ['name', 'displayPath', 'prior', 'applied', 'snapshotPath', 'restored'])) {
      throw new InstallerValidationError('journal resource has an invalid schema');
    }
    const name = validateResourceName(raw.name);
    if (names.has(name)) throw new InstallerValidationError('journal contains duplicate resources');
    names.add(name);
    if (typeof raw.displayPath !== 'string' || !path.isAbsolute(raw.displayPath) || typeof raw.restored !== 'boolean') {
      throw new InstallerValidationError('journal resource has invalid fixed fields');
    }
    const expected = expectedResources[index];
    const applied = validateIdentity(raw.applied);
    if (
      expected === undefined || expected.name !== name || expected.displayPath !== raw.displayPath
      || !sameResourceIdentity(expected.applied, applied)
    ) throw new InstallerValidationError('journal resource does not match its expected resource');
    const prior = validateIdentity(raw.prior);
    const snapshotPath = raw.snapshotPath;
    if (prior.exists) {
      const expectedSnapshot = path.join(expectedDirectory, `${index}-${name}.snapshot`);
      if (snapshotPath !== expectedSnapshot) throw new InstallerValidationError('journal snapshot path escapes transaction');
    } else if (snapshotPath !== null) throw new InstallerValidationError('absent resource must not have a snapshot');
    return {
      name,
      displayPath: raw.displayPath,
      prior,
      applied,
      snapshotPath: snapshotPath as string | null,
      restored: raw.restored,
    };
  });
  if (resources.length > expectedResources.length) {
    throw new InstallerValidationError('journal has more resources than expected');
  }
  if (value.phase !== 'preparing' && resources.length !== expectedResources.length) {
    throw new InstallerValidationError('published journal is missing prepared resources');
  }
  const conflictNames = new Set<string>();
  const conflicts = value.conflicts.map((raw): JournalConflict => {
    if (!isPlainObject(raw) || !exactKeys(raw, ['name', 'displayPath', 'prior', 'applied', 'current'])) {
      throw new InstallerValidationError('journal conflict has an invalid schema');
    }
    const name = validateResourceName(raw.name);
    if (conflictNames.has(name)) throw new InstallerValidationError('journal contains duplicate conflicts');
    conflictNames.add(name);
    if (typeof raw.displayPath !== 'string' || !path.isAbsolute(raw.displayPath)) {
      throw new InstallerValidationError('journal conflict path is invalid');
    }
    const conflict = {
      name,
      displayPath: raw.displayPath,
      prior: validateIdentity(raw.prior),
      applied: validateIdentity(raw.applied),
      current: validateObservedIdentity(raw.current),
    };
    const resource = resources.find((candidate) => candidate.name === name);
    if (
      resource === undefined || resource.displayPath !== conflict.displayPath
      || !sameResourceIdentity(resource.prior, conflict.prior)
      || !sameResourceIdentity(resource.applied, conflict.applied)
      || (!isUnsafeResourceIdentity(conflict.current) && (
        sameResourceIdentity(conflict.current, conflict.prior)
        || sameResourceIdentity(conflict.current, conflict.applied)
      ))
    ) throw new InstallerValidationError('journal conflict does not match its resource');
    return conflict;
  });
  let receiptConflict: JournalReceiptConflict | null = null;
  if (value.receiptConflict !== null) {
    if (!isPlainObject(value.receiptConflict) || !exactKeys(value.receiptConflict, ['prior', 'intended', 'current'])) {
      throw new InstallerValidationError('journal receipt conflict has an invalid schema');
    }
    receiptConflict = {
      prior: validateReceiptIdentity(value.receiptConflict.prior),
      intended: validateReceiptIdentity(value.receiptConflict.intended),
      current: validateReceiptIdentity(value.receiptConflict.current),
    };
    if (
      !sameReceiptIdentity(receiptConflict.prior, priorReceipt)
      || !sameReceiptIdentity(receiptConflict.intended, intendedReceipt)
      || sameReceiptIdentity(receiptConflict.current, priorReceipt)
      || sameReceiptIdentity(receiptConflict.current, intendedReceipt)
    ) throw new InstallerValidationError('journal receipt conflict does not match the transaction');
  }
  if ((value.phase === 'conflicted') !== (conflicts.length > 0 || receiptConflict !== null)) {
    throw new InstallerValidationError('journal conflict phase does not match conflict records');
  }
  if (value.phase === 'preparing' && value.receiptCommitStarted) {
    throw new InstallerValidationError('preparing journal cannot have started receipt commit');
  }
  if (value.phase === 'committed' && !value.receiptCommitStarted) {
    throw new InstallerValidationError('committed journal is missing its receipt boundary');
  }
  return {
    schemaVersion: 1,
    transactionId: value.transactionId,
    operation: value.operation,
    phase: value.phase as JournalPhase,
    transactionDirectory: expectedDirectory,
    priorReceipt,
    intendedReceipt,
    receiptCommitStarted: value.receiptCommitStarted,
    expectedResources,
    resources,
    conflicts,
    receiptConflict,
  };
}

function serializeJournal(journal: InstallerJournal): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(journal)}\n`);
}

export async function loadStrictJournal(paths: MacosInstallerPaths): Promise<InstallerJournal | undefined> {
  const stat = await lstatOrAbsent(paths.journal);
  if (stat === undefined) return undefined;
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new InstallerValidationError(`journal must be a regular 0600 file: ${paths.journal}`);
  }
  return validateJournal(
    parseJsonBytes((await readRegularNoFollow(paths.journal, 0o600, uid)).bytes, 'journal'),
    paths,
  );
}

async function writeJournal(paths: MacosInstallerPaths, journal: InstallerJournal, hooks: InstallerHooks): Promise<void> {
  await atomicWriteFsync(paths.journal, serializeJournal(journal), {
    mode: 0o600,
    hooks,
    label: `journal:${journal.phase}`,
  });
}

export interface PrepareTransactionOptions {
  readonly operation: InstallerOperation;
  readonly priorReceipt: ReceiptIdentity;
  readonly intendedReceipt: ReceiptIdentity;
  readonly resources: readonly PreparedTransactionResource[];
  readonly hooks?: InstallerHooks;
  readonly transactionId?: string;
}

/** Journal `preparing`, snapshot each resource, then atomically mark `ready`. */
export async function prepareTransaction(
  paths: MacosInstallerPaths,
  options: PrepareTransactionOptions,
): Promise<InstallerJournal> {
  const hooks = options.hooks ?? NO_HOOKS;
  if (options.operation !== 'install' && options.operation !== 'uninstall') {
    throw new InstallerValidationError('invalid transaction operation');
  }
  const priorReceipt = validateReceiptIdentity(options.priorReceipt);
  const intendedReceipt = validateReceiptIdentity(options.intendedReceipt);
  if (
    (options.operation === 'install' && intendedReceipt.kind !== 'sha256')
    || (options.operation === 'uninstall' && intendedReceipt.kind !== 'absent')
  ) throw new InstallerValidationError('transaction operation does not match intended receipt');
  if (await lstatOrAbsent(paths.journal) !== undefined) throw new InstallerValidationError('pending installer journal exists');
  const transactionId = options.transactionId ?? randomBytes(16).toString('hex');
  if (!SAFE_ID.test(transactionId)) throw new InstallerValidationError('invalid transaction ID');
  const expectedNames = new Set<InstallerResourceName>();
  const expectedResources = options.resources.map((prepared): JournalExpectedResource => {
    if (expectedNames.has(prepared.adapter.name)) throw new InstallerValidationError('duplicate prepared resource');
    expectedNames.add(prepared.adapter.name);
    if (!path.isAbsolute(prepared.adapter.displayPath)) {
      throw new InstallerValidationError('prepared resource path must be absolute');
    }
    return {
      name: validateResourceName(prepared.adapter.name),
      displayPath: prepared.adapter.displayPath,
      applied: validateIdentity(prepared.applied),
    };
  });
  const transactionDirectory = path.join(paths.transactions, transactionId);
  await ensurePrivateDirectory(paths.transactions, process.getuid?.() ?? process.geteuid?.() ?? 0);
  await fs.mkdir(transactionDirectory, { mode: 0o700 });
  await fsyncDirectory(paths.transactions);
  await hooks.checkpoint('transaction:directory-created');

  let journal: InstallerJournal = {
    schemaVersion: 1,
    transactionId,
    operation: options.operation,
    phase: 'preparing',
    transactionDirectory,
    priorReceipt,
    intendedReceipt,
    receiptCommitStarted: false,
    expectedResources,
    resources: [],
    conflicts: [],
    receiptConflict: null,
  };
  await writeJournal(paths, journal, hooks);
  await hooks.checkpoint('transaction:preparing');

  for (let index = 0; index < options.resources.length; index += 1) {
    const prepared = options.resources[index]!;
    const captured = await prepared.adapter.capture();
    let snapshotPath: string | null = null;
    if (captured.identity.exists) {
      if (captured.snapshot === null || sha256(captured.snapshot) !== captured.identity.sha256) {
        throw new InstallerValidationError(`invalid captured snapshot: ${prepared.adapter.displayPath}`);
      }
      snapshotPath = path.join(transactionDirectory, `${index}-${prepared.adapter.name}.snapshot`);
      await atomicWriteFsync(snapshotPath, captured.snapshot, {
        mode: 0o600,
        hooks,
        label: `snapshot:${prepared.adapter.name}`,
      });
    } else if (captured.snapshot !== null) throw new InstallerValidationError('absent resource supplied snapshot bytes');
    journal = {
      ...journal,
      resources: [...journal.resources, {
        name: prepared.adapter.name,
        displayPath: prepared.adapter.displayPath,
        prior: captured.identity,
        applied: prepared.applied,
        snapshotPath,
        restored: false,
      }],
    };
    await writeJournal(paths, journal, hooks);
    await hooks.checkpoint(`transaction:snapshot:${prepared.adapter.name}`);
  }
  journal = { ...journal, phase: 'ready' };
  await writeJournal(paths, journal, hooks);
  await hooks.checkpoint('transaction:ready');
  return journal;
}

function adaptersForJournal(
  journal: InstallerJournal,
  adapters: readonly TransactionResourceAdapter[],
): Map<InstallerResourceName, TransactionResourceAdapter> {
  const map = new Map(adapters.map((adapter) => [adapter.name, adapter]));
  for (const resource of journal.resources) {
    const adapter = map.get(resource.name);
    if (adapter === undefined || adapter.displayPath !== resource.displayPath) {
      throw new InstallerValidationError(`missing exact recovery adapter for ${resource.name}`);
    }
  }
  return map;
}

async function readStrictSnapshot(resource: JournalResource): Promise<Uint8Array | null> {
  if (resource.snapshotPath === null) return null;
  const stat = await fs.lstat(resource.snapshotPath);
  const uid = currentUid();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
    throw new InstallerValidationError(`snapshot must be a regular 0600 file: ${resource.snapshotPath}`);
  }
  const { bytes } = await readRegularNoFollow(resource.snapshotPath, 0o600, uid);
  if (!resource.prior.exists || sha256(bytes) !== resource.prior.sha256) {
    throw new InstallerValidationError(`snapshot identity mismatch: ${resource.snapshotPath}`);
  }
  return bytes;
}

async function removeTransactionFiles(paths: MacosInstallerPaths, journal: InstallerJournal, hooks: InstallerHooks): Promise<void> {
  const uid = currentUid();
  await requirePrivateDirectory(paths.stateRoot, uid);
  await requirePrivateDirectory(paths.transactions, uid);
  const transactionStat = await lstatOrAbsent(journal.transactionDirectory);
  if (transactionStat !== undefined) {
    await validatePrivateTransactionDirectory(journal.transactionDirectory, uid);
  }
  await hooks.checkpoint('transaction:before-directory-cleanup');
  await fs.rm(journal.transactionDirectory, { recursive: true, force: true });
  await fsyncDirectory(paths.transactions);
  await hooks.checkpoint('transaction:after-directory-cleanup');
  await fs.rm(paths.journal, { force: true });
  await fsyncDirectory(paths.stateRoot);
  await hooks.checkpoint('transaction:after-journal-cleanup');
}

export async function finalizeTransaction(
  paths: MacosInstallerPaths,
  journal: InstallerJournal,
  hooks: InstallerHooks = NO_HOOKS,
): Promise<void> {
  let committed = journal;
  if (journal.phase !== 'committed') {
    committed = { ...journal, phase: 'committed', conflicts: [], receiptConflict: null };
    await writeJournal(paths, committed, hooks);
    await hooks.checkpoint('transaction:committed');
  }
  await removeTransactionFiles(paths, committed, hooks);
}

export async function rollbackTransaction(
  paths: MacosInstallerPaths,
  journal: InstallerJournal,
  adapters: readonly TransactionResourceAdapter[],
  hooks: InstallerHooks = NO_HOOKS,
): Promise<void> {
  if (journal.phase === 'preparing') {
    await removeTransactionFiles(paths, journal, hooks);
    return;
  }
  const adapterMap = adaptersForJournal(journal, adapters);
  let next = journal;
  const currentReceipt = await readReceiptIdentity(paths.receipt);
  if (journal.phase === 'committed' && sameReceiptIdentity(currentReceipt, journal.intendedReceipt)) {
    await removeTransactionFiles(paths, journal, hooks);
    return;
  }
  if (!sameReceiptIdentity(currentReceipt, journal.priorReceipt)) {
    next = {
      ...next,
      phase: 'conflicted',
      receiptConflict: {
        prior: journal.priorReceipt,
        intended: journal.intendedReceipt,
        current: currentReceipt,
      },
    };
    await writeJournal(paths, next, hooks);
    await hooks.checkpoint('transaction:receipt-conflicted');
    throw new InstallerConflictError([]);
  }
  if (next.receiptConflict !== null) next = { ...next, receiptConflict: null };
  const conflicts: JournalConflict[] = [];
  for (let index = next.resources.length - 1; index >= 0; index -= 1) {
    const resource = next.resources[index]!;
    const adapter = adapterMap.get(resource.name)!;
    const current = adapter.observeCurrentIdentity === undefined
      ? await adapter.currentIdentity()
      : await adapter.observeCurrentIdentity();
    if (isUnsafeResourceIdentity(current)) {
      conflicts.push({
        name: resource.name,
        displayPath: resource.displayPath,
        prior: resource.prior,
        applied: resource.applied,
        current,
      });
      continue;
    }
    const matchesPrior = sameResourceIdentity(current, resource.prior);
    const matchesApplied = sameResourceIdentity(current, resource.applied);
    if (resource.restored) {
      if (!matchesPrior) {
        conflicts.push({
          name: resource.name,
          displayPath: resource.displayPath,
          prior: resource.prior,
          applied: resource.applied,
          current,
        });
      }
      continue;
    }
    const forceCompensation = adapter.restoreWhenPriorEqualsApplied === true
      && sameResourceIdentity(resource.prior, resource.applied);
    if (matchesPrior && !forceCompensation) continue;
    if (!matchesApplied) {
      conflicts.push({
        name: resource.name,
        displayPath: resource.displayPath,
        prior: resource.prior,
        applied: resource.applied,
        current,
      });
      continue;
    }
    const snapshot = await readStrictSnapshot(resource);
    await hooks.checkpoint(`rollback:before:${resource.name}`);
    await adapter.restore(resource.prior, snapshot);
    const restored = adapter.observeCurrentIdentity === undefined
      ? await adapter.currentIdentity()
      : await adapter.observeCurrentIdentity();
    if (isUnsafeResourceIdentity(restored) || !sameResourceIdentity(restored, resource.prior)) {
      conflicts.push({
        name: resource.name,
        displayPath: resource.displayPath,
        prior: resource.prior,
        applied: resource.applied,
        current: restored,
      });
      continue;
    }
    const resources = [...next.resources];
    resources[index] = { ...resource, restored: true };
    next = { ...next, resources };
    await writeJournal(paths, next, hooks);
    await hooks.checkpoint(`rollback:after:${resource.name}`);
  }
  if (conflicts.length > 0) {
    next = { ...next, phase: 'conflicted', conflicts, receiptConflict: null };
    await writeJournal(paths, next, hooks);
    await hooks.checkpoint('transaction:conflicted');
    throw new InstallerConflictError(conflicts);
  }
  await removeTransactionFiles(paths, next, hooks);
}

export type RecoveryResult = 'none' | 'preparing-cleaned' | 'rolled-back' | 'committed-finalized';

/** Remove only schema-named debris that cannot belong to a published journal. */
export async function cleanupOrphanPreparingState(
  paths: MacosInstallerPaths,
  hooks: InstallerHooks = NO_HOOKS,
): Promise<boolean> {
  let changed = false;
  const uid = currentUid();
  const transactionsStat = await lstatOrAbsent(paths.transactions);
  if (transactionsStat !== undefined) {
    await requirePrivateDirectory(paths.transactions, uid);
    const entries = await fs.readdir(paths.transactions, { withFileTypes: true });
    for (const entry of entries) {
      if (!SAFE_ID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
        throw new InstallerValidationError(`unexpected transaction debris: ${entry.name}`);
      }
      await validatePrivateTransactionDirectory(path.join(paths.transactions, entry.name), uid);
      await hooks.checkpoint(`recovery:before-orphan:${entry.name}`);
      await fs.rm(path.join(paths.transactions, entry.name), { recursive: true });
      changed = true;
      await hooks.checkpoint(`recovery:after-orphan:${entry.name}`);
    }
    if (changed) await fsyncDirectory(paths.transactions);
  }
  const stateStat = await lstatOrAbsent(paths.stateRoot);
  if (stateStat !== undefined) {
    await requirePrivateDirectory(paths.stateRoot, uid);
    const temporaryPattern = /^\.(?:journal-v1\.json|receipt-v1\.json)\.[0-9a-f]{32}\.tmp$/u;
    for (const entry of await fs.readdir(paths.stateRoot, { withFileTypes: true })) {
      if (!temporaryPattern.test(entry.name)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new InstallerValidationError(`unexpected installer temporary: ${entry.name}`);
      }
      const temporary = path.join(paths.stateRoot, entry.name);
      const temporaryStat = await fs.lstat(temporary);
      if (temporaryStat.uid !== uid || (temporaryStat.mode & 0o777) !== 0o600) {
        throw new InstallerValidationError(`unsafe installer temporary: ${entry.name}`);
      }
      await fs.unlink(temporary);
      changed = true;
    }
    if (changed) await fsyncDirectory(paths.stateRoot);
  }
  return changed;
}

export async function recoverPendingTransaction(
  paths: MacosInstallerPaths,
  adapters: readonly TransactionResourceAdapter[],
  hooks: InstallerHooks = NO_HOOKS,
  cleanupCommitted?: (operation: InstallerOperation) => Promise<void>,
): Promise<RecoveryResult> {
  const journal = await loadStrictJournal(paths);
  if (journal === undefined) {
    return await cleanupOrphanPreparingState(paths, hooks) ? 'preparing-cleaned' : 'none';
  }
  if (journal.phase === 'preparing') {
    await rollbackTransaction(paths, journal, adapters, hooks);
    return 'preparing-cleaned';
  }
  const currentReceipt = await readReceiptIdentity(paths.receipt);
  if (
    (journal.phase === 'committed' || journal.receiptCommitStarted)
    && sameReceiptIdentity(currentReceipt, journal.intendedReceipt)
  ) {
    if (cleanupCommitted !== undefined) {
      await checkpointed(hooks, 'cleanup-committed-recovery', () => cleanupCommitted(journal.operation));
    }
    await finalizeTransaction(paths, journal, hooks);
    return 'committed-finalized';
  }
  await rollbackTransaction(paths, journal, adapters, hooks);
  return 'rolled-back';
}

export interface PreparedInstallerOperation {
  readonly noOp: boolean;
  readonly resources: readonly PreparedTransactionResource[];
  /** Exact bytes for install/reinstall; null means committed receipt absence. */
  readonly intendedReceiptBytes: Uint8Array | null;
}

export interface InstallerOperationAdapter {
  readonly recoveryResources: readonly TransactionResourceAdapter[];
  preflight(
    operation: InstallerOperation,
    receipt: { readonly envelope: InstallerReceiptEnvelope<unknown>; readonly bytes: Uint8Array } | undefined,
  ): Promise<PreparedInstallerOperation>;
  materializeRelease(): Promise<void>;
  switchService(): Promise<void>;
  startService(): Promise<void>;
  healthCheckService(): Promise<void>;
  applyCodex(): Promise<void>;
  applyGrok(): Promise<void>;
  restoreCodex(): Promise<void>;
  restoreGrok(): Promise<void>;
  stopAndRemoveService(): Promise<void>;
  validateApplied(operation: InstallerOperation): Promise<void>;
  cleanupCommitted(operation: InstallerOperation): Promise<void>;
  /** Remove per-attempt staging while the installer lock is still held. */
  cleanupAttempt?(): Promise<void>;
}

export interface RunInstallerOptions {
  readonly paths: MacosInstallerPaths;
  readonly operation: InstallerOperation;
  readonly lock: LockDependencies;
  readonly adapter: InstallerOperationAdapter;
  readonly hooks?: InstallerHooks;
  readonly transactionId?: string;
  readonly validateReceiptPayload?: (value: unknown) => unknown;
}

async function checkpointed(hooks: InstallerHooks, name: string, action: () => Promise<void>): Promise<void> {
  await hooks.checkpoint(`operation:before:${name}`);
  await action();
  await hooks.checkpoint(`operation:after:${name}`);
}

async function verifyPreparedResources(resources: readonly PreparedTransactionResource[]): Promise<void> {
  for (const resource of resources) {
    const current = await resource.adapter.currentIdentity();
    if (!sameResourceIdentity(current, resource.applied)) {
      throw new InstallerConflictError([{
        name: resource.adapter.name,
        displayPath: resource.adapter.displayPath,
        prior: resource.applied,
        applied: resource.applied,
        current,
      }]);
    }
  }
}

/** Exact install/uninstall order with handled-error rollback and crash recovery. */
export async function runInstallerOperation(options: RunInstallerOptions): Promise<'changed' | 'no-op'> {
  const hooks = options.hooks ?? NO_HOOKS;
  const lock = await acquireInstallerLock(options.paths, options.operation, {
    ...options.lock,
    hooks,
  });
  let crash = false;
  try {
    await recoverPendingTransaction(
      options.paths,
      options.adapter.recoveryResources,
      hooks,
      (operation) => options.adapter.cleanupCommitted(operation),
    );
    const receipt = await loadStrictReceipt(
      options.paths.receipt,
      options.validateReceiptPayload ?? ((value) => value),
    );
    const prepared = await options.adapter.preflight(options.operation, receipt);
    if (prepared.noOp) return 'no-op';
    if (options.operation === 'install' && prepared.intendedReceiptBytes === null) {
      throw new InstallerValidationError('install requires intended receipt bytes');
    }
    if (options.operation === 'uninstall' && prepared.intendedReceiptBytes !== null) {
      throw new InstallerValidationError('uninstall must intend receipt absence');
    }
    if (prepared.intendedReceiptBytes !== null) {
      const intendedEnvelope = parseStrictReceiptBytes(
        prepared.intendedReceiptBytes,
        options.validateReceiptPayload ?? ((value) => value),
        'intended receipt',
      );
      if (options.transactionId !== undefined && intendedEnvelope.transactionId !== options.transactionId) {
        throw new InstallerValidationError('intended receipt transaction ID does not match the operation');
      }
    }
    const priorReceipt = receipt === undefined
      ? { kind: 'absent' } as const
      : receiptIdentityFromBytes(receipt.bytes);
    const intendedReceipt = prepared.intendedReceiptBytes === null
      ? { kind: 'absent' } as const
      : receiptIdentityFromBytes(prepared.intendedReceiptBytes);
    let journal: InstallerJournal | undefined;
    let receiptCommitDurable = false;
    try {
      journal = await prepareTransaction(options.paths, {
        operation: options.operation,
        priorReceipt,
        intendedReceipt,
        resources: prepared.resources,
        hooks,
        transactionId: options.transactionId,
      });
      if (options.operation === 'install') {
        await checkpointed(hooks, 'materialize-release', () => options.adapter.materializeRelease());
        await checkpointed(hooks, 'switch-service', () => options.adapter.switchService());
        await checkpointed(hooks, 'start-service', () => options.adapter.startService());
        await checkpointed(hooks, 'health-check-service', () => options.adapter.healthCheckService());
        await checkpointed(hooks, 'apply-codex', () => options.adapter.applyCodex());
        await checkpointed(hooks, 'apply-grok', () => options.adapter.applyGrok());
      } else {
        await checkpointed(hooks, 'restore-codex', () => options.adapter.restoreCodex());
        await checkpointed(hooks, 'restore-grok', () => options.adapter.restoreGrok());
        // Client reversals are proven together before the service they still
        // reference is removed.
        await checkpointed(hooks, 'validate-clients', () => options.adapter.validateApplied(options.operation));
        await checkpointed(hooks, 'stop-remove-service', () => options.adapter.stopAndRemoveService());
      }
      await checkpointed(hooks, 'validate-applied', async () => {
        if (options.operation === 'install') await options.adapter.validateApplied(options.operation);
        await verifyPreparedResources(prepared.resources);
      });
      journal = { ...journal, receiptCommitStarted: true };
      await writeJournal(options.paths, journal, hooks);
      await hooks.checkpoint('operation:receipt-intent-durable');
      await hooks.checkpoint('operation:before-receipt-commit');
      if (prepared.intendedReceiptBytes === null) {
        await fs.rm(options.paths.receipt, { force: true });
        await fsyncDirectory(options.paths.stateRoot);
        receiptCommitDurable = true;
      } else {
        await atomicWriteFsync(options.paths.receipt, prepared.intendedReceiptBytes, {
          mode: 0o600,
          hooks: {
            async checkpoint(name) {
              // The rename is not the durability boundary.  If an ordinary
              // handled error fires before the parent fsync, the live process
              // still has the prior receipt bytes and must roll back instead
              // of deleting the transaction snapshots as committed cleanup.
              if (name === 'receipt:after-directory-fsync') receiptCommitDurable = true;
              await hooks.checkpoint(name);
            },
          },
          label: 'receipt',
        });
        receiptCommitDurable = true;
      }
      await hooks.checkpoint('operation:after-receipt-commit');
      journal = { ...journal, phase: 'committed', conflicts: [], receiptConflict: null };
      await writeJournal(options.paths, journal, hooks);
      await hooks.checkpoint('transaction:committed');
      await checkpointed(hooks, 'cleanup-committed', () => options.adapter.cleanupCommitted(options.operation));
      await removeTransactionFiles(options.paths, journal, hooks);
      return 'changed';
    } catch (error) {
      if (error instanceof InstallerCrashSimulation) {
        crash = true;
        throw error;
      }
      const pending = await loadStrictJournal(options.paths);
      if (pending !== undefined) {
        const currentReceipt = await readReceiptIdentity(options.paths.receipt);
        if (pending.receiptCommitStarted && sameReceiptIdentity(currentReceipt, pending.intendedReceipt)) {
          if (receiptCommitDurable) {
            await checkpointed(
              hooks,
              'cleanup-committed-recovery',
              () => options.adapter.cleanupCommitted(pending.operation),
            );
            await finalizeTransaction(options.paths, pending, hooks);
            return 'changed';
          }

          // Only this still-running handled-error path can restore the exact
          // prior receipt from memory.  A simulated process death deliberately
          // bypasses this catch branch; recovery then uses the journaled
          // intended identity, as required at the crash boundary.
          if (receipt === undefined) {
            await fs.rm(options.paths.receipt, { force: true });
            await fsyncDirectory(options.paths.stateRoot);
          } else {
            await atomicWriteFsync(options.paths.receipt, receipt.bytes, {
              mode: 0o600,
              label: 'receipt-rollback',
            });
          }
          const restoredReceipt = await readReceiptIdentity(options.paths.receipt);
          if (!sameReceiptIdentity(restoredReceipt, pending.priorReceipt)) {
            throw new InstallerValidationError('prior receipt could not be restored after an interrupted commit');
          }
        }
        await rollbackTransaction(options.paths, pending, options.adapter.recoveryResources, hooks);
      }
      throw error;
    }
  } finally {
    if (!crash) {
      try {
        if (options.adapter.cleanupAttempt !== undefined) {
          await checkpointed(hooks, 'cleanup-attempt', () => options.adapter.cleanupAttempt!());
        }
      } finally {
        await lock.release();
      }
    }
  }
}

export interface BundleManifest {
  readonly version: string;
  readonly sourceCommit: string;
  readonly archive: string;
  readonly sha256: string;
  readonly installer: '.pxpipe-installer.mjs';
  readonly installerSha256: string;
}

export interface ExpectedInstallerBundleHashes {
  readonly manifestSha256: string;
  readonly archiveSha256: string;
  readonly installerSha256: string;
}

async function strictRegularFile(file: string): Promise<Uint8Array> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new InstallerValidationError(`not a regular file: ${file}`);
  return (await readRegularNoFollow(file)).bytes;
}

/** Revalidates all shell-bootstrap assumptions from the helper's own path. */
export async function validateInstallerBundle(
  entryFile: string,
  expectedHashes?: ExpectedInstallerBundleHashes,
): Promise<{
  readonly bundleDirectory: string;
  readonly manifest: BundleManifest;
  readonly archivePath: string;
  readonly archiveBytes: Uint8Array;
}> {
  if (
    expectedHashes !== undefined
    && (
      !SHA256.test(expectedHashes.manifestSha256)
      || !SHA256.test(expectedHashes.archiveSha256)
      || !SHA256.test(expectedHashes.installerSha256)
    )
  ) throw new InstallerValidationError('expected bundle hashes are invalid');
  const resolvedEntry = path.resolve(entryFile);
  if (path.basename(resolvedEntry) !== INSTALLER_PROGRAM_NAME) {
    throw new InstallerValidationError(`installer must run as ${INSTALLER_PROGRAM_NAME}`);
  }
  const bundleDirectory = path.dirname(resolvedEntry);
  const helperBytes = await strictRegularFile(resolvedEntry);
  const helperSha256 = sha256(helperBytes);
  if (
    expectedHashes !== undefined
    && helperSha256 !== expectedHashes.installerSha256
  ) throw new InstallerValidationError('installer checksum does not match the verified bundle');
  const manifestPath = path.join(bundleDirectory, 'manifest.json');
  const manifestBytes = await strictRegularFile(manifestPath);
  if (
    expectedHashes !== undefined
    && sha256(manifestBytes) !== expectedHashes.manifestSha256
  ) throw new InstallerValidationError('bundle manifest checksum does not match the verified bundle');
  const parsed = parseJsonBytes(manifestBytes, 'bundle manifest');
  if (!isPlainObject(parsed) || !exactKeys(parsed, [
    'version', 'sourceCommit', 'archive', 'sha256', 'installer', 'installerSha256',
  ])) throw new InstallerValidationError('bundle manifest has an invalid schema');
  for (const key of ['version', 'sourceCommit', 'archive', 'sha256', 'installer', 'installerSha256'] as const) {
    if (typeof parsed[key] !== 'string') throw new InstallerValidationError('bundle manifest fields must be strings');
  }
  const manifest = parsed as unknown as BundleManifest;
  if (
    !manifest.version || manifest.version.includes('/')
    || !SOURCE_COMMIT.test(manifest.sourceCommit)
    || manifest.installer !== INSTALLER_PROGRAM_NAME
    || !SHA256.test(manifest.sha256) || !SHA256.test(manifest.installerSha256)
    || path.basename(manifest.archive) !== manifest.archive
    || manifest.archive !== `pxpipe-proxy-${manifest.version}-${manifest.sourceCommit}.tgz`
  ) throw new InstallerValidationError('bundle manifest fixed fields are invalid');
  if (helperSha256 !== manifest.installerSha256) throw new InstallerValidationError('installer checksum mismatch');
  const archivePath = path.join(bundleDirectory, manifest.archive);
  const archiveBytes = await strictRegularFile(archivePath);
  const archiveSha256 = sha256(archiveBytes);
  if (
    expectedHashes !== undefined
    && archiveSha256 !== expectedHashes.archiveSha256
  ) throw new InstallerValidationError('archive checksum does not match the verified bundle');
  if (archiveSha256 !== manifest.sha256) throw new InstallerValidationError('archive checksum mismatch');
  return { bundleDirectory, manifest, archivePath, archiveBytes };
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (command, args, options = {}) => {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? undefined : { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
  });
};

function decodeCommandOutput(bytes: Uint8Array, label: string): string {
  try {
    return UTF8_FATAL.decode(bytes);
  } catch {
    throw new InstallerValidationError(`${label} returned invalid UTF-8`);
  }
}

async function checkedCommand(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly env?: Readonly<Record<string, string>> },
): Promise<CommandResult> {
  const result = await runner(command, args, options);
  if (result.code !== 0) {
    const detail = decodeCommandOutput(result.stderr, command).trim();
    throw new InstallerValidationError(
      `${command} failed with exit ${result.code}${detail ? `: ${detail}` : ''}`,
    );
  }
  return result;
}

function safeArchiveEntry(entry: string): boolean {
  const normalized = entry.replace(/^\.\//u, '').replace(/\/$/u, '');
  if (
    (normalized !== 'package' && !normalized.startsWith('package/'))
    || normalized.includes('\\')
    || normalized.includes('\0')
  ) {
    return false;
  }
  return !normalized.split('/').some((part) => part === '' || part === '.' || part === '..');
}

export interface ExtractedBundle {
  readonly packageDirectory: string;
  readonly cliPath: string;
  readonly nodeBundlePath: string;
  readonly installerBundlePath: string;
}

/** List/type-check the verified tarball before extracting its single package root. */
export async function extractVerifiedPackage(
  verified: Awaited<ReturnType<typeof validateInstallerBundle>>,
  destination: string,
  runner: CommandRunner = runCommand,
): Promise<ExtractedBundle> {
  if (!path.isAbsolute(destination)) {
    throw new InstallerValidationError('extraction destination must be absolute');
  }
  await fs.mkdir(destination, { mode: 0o700 });
  const destinationStat = await fs.lstat(destination);
  if (
    !destinationStat.isDirectory()
    || destinationStat.isSymbolicLink()
    || (destinationStat.mode & 0o777) !== 0o700
  ) throw new InstallerValidationError('extraction destination must be a fresh 0700 directory');

  // Never hand tar the mutable bundle path after validating it.  Publish the
  // already-verified bytes into this invocation's private directory and use
  // only that copy for listing, type checks, and extraction.
  if (sha256(verified.archiveBytes) !== verified.manifest.sha256) {
    throw new InstallerValidationError('verified archive bytes changed in memory');
  }
  const stagedArchive = path.join(destination, '.pxpipe-verified-package.tgz');
  await atomicWriteFsync(stagedArchive, verified.archiveBytes, {
    mode: 0o600,
    label: 'verified-archive',
  });
  const stagedArchiveBytes = await strictRegularFile(stagedArchive);
  if (sha256(stagedArchiveBytes) !== verified.manifest.sha256) {
    throw new InstallerValidationError('staged archive checksum mismatch');
  }

  const listingResult = await checkedCommand(runner, 'tar', ['-tzf', stagedArchive]);
  const entries = decodeCommandOutput(listingResult.stdout, 'tar listing')
    .split(/\r?\n/u)
    .filter(Boolean);
  if (entries.length === 0 || entries.some((entry) => !safeArchiveEntry(entry))) {
    throw new InstallerValidationError('package archive contains an unsafe path');
  }
  const verboseResult = await checkedCommand(runner, 'tar', ['-tvzf', stagedArchive]);
  const verboseLines = decodeCommandOutput(verboseResult.stdout, 'tar verbose listing')
    .split(/\r?\n/u)
    .filter(Boolean);
  if (
    verboseLines.length !== entries.length
    || verboseLines.some((line) => line[0] !== '-' && line[0] !== 'd')
  ) throw new InstallerValidationError('package archive contains a link or unsupported entry type');

  await checkedCommand(runner, 'tar', ['-xzf', stagedArchive, '-C', destination]);
  const packageDirectory = path.join(destination, 'package');
  const required = {
    cliPath: path.join(packageDirectory, 'bin', 'cli.js'),
    nodeBundlePath: path.join(packageDirectory, 'dist', 'node.js'),
    installerBundlePath: path.join(packageDirectory, 'dist', 'macos-local-installer.js'),
  };
  const packageJsonPath = path.join(packageDirectory, 'package.json');
  const packageJsonBytes = await strictRegularFile(packageJsonPath);
  await strictRegularFile(required.cliPath);
  await strictRegularFile(required.nodeBundlePath);
  const packagedInstallerBytes = await strictRegularFile(required.installerBundlePath);
  if (sha256(packagedInstallerBytes) !== verified.manifest.installerSha256) {
    throw new InstallerValidationError('packaged installer checksum does not match the running installer');
  }
  const packageJson = parseJsonBytes(packageJsonBytes, 'package.json');
  if (!isPlainObject(packageJson) || packageJson.version !== verified.manifest.version) {
    throw new InstallerValidationError('package version does not match the bundle manifest');
  }
  const versionResult = await checkedCommand(runner, process.execPath, [required.cliPath, '--version']);
  if (decodeCommandOutput(versionResult.stdout, 'packaged CLI').trim() !== verified.manifest.version) {
    throw new InstallerValidationError('packaged command reported the wrong version');
  }
  return { packageDirectory, ...required };
}

export interface MacosServiceOperations {
  stop(): Promise<void>;
  waitForPortFree(): Promise<void>;
  start(): Promise<void>;
  healthCheck(): Promise<void>;
}

export interface MacosServiceOptions {
  readonly paths: MacosInstallerPaths;
  readonly uid: number;
  readonly port: number;
  readonly runner?: CommandRunner;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

function launchctlPrintProvesServiceAbsent(result: CommandResult, uid: number): boolean {
  if (result.code !== 113) return false;
  const stdout = decodeCommandOutput(result.stdout, 'launchctl print');
  const stderr = decodeCommandOutput(result.stderr, 'launchctl print');
  const expected = [
    'Bad request.',
    `Could not find service "com.pxpipe.proxy" in domain for user gui: ${uid}`,
  ].join('\n');
  return stdout === '' && (stderr === expected || stderr === `${expected}\n`);
}

function commandFailure(command: string, result: CommandResult): InstallerValidationError {
  const detail = decodeCommandOutput(result.stderr, command).trim();
  return new InstallerValidationError(
    `${command} failed with exit ${result.code}${detail ? `: ${detail}` : ''}`,
  );
}

/** Default launchd/lsof/loopback-curl operations; tests replace the runner. */
export function createMacosServiceOperations(options: MacosServiceOptions): MacosServiceOperations {
  if (
    !Number.isSafeInteger(options.uid)
    || options.uid < 0
    || !Number.isSafeInteger(options.port)
    || options.port < 1
    || options.port > 65_535
  ) throw new InstallerValidationError('invalid service options');
  const runner = options.runner ?? runCommand;
  const sleep = options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const domain = `gui/${options.uid}`;
  const label = `${domain}/com.pxpipe.proxy`;
  return {
    async stop(): Promise<void> {
      const printed = await runner('launchctl', ['print', label]);
      if (launchctlPrintProvesServiceAbsent(printed, options.uid)) return;
      if (printed.code !== 0) throw commandFailure('launchctl print', printed);
      const printStdout = decodeCommandOutput(printed.stdout, 'launchctl print');
      const printStderr = decodeCommandOutput(printed.stderr, 'launchctl print');
      if (printStdout.trim() === '' || printStderr !== '') {
        throw new InstallerValidationError('launchctl print returned malformed service state');
      }
      await checkedCommand(runner, 'launchctl', ['bootout', domain, options.paths.launchAgent]);
    },
    async waitForPortFree(): Promise<void> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await runner('lsof', [
          '-w', '-nP', `-iTCP:${options.port}`, '-sTCP:LISTEN', '-t',
        ]);
        if (result.code === 1 && result.stdout.byteLength === 0 && result.stderr.byteLength === 0) return;
        if (result.code !== 0) throw commandFailure('lsof', result);
        const output = decodeCommandOutput(result.stdout, 'lsof');
        const errorOutput = decodeCommandOutput(result.stderr, 'lsof');
        const listeners = output.split(/\n/u).filter((line) => line !== '');
        if (errorOutput !== '' || listeners.length === 0 || listeners.some((line) => !/^[0-9]+$/u.test(line))) {
          throw new InstallerValidationError('lsof returned malformed listener state');
        }
        await sleep(100);
      }
      throw new InstallerValidationError(`port ${options.port} remains in use`);
    },
    async start(): Promise<void> {
      await checkedCommand(runner, 'launchctl', ['bootstrap', domain, options.paths.launchAgent]);
      await checkedCommand(runner, 'launchctl', ['kickstart', '-k', label]);
    },
    async healthCheck(): Promise<void> {
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const result = await runner('curl', [
          '--fail', '--silent', '--show-error', '--output', '/dev/null',
          '--max-time', '2', `http://127.0.0.1:${options.port}/`,
        ]);
        if (result.code === 0) return;
        await sleep(1_000);
      }
      throw new InstallerValidationError('installed service did not become healthy');
    },
  };
}

export async function currentProcessIdentity(
  runner: CommandRunner = runCommand,
): Promise<ProcessIdentity> {
  const uid = process.getuid?.() ?? process.geteuid?.();
  if (uid === undefined) throw new InstallerValidationError('cannot determine current uid');
  const result = await checkedCommand(runner, 'ps', ['-o', 'lstart=', '-p', String(process.pid)]);
  const startSignature = decodeCommandOutput(result.stdout, 'ps').trim();
  const identity = { uid, pid: process.pid, startSignature };
  validateProcessIdentity(identity);
  return identity;
}

export function createProcessLivenessCheck(
  runner: CommandRunner = runCommand,
): (identity: ProcessIdentity) => Promise<boolean> {
  return async (identity) => {
    validateProcessIdentity(identity);
    const result = await runner('ps', ['-o', 'uid=', '-o', 'lstart=', '-p', String(identity.pid)]);
    if (result.code === 1 && result.stdout.byteLength === 0 && result.stderr.byteLength === 0) return false;
    if (result.code !== 0) throw commandFailure('ps', result);
    const stdout = decodeCommandOutput(result.stdout, 'ps');
    const stderr = decodeCommandOutput(result.stderr, 'ps');
    if (stderr !== '') throw new InstallerValidationError('ps returned unexpected error output');
    const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
    if (lines.length !== 1 || lines[0] === '') {
      throw new InstallerValidationError('ps returned malformed process identity');
    }
    const match = /^[ \t]*([0-9]+)[ \t]+([^\r\n]*\S)[ \t]*$/u.exec(lines[0]!);
    if (match === null) throw new InstallerValidationError('ps returned malformed process identity');
    const uid = Number(match[1]);
    if (!Number.isSafeInteger(uid)) throw new InstallerValidationError('ps returned malformed process identity');
    return uid === identity.uid && match[2] === identity.startSignature;
  };
}

function xml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
}

/** Deterministic plist with no ambient API key, gateway, or provider fields. */
export function buildLaunchAgentPlist(
  releaseCli: string,
  port: number,
  nodeExecutable = process.execPath,
): Uint8Array {
  if (!path.isAbsolute(releaseCli) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InstallerValidationError('invalid LaunchAgent inputs');
  }
  if (!path.isAbsolute(nodeExecutable)) {
    throw new InstallerValidationError('Node executable must be absolute');
  }
  const environment: Readonly<Record<string, string>> = {
    HOST: '127.0.0.1',
    PORT: String(port),
    PXPIPE_MODELS: INSTALLED_MODELS,
    PXPIPE_CODEX_UPSTREAM: CODEX_SUBSCRIPTION_UPSTREAM,
    PXPIPE_GROK_UPSTREAM: GROK_SUBSCRIPTION_UPSTREAM,
  };
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `      <key>${xml(key)}</key>\n      <string>${xml(value)}</string>`)
    .join('\n');
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.pxpipe.proxy</string>\n  <key>ProgramArguments</key>\n  <array>\n    <string>${xml(nodeExecutable)}</string>\n    <string>${xml(releaseCli)}</string>\n  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n${environmentXml}\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n</dict>\n</plist>\n`);
}

export function installerEntryPath(importUrl: string, argvEntry: string | undefined): string {
  const fromUrl = fileURLToPath(importUrl);
  if (argvEntry === undefined || path.resolve(argvEntry) !== path.resolve(fromUrl)) {
    throw new InstallerValidationError('installer entry path does not match the running module');
  }
  return fromUrl;
}
