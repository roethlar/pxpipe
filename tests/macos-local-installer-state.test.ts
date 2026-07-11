import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_SUBSCRIPTION_UPSTREAM,
  GROK_SUBSCRIPTION_UPSTREAM,
  INSTALLER_PROGRAM_NAME,
  INSTALLED_MODELS,
  InstallerBusyError,
  InstallerConflictError,
  InstallerCrashSimulation,
  InstallerValidationError,
  acquireInstallerLock,
  atomicWriteFsync,
  buildLaunchAgentPlist,
  createFileResourceAdapter,
  createMacosServiceOperations,
  createProcessLivenessCheck,
  extractVerifiedPackage,
  loadStrictJournal,
  parseInstallerInvocation,
  prepareTransaction,
  readReceiptIdentity,
  recoverPendingTransaction,
  resolveMacosInstallerPaths,
  runInstallerOperation,
  sameResourceIdentity,
  serializeReceipt,
  sha256,
  validateInstallerBundle,
  type CapturedResource,
  type CommandResult,
  type InstallerHooks,
  type InstallerOperation,
  type InstallerOperationAdapter,
  type MacosInstallerPaths,
  type PreparedInstallerOperation,
  type ProcessIdentity,
  type ResourceIdentity,
  type TransactionResourceAdapter,
} from '../src/macos-local-installer.js';

const UID = process.getuid?.() ?? process.geteuid?.() ?? 0;
const TX = '1234567890abcdef1234567890abcdef';
const encoder = new TextEncoder();

function commandResult(code: number, stdout = '', stderr = ''): CommandResult {
  return { code, stdout: encoder.encode(stdout), stderr: encoder.encode(stderr) };
}

let root: string;
let paths: MacosInstallerPaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-installer-state-'));
  paths = resolveMacosInstallerPaths(path.join(root, 'home'));
  await fs.mkdir(paths.home, { mode: 0o700 });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function present(bytes: Uint8Array | string, mode = 0o600): ResourceIdentity {
  const data = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  return { exists: true, uid: UID, mode, sha256: sha256(data) };
}

class MemoryResource implements TransactionResourceAdapter {
  private bytes: Uint8Array | null;
  private mode = 0o600;
  restoreCalls = 0;

  constructor(
    readonly name: TransactionResourceAdapter['name'],
    readonly displayPath: string,
    initial: string | null,
    readonly restoreWhenPriorEqualsApplied = false,
  ) {
    this.bytes = initial === null ? null : encoder.encode(initial);
  }

  set(value: string | null): void {
    this.bytes = value === null ? null : encoder.encode(value);
  }

  text(): string | null {
    return this.bytes === null ? null : new TextDecoder().decode(this.bytes);
  }

  async capture(): Promise<CapturedResource> {
    if (this.bytes === null) return { identity: { exists: false }, snapshot: null };
    const copy = new Uint8Array(this.bytes);
    return { identity: present(copy, this.mode), snapshot: copy };
  }

  async currentIdentity(): Promise<ResourceIdentity> {
    return (await this.capture()).identity;
  }

  async restore(prior: ResourceIdentity, snapshot: Uint8Array | null): Promise<void> {
    this.restoreCalls += 1;
    if (!prior.exists) {
      this.bytes = null;
      return;
    }
    if (snapshot === null || sha256(snapshot) !== prior.sha256) throw new Error('bad snapshot');
    this.bytes = new Uint8Array(snapshot);
    this.mode = prior.mode;
  }
}

function processIdentity(pid: number, startSignature: string): ProcessIdentity {
  return { uid: UID, pid, startSignature };
}

function nonces(): () => string {
  let value = 0;
  return () => (++value).toString(16).padStart(32, '0');
}

function lockDependencies(identity = processIdentity(100, 'start-a')) {
  return {
    process: identity,
    isProcessAlive: async () => false,
    nonce: nonces(),
  };
}

function planned(resource: TransactionResourceAdapter, value: string | null) {
  return {
    adapter: resource,
    applied: value === null ? { exists: false } as const : present(value),
  };
}

function operationAdapter(options: {
  operation: InstallerOperation;
  resource: MemoryResource;
  applied: string | null;
  receiptBytes: Uint8Array | null;
  events?: string[];
  failAt?: string;
}): InstallerOperationAdapter {
  const events = options.events ?? [];
  const act = async (name: string, mutate = false): Promise<void> => {
    events.push(name);
    if (mutate) options.resource.set(options.applied);
    if (options.failAt === name) throw new Error(name);
  };
  return {
    recoveryResources: [options.resource],
    async preflight(operation): Promise<PreparedInstallerOperation> {
      expect(operation).toBe(options.operation);
      events.push('preflight');
      return {
        noOp: false,
        resources: [planned(options.resource, options.applied)],
        intendedReceiptBytes: options.receiptBytes,
      };
    },
    materializeRelease: () => act('materialize'),
    switchService: () => act('switch'),
    startService: () => act('start'),
    healthCheckService: () => act('health'),
    applyCodex: () => act('codex', options.operation === 'install'),
    applyGrok: () => act('grok'),
    restoreCodex: () => act('restore-codex', options.operation === 'uninstall'),
    restoreGrok: () => act('restore-grok'),
    stopAndRemoveService: () => act('stop'),
    validateApplied: () => act('validate'),
    cleanupCommitted: () => act('cleanup'),
  };
}

async function seedReceipt(bytes: Uint8Array): Promise<void> {
  await fs.mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.receipt, bytes, { mode: 0o600 });
}

async function markJournalCommitted(): Promise<void> {
  const journal = JSON.parse(await fs.readFile(paths.journal, 'utf8')) as Record<string, unknown>;
  journal.phase = 'committed';
  journal.receiptCommitStarted = true;
  await fs.writeFile(paths.journal, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
}

describe('fixed schema and durable writes', () => {
  it('uses the approved fixed paths and accepts only the two invocations', () => {
    expect(paths.stateRoot).toBe(path.join(paths.installRoot, 'state'));
    expect(paths.lock).toBe(path.join(paths.stateRoot, 'installer.lock'));
    expect(paths.receipt).toBe(path.join(paths.stateRoot, 'receipt-v1.json'));
    expect(paths.journal).toBe(path.join(paths.stateRoot, 'journal-v1.json'));
    expect(paths.codexConfig).toBe(path.join(paths.home, '.codex', 'config.toml'));
    expect(paths.grokConfig).toBe(path.join(paths.home, '.grok', 'config.toml'));
    expect(parseInstallerInvocation([])).toBe('install');
    expect(parseInstallerInvocation(['--uninstall'])).toBe('uninstall');
    expect(() => parseInstallerInvocation(['--install'])).toThrow(InstallerValidationError);
  });

  it('atomically writes exact bytes at 0600 and exposes ordered durability hooks', async () => {
    const directory = path.join(root, 'atomic');
    const file = path.join(directory, 'value');
    const checkpoints: string[] = [];
    await fs.mkdir(directory);
    await atomicWriteFsync(file, new Uint8Array([0, 1, 2, 255]), {
      mode: 0o600,
      nonce: nonces(),
      hooks: { checkpoint: (name) => checkpoints.push(name) },
    });
    expect([...await fs.readFile(file)]).toEqual([0, 1, 2, 255]);
    expect((await fs.lstat(file)).mode & 0o777).toBe(0o600);
    expect(checkpoints).toEqual([
      'atomic-write:before-open',
      'atomic-write:after-open',
      'atomic-write:after-write',
      'atomic-write:after-fsync',
      'atomic-write:after-rename',
      'atomic-write:after-directory-fsync',
    ]);
  });

  it('preserves an exact 0644 owner mode under the installer umask and rollback', async () => {
    const directory = path.join(root, 'owner-mode');
    const file = path.join(directory, 'config.toml');
    await fs.mkdir(directory);
    await fs.writeFile(file, 'owner\n');
    await fs.chmod(file, 0o644);
    const adapter = createFileResourceAdapter('codexConfig', file);
    const captured = await adapter.capture();
    const previousUmask = process.umask(0o077);
    try {
      await atomicWriteFsync(file, 'managed\n', { mode: 0o644, nonce: nonces() });
      expect((await fs.lstat(file)).mode & 0o777).toBe(0o644);
      await adapter.restore(captured.identity, captured.snapshot);
    } finally {
      process.umask(previousUmask);
    }
    expect(await fs.readFile(file, 'utf8')).toBe('owner\n');
    expect((await fs.lstat(file)).mode & 0o777).toBe(0o644);
  });

  it('rejects a managed file changed between its open read and path recheck', async () => {
    const directory = path.join(root, 'capture-race');
    const file = path.join(directory, 'config.toml');
    await fs.mkdir(directory);
    await fs.writeFile(file, 'before\n', { mode: 0o600 });
    const adapter = createFileResourceAdapter('codexConfig', file, {
      async checkpoint(name) {
        if (name === 'capture:codexConfig:after-read') await fs.writeFile(file, 'owner edit\n');
      },
    });
    await expect(adapter.capture()).rejects.toThrow(InstallerConflictError);
    expect(await fs.readFile(file, 'utf8')).toBe('owner edit\n');
  });

  it('does not follow a symlink swapped in after an atomic rollback replacement', async () => {
    const directory = path.join(root, 'rollback-symlink-race');
    const file = path.join(directory, 'config.toml');
    const external = path.join(root, 'external-owner-file');
    await fs.mkdir(directory);
    await fs.writeFile(file, 'owner\n');
    await fs.chmod(file, 0o644);
    await fs.writeFile(external, 'external\n');
    await fs.chmod(external, 0o600);
    let swapped = false;
    const adapter = createFileResourceAdapter('codexConfig', file, {
      async checkpoint(name) {
        if (name === 'rollback:codexConfig:after-directory-fsync') {
          await fs.rm(file);
          await fs.symlink(external, file);
          swapped = true;
        }
      },
    });
    const prior = await adapter.capture();
    await fs.writeFile(file, 'managed\n');
    await fs.chmod(file, 0o600);
    await adapter.restore(prior.identity, prior.snapshot);
    expect(swapped).toBe(true);
    expect((await fs.lstat(file)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(external, 'utf8')).toBe('external\n');
    expect((await fs.lstat(external)).mode & 0o777).toBe(0o600);
  });

  it('strictly rejects extra receipt and journal fields', async () => {
    await fs.mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.journal, JSON.stringify({ schemaVersion: 1, extra: true }), { mode: 0o600 });
    await expect(loadStrictJournal(paths)).rejects.toThrow(InstallerValidationError);
  });

  it('rejects a published journal missing an expected resource', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'new')],
      transactionId: TX,
    });
    const journal = JSON.parse(await fs.readFile(paths.journal, 'utf8')) as Record<string, unknown>;
    journal.resources = [];
    await fs.writeFile(paths.journal, `${JSON.stringify(journal)}\n`, { mode: 0o600 });
    await expect(loadStrictJournal(paths)).rejects.toThrow('missing prepared resources');
  });
});

describe('hard-link installer lock', () => {
  it('reclaims dead complete candidates and incomplete candidate temporaries after claiming the lock', async () => {
    await expect(acquireInstallerLock(paths, 'install', {
      process: processIdentity(81, 'dead-candidate'),
      isProcessAlive: async () => false,
      nonce: nonces(),
      hooks: {
        checkpoint(name) {
          if (name === 'lock:after-candidate') throw new InstallerCrashSimulation('death');
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    await expect(acquireInstallerLock(paths, 'install', {
      process: processIdentity(82, 'dead-temporary'),
      isProcessAlive: async () => false,
      nonce: nonces(),
      hooks: {
        checkpoint(name) {
          if (name === 'lock:candidate:after-open') throw new InstallerCrashSimulation('death');
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect((await fs.readdir(paths.stateRoot)).filter((name) => name.includes('candidate'))).toHaveLength(2);
    const recovered = await acquireInstallerLock(paths, 'install', {
      process: processIdentity(83, 'recovered'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    expect((await fs.readdir(paths.stateRoot)).filter((name) => (
      name.includes('candidate') && path.join(paths.stateRoot, name) !== recovered.candidatePath
    ))).toEqual([]);
    await recovered.release();
  });

  it('refuses a symlinked state ancestor before writing through it', async () => {
    const library = path.join(paths.home, 'Library');
    const external = path.join(root, 'external');
    await fs.mkdir(library, { mode: 0o700 });
    await fs.mkdir(external, { mode: 0o700 });
    await fs.symlink(external, path.join(library, 'Application Support'));
    await expect(acquireInstallerLock(paths, 'install', {
      process: processIdentity(99, 'start'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    })).rejects.toThrow('unsafe installer directory');
    expect(await fs.readdir(external)).toEqual([]);
  });

  it('keeps a complete live winner and gives the contender no lock ownership', async () => {
    const firstIdentity = processIdentity(101, 'start-first');
    const first = await acquireInstallerLock(paths, 'install', {
      process: firstIdentity,
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    const raw = JSON.parse(await fs.readFile(paths.lock, 'utf8')) as Record<string, unknown>;
    expect(raw).toMatchObject({ uid: UID, pid: 101, startSignature: 'start-first', operation: 'install' });
    await expect(acquireInstallerLock(paths, 'uninstall', {
      process: processIdentity(102, 'start-second'),
      isProcessAlive: async (candidate) => (
        candidate.pid === firstIdentity.pid && candidate.startSignature === firstIdentity.startSignature
      ),
      nonce: nonces(),
    })).rejects.toThrow(InstallerBusyError);
    expect(JSON.parse(await fs.readFile(paths.lock, 'utf8'))).toMatchObject({ pid: 101 });
    await first.release();
    await expect(fs.lstat(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('quarantines stale locks and does not treat PID reuse as liveness', async () => {
    const abandoned = await acquireInstallerLock(paths, 'install', {
      process: processIdentity(201, 'old-process-start'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    const replacement = await acquireInstallerLock(paths, 'uninstall', {
      process: processIdentity(201, 'reused-pid-new-start'),
      isProcessAlive: async (candidate) => (
        candidate.pid === 201 && candidate.startSignature === 'reused-pid-new-start'
      ),
      nonce: nonces(),
    });
    expect(replacement.quarantinedPaths).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(paths.lock, 'utf8'))).toMatchObject({
      pid: 201,
      startSignature: 'reused-pid-new-start',
    });
    await replacement.release();
    await fs.rm(abandoned.candidatePath, { force: true });
  });

  it('does not let a delayed stale reclaimer move a newer live lock', async () => {
    const abandoned = await acquireInstallerLock(paths, 'install', {
      process: processIdentity(301, 'stale'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    let resume!: () => void;
    let paused!: () => void;
    const isPaused = new Promise<void>((resolve) => { paused = resolve; });
    const canResume = new Promise<void>((resolve) => { resume = resolve; });
    let held = false;
    const delayed = acquireInstallerLock(paths, 'uninstall', {
      process: processIdentity(302, 'delayed'),
      isProcessAlive: async (candidate) => candidate.startSignature === 'new-live',
      nonce: nonces(),
      hooks: {
        async checkpoint(name) {
          if (name === 'lock:before-quarantine' && !held) {
            held = true;
            paused();
            await canResume;
          }
        },
      },
    });
    await isPaused;
    const live = await acquireInstallerLock(paths, 'install', {
      process: processIdentity(303, 'new-live'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    resume();
    await expect(delayed).rejects.toThrow(InstallerBusyError);
    expect(JSON.parse(await fs.readFile(paths.lock, 'utf8'))).toMatchObject({
      pid: 303,
      startSignature: 'new-live',
    });
    await live.release();
    await fs.rm(abandoned.candidatePath, { force: true });
  });

  it('recovers when a reclaimer dies after stale quarantine', async () => {
    await acquireInstallerLock(paths, 'install', {
      process: processIdentity(401, 'stale'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    await expect(acquireInstallerLock(paths, 'uninstall', {
      process: processIdentity(402, 'dies'),
      isProcessAlive: async () => false,
      nonce: nonces(),
      hooks: {
        checkpoint(name) {
          if (name === 'lock:after-quarantine') throw new InstallerCrashSimulation('death');
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    await expect(fs.lstat(paths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(paths.stateRoot)).some((name) => name.includes('.stale-'))).toBe(true);
    const recovered = await acquireInstallerLock(paths, 'install', {
      process: processIdentity(403, 'recovered'),
      isProcessAlive: async () => false,
      nonce: nonces(),
    });
    expect((await fs.readdir(paths.stateRoot)).some((name) => name.includes('.stale-'))).toBe(false);
    await recovered.release();
  });
});

describe('journal recovery', () => {
  it('removes an orphan transaction and journal temp after death before publication', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await expect(prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'new')],
      transactionId: TX,
      hooks: {
        checkpoint(name) {
          if (name === 'journal:preparing:after-write') {
            throw new InstallerCrashSimulation('death before journal rename');
          }
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect(await loadStrictJournal(paths)).toBeUndefined();
    expect(await fs.readdir(paths.transactions)).toEqual([TX]);
    expect((await fs.readdir(paths.stateRoot)).some((name) => name.endsWith('.tmp'))).toBe(true);
    expect(await recoverPendingTransaction(paths, [codex])).toBe('preparing-cleaned');
    expect(await fs.readdir(paths.transactions)).toEqual([]);
    expect((await fs.readdir(paths.stateRoot)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect(codex.text()).toBe('old');
  });

  it('removes preparing debris without touching resources', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const hooks: InstallerHooks = {
      checkpoint(name) {
        if (name === 'transaction:snapshot:codexConfig') throw new InstallerCrashSimulation('death');
      },
    };
    await expect(prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'new')],
      transactionId: TX,
      hooks,
    })).rejects.toThrow(InstallerCrashSimulation);
    expect((await loadStrictJournal(paths))?.phase).toBe('preparing');
    expect(await recoverPendingTransaction(paths, [codex])).toBe('preparing-cleaned');
    expect(codex.text()).toBe('old');
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('refuses to clean a transaction directory whose private mode changed', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const journal = await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'new')],
      transactionId: TX,
    });
    await fs.chmod(journal.transactionDirectory, 0o755);
    await expect(recoverPendingTransaction(paths, [codex])).rejects.toThrow(
      'transaction directory must be owner-controlled 0700',
    );
    expect(codex.text()).toBe('old');
    expect(await loadStrictJournal(paths)).toBeDefined();
  });

  it('rolls ready resources back in reverse order', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'codex-old');
    const grok = new MemoryResource('grokConfig', path.join(root, 'grok'), 'grok-old');
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'codex-new'), planned(grok, 'grok-new')],
      transactionId: TX,
    });
    codex.set('codex-new');
    grok.set('grok-new');
    const order: string[] = [];
    expect(await recoverPendingTransaction(paths, [codex, grok], {
      checkpoint(name) {
        if (name.startsWith('rollback:before:')) order.push(name);
      },
    })).toBe('rolled-back');
    expect(order).toEqual(['rollback:before:grokConfig', 'rollback:before:codexConfig']);
    expect(codex.text()).toBe('codex-old');
    expect(grok.text()).toBe('grok-old');
  });

  it('runs an explicit compensating restore when prior and applied identities are equal', async () => {
    const service = new MemoryResource('serviceState', path.join(root, 'service'), 'loaded', true);
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(service, 'loaded')],
      transactionId: TX,
    });
    expect(await recoverPendingTransaction(paths, [service])).toBe('rolled-back');
    expect(service.restoreCalls).toBe(1);
    expect(service.text()).toBe('loaded');
  });

  it('does not repeat a completed compensating restore after snapshot-directory cleanup', async () => {
    const service = new MemoryResource('serviceState', path.join(root, 'service'), 'loaded', true);
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(service, 'loaded')],
      transactionId: TX,
    });
    await expect(recoverPendingTransaction(paths, [service], {
      checkpoint(name) {
        if (name === 'transaction:after-directory-cleanup') {
          throw new InstallerCrashSimulation('death after snapshot cleanup');
        }
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect(service.restoreCalls).toBe(1);
    const interrupted = await loadStrictJournal(paths);
    expect(interrupted?.resources[0]?.restored).toBe(true);
    await expect(fs.lstat(interrupted!.transactionDirectory)).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await recoverPendingTransaction(paths, [service])).toBe('rolled-back');
    expect(service.restoreCalls).toBe(1);
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('retains snapshots and blocks mutation on a third identity', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'applied')],
      transactionId: TX,
    });
    codex.set('owner-edit');
    await expect(recoverPendingTransaction(paths, [codex])).rejects.toThrow(InstallerConflictError);
    expect(codex.text()).toBe('owner-edit');
    const journal = await loadStrictJournal(paths);
    expect(journal?.phase).toBe('conflicted');
    expect(journal?.conflicts[0]).toMatchObject({ name: 'codexConfig', displayPath: codex.displayPath });
    expect(await fs.readFile(journal!.resources[0]!.snapshotPath!, 'utf8')).toBe('old');
  });

  it('durably records unsafe file states as conflicts without following or reading them', async () => {
    const cases = [
      { reason: 'symbolic-link', mutate: 'symlink' },
      { reason: 'non-file', mutate: 'directory' },
      { reason: 'unsafe-mode', mutate: 'mode' },
      { reason: 'wrong-owner', mutate: 'owner-expectation' },
    ] as const;
    for (const scenario of cases) {
      const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), `pxpipe-unsafe-${scenario.mutate}-`));
      try {
        const localPaths = resolveMacosInstallerPaths(path.join(localRoot, 'home'));
        await fs.mkdir(localPaths.home, { mode: 0o700 });
        const managed = path.join(localRoot, 'managed-config');
        const external = path.join(localRoot, 'external-owner-file');
        await fs.writeFile(managed, 'prior\n', { mode: 0o600 });
        const adapter = createFileResourceAdapter('codexConfig', managed);
        await prepareTransaction(localPaths, {
          operation: 'install',
          priorReceipt: { kind: 'absent' },
          intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
          resources: [planned(adapter, 'applied\n')],
          transactionId: TX,
        });
        await fs.writeFile(managed, 'applied\n', { mode: 0o600 });
        if (scenario.mutate === 'symlink') {
          await fs.writeFile(external, 'do not read or change\n', { mode: 0o600 });
          await fs.rm(managed);
          await fs.symlink(external, managed);
        } else if (scenario.mutate === 'directory') {
          await fs.rm(managed);
          await fs.mkdir(managed);
        } else {
          await fs.chmod(managed, 0o666);
        }

        const recoveryAdapter = scenario.mutate === 'owner-expectation'
          ? createFileResourceAdapter('codexConfig', managed, undefined, UID + 1)
          : adapter;
        await expect(recoverPendingTransaction(localPaths, [recoveryAdapter])).rejects.toThrow(InstallerConflictError);
        const journal = await loadStrictJournal(localPaths);
        expect(journal?.phase).toBe('conflicted');
        expect(journal?.conflicts[0]?.current).toMatchObject({
          kind: 'unsafe',
          reason: scenario.reason,
        });
        if (scenario.mutate === 'symlink') {
          expect(await fs.readFile(external, 'utf8')).toBe('do not read or change\n');
          expect((await fs.lstat(managed)).isSymbolicLink()).toBe(true);
        }
      } finally {
        await fs.rm(localRoot, { recursive: true, force: true });
      }
    }
  });

  it('refuses a replaced snapshot instead of following it', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256('receipt') },
      resources: [planned(codex, 'applied')],
      transactionId: TX,
    });
    const journal = (await loadStrictJournal(paths))!;
    const snapshot = journal.resources[0]!.snapshotPath!;
    const unrelated = path.join(root, 'unrelated-secret');
    await fs.writeFile(unrelated, 'not-a-snapshot');
    await fs.rm(snapshot);
    await fs.symlink(unrelated, snapshot);
    codex.set('applied');
    await expect(recoverPendingTransaction(paths, [codex])).rejects.toThrow(
      'snapshot must be a regular 0600 file',
    );
    expect(codex.text()).toBe('applied');
  });

  it('finalizes a committed journal only when the intended receipt is present', async () => {
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const intended = serializeReceipt(TX, { source: 'intended' });
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'absent' },
      intendedReceipt: { kind: 'sha256', sha256: sha256(intended) },
      resources: [planned(codex, 'applied')],
      transactionId: TX,
    });
    codex.set('applied');
    await seedReceipt(intended);
    await markJournalCommitted();
    const cleanup: InstallerOperation[] = [];
    expect(await recoverPendingTransaction(
      paths,
      [codex],
      undefined,
      async (operation) => { cleanup.push(operation); },
    )).toBe('committed-finalized');
    expect(cleanup).toEqual(['install']);
    expect(codex.text()).toBe('applied');
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('rolls committed resources back when the prior receipt is still authoritative', async () => {
    const prior = serializeReceipt('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { source: 'prior' });
    const intended = serializeReceipt(TX, { source: 'intended' });
    await seedReceipt(prior);
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'sha256', sha256: sha256(prior) },
      intendedReceipt: { kind: 'sha256', sha256: sha256(intended) },
      resources: [planned(codex, 'applied')],
      transactionId: TX,
    });
    codex.set('applied');
    await markJournalCommitted();
    expect(await recoverPendingTransaction(paths, [codex])).toBe('rolled-back');
    expect(codex.text()).toBe('old');
    expect(await fs.readFile(paths.receipt)).toEqual(Buffer.from(prior));
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('retains a committed journal and snapshots when the receipt has a third identity', async () => {
    const prior = serializeReceipt('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { source: 'prior' });
    const intended = serializeReceipt(TX, { source: 'intended' });
    const third = serializeReceipt('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { source: 'owner-edit' });
    await seedReceipt(prior);
    const codex = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await prepareTransaction(paths, {
      operation: 'install',
      priorReceipt: { kind: 'sha256', sha256: sha256(prior) },
      intendedReceipt: { kind: 'sha256', sha256: sha256(intended) },
      resources: [planned(codex, 'applied')],
      transactionId: TX,
    });
    codex.set('applied');
    await markJournalCommitted();
    await seedReceipt(third);
    await expect(recoverPendingTransaction(paths, [codex])).rejects.toThrow(InstallerConflictError);
    expect(codex.text()).toBe('applied');
    expect(await fs.readFile(paths.receipt)).toEqual(Buffer.from(third));
    const journal = await loadStrictJournal(paths);
    expect(journal?.phase).toBe('conflicted');
    expect(journal?.receiptConflict?.current).toEqual({ kind: 'sha256', sha256: sha256(third) });
    expect(await fs.readFile(journal!.resources[0]!.snapshotPath!, 'utf8')).toBe('old');
  });
});

describe('orchestration and receipt boundary', () => {
  it('cleans attempt staging under the lock even for a no-op', async () => {
    const events: string[] = [];
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const base = operationAdapter({ operation: 'install', resource, applied: 'old', receiptBytes: null });
    const adapter: InstallerOperationAdapter = {
      ...base,
      async preflight() {
        events.push('preflight');
        return { noOp: true, resources: [], intendedReceiptBytes: null };
      },
      async cleanupAttempt() {
        events.push('attempt-cleanup');
      },
    };
    expect(await runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter,
      hooks: {
        checkpoint(name) {
          if (name === 'lock:before-release') events.push('lock-release');
        },
      },
    })).toBe('no-op');
    expect(events).toEqual(['preflight', 'attempt-cleanup', 'lock-release']);
  });

  it('validates intended receipt schema and payload before opening a transaction', async () => {
    const events: string[] = [];
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const invalidPayload = serializeReceipt(TX, { source: 'untrusted' });
    await expect(runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter: operationAdapter({
        operation: 'install',
        resource,
        applied: 'new',
        receiptBytes: invalidPayload,
        events,
      }),
      transactionId: TX,
      validateReceiptPayload(value) {
        if (
          typeof value !== 'object'
          || value === null
          || !('source' in value)
          || (value as { source?: unknown }).source !== 'trusted'
        ) throw new InstallerValidationError('intended receipt payload is invalid');
        return value;
      },
    })).rejects.toThrow('intended receipt payload is invalid');
    expect(events).toEqual(['preflight']);
    expect(resource.text()).toBe('old');
    expect(await loadStrictJournal(paths)).toBeUndefined();
    await expect(fs.lstat(paths.transactions)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a malformed intended receipt envelope before opening a transaction', async () => {
    const events: string[] = [];
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    await expect(runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter: operationAdapter({
        operation: 'install',
        resource,
        applied: 'new',
        receiptBytes: encoder.encode('{}\n'),
        events,
      }),
      transactionId: TX,
    })).rejects.toThrow('intended receipt has an invalid schema');
    expect(events).toEqual(['preflight']);
    expect(resource.text()).toBe('old');
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('uses the exact install order and commits only after all validation', async () => {
    const events: string[] = [];
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const receipt = serializeReceipt(TX, { source: 'test' });
    const result = await runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter: operationAdapter({ operation: 'install', resource, applied: 'new', receiptBytes: receipt, events }),
      transactionId: TX,
    });
    expect(result).toBe('changed');
    expect(events).toEqual([
      'preflight', 'materialize', 'switch', 'start', 'health', 'codex', 'grok', 'validate', 'cleanup',
    ]);
    expect(resource.text()).toBe('new');
    expect(await fs.readFile(paths.receipt)).toEqual(Buffer.from(receipt));
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('uses the exact uninstall order and keeps service removal after client validation', async () => {
    const events: string[] = [];
    const installedReceipt = serializeReceipt(TX, { source: 'installed' });
    await seedReceipt(installedReceipt);
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'installed');
    await runInstallerOperation({
      paths,
      operation: 'uninstall',
      lock: lockDependencies(),
      adapter: operationAdapter({ operation: 'uninstall', resource, applied: 'original', receiptBytes: null, events }),
      transactionId: 'abcdef1234567890abcdef1234567890',
    });
    expect(events).toEqual(['preflight', 'restore-codex', 'restore-grok', 'validate', 'stop', 'cleanup']);
    expect(resource.text()).toBe('original');
    expect(await readReceiptIdentity(paths.receipt)).toEqual({ kind: 'absent' });
  });

  it('rolls back an ordinary handled failure and a SIG-like failure', async () => {
    for (const failAt of ['grok', 'validate']) {
      const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pxpipe-installer-failure-'));
      try {
        const localPaths = resolveMacosInstallerPaths(path.join(localRoot, 'home'));
        await fs.mkdir(localPaths.home, { mode: 0o700 });
        const resource = new MemoryResource('codexConfig', path.join(localRoot, 'codex'), 'old');
        const receipt = serializeReceipt(TX, { source: 'test' });
        await expect(runInstallerOperation({
          paths: localPaths,
          operation: 'install',
          lock: lockDependencies(),
          adapter: operationAdapter({ operation: 'install', resource, applied: 'new', receiptBytes: receipt, failAt }),
          transactionId: TX,
        })).rejects.toThrow(failAt);
        expect(resource.text()).toBe('old');
        expect(await readReceiptIdentity(localPaths.receipt)).toEqual({ kind: 'absent' });
        expect(await loadStrictJournal(localPaths)).toBeUndefined();
        await expect(fs.lstat(localPaths.lock)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await fs.rm(localRoot, { recursive: true, force: true });
      }
    }
  });

  it('rolls back a handled failure after receipt rename but before its parent fsync', async () => {
    const events: string[] = [];
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const receipt = serializeReceipt(TX, { source: 'test' });
    await expect(runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter: operationAdapter({
        operation: 'install',
        resource,
        applied: 'new',
        receiptBytes: receipt,
        events,
      }),
      transactionId: TX,
      hooks: {
        checkpoint(name) {
          if (name === 'receipt:after-rename') throw new Error('receipt publication interrupted');
        },
      },
    })).rejects.toThrow('receipt publication interrupted');
    expect(events).not.toContain('cleanup');
    expect(resource.text()).toBe('old');
    expect(await readReceiptIdentity(paths.receipt)).toEqual({ kind: 'absent' });
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });

  it('recognizes an intended receipt hash after death at the commit boundary', async () => {
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const receipt = serializeReceipt(TX, { source: 'test' });
    await expect(runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter: operationAdapter({ operation: 'install', resource, applied: 'new', receiptBytes: receipt }),
      transactionId: TX,
      hooks: {
        checkpoint(name) {
          if (name === 'operation:after-receipt-commit') throw new InstallerCrashSimulation('death');
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect((await loadStrictJournal(paths))?.receiptCommitStarted).toBe(true);
    const cleanup: InstallerOperation[] = [];
    expect(await recoverPendingTransaction(
      paths,
      [resource],
      undefined,
      async (operation) => { cleanup.push(operation); },
    )).toBe('committed-finalized');
    expect(cleanup).toEqual(['install']);
    expect(resource.text()).toBe('new');
    expect(await fs.readFile(paths.receipt)).toEqual(Buffer.from(receipt));
  });

  it('recognizes intended receipt absence after a completed uninstall commit', async () => {
    const prior = serializeReceipt(TX, { source: 'installed' });
    await seedReceipt(prior);
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'installed');
    await expect(runInstallerOperation({
      paths,
      operation: 'uninstall',
      lock: lockDependencies(),
      adapter: operationAdapter({ operation: 'uninstall', resource, applied: 'original', receiptBytes: null }),
      transactionId: 'abcdef1234567890abcdef1234567890',
      hooks: {
        checkpoint(name) {
          if (name === 'operation:after-receipt-commit') throw new InstallerCrashSimulation('death');
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    expect(await readReceiptIdentity(paths.receipt)).toEqual({ kind: 'absent' });
    const cleanup: InstallerOperation[] = [];
    expect(await recoverPendingTransaction(
      paths,
      [resource],
      undefined,
      async (operation) => { cleanup.push(operation); },
    )).toBe('committed-finalized');
    expect(cleanup).toEqual(['uninstall']);
    expect(resource.text()).toBe('original');
  });

  it('retains a committed journal until replayed cleanup succeeds', async () => {
    const resource = new MemoryResource('codexConfig', path.join(root, 'codex'), 'old');
    const receipt = serializeReceipt(TX, { source: 'test' });
    await expect(runInstallerOperation({
      paths,
      operation: 'install',
      lock: lockDependencies(),
      adapter: operationAdapter({ operation: 'install', resource, applied: 'new', receiptBytes: receipt }),
      transactionId: TX,
      hooks: {
        checkpoint(name) {
          if (name === 'operation:after-receipt-commit') throw new InstallerCrashSimulation('death');
        },
      },
    })).rejects.toThrow(InstallerCrashSimulation);
    await expect(recoverPendingTransaction(
      paths,
      [resource],
      undefined,
      async () => { throw new Error('cleanup interrupted'); },
    )).rejects.toThrow('cleanup interrupted');
    expect(await loadStrictJournal(paths)).toBeDefined();
    let completed = 0;
    await expect(recoverPendingTransaction(
      paths,
      [resource],
      undefined,
      async () => { completed += 1; },
    )).resolves.toBe('committed-finalized');
    expect(completed).toBe(1);
    expect(await loadStrictJournal(paths)).toBeUndefined();
  });
});

describe('strict process and service probes', () => {
  it('treats only the exact launchctl missing-service result as already stopped', async () => {
    const domain = `gui/${UID}`;
    const label = `${domain}/com.pxpipe.proxy`;
    const missing = [
      'Bad request.',
      `Could not find service "com.pxpipe.proxy" in domain for user gui: ${UID}`,
      '',
    ].join('\n');
    const calls: string[] = [];
    const service = createMacosServiceOperations({
      paths,
      uid: UID,
      port: 47_821,
      runner: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        return commandResult(113, '', missing);
      },
    });
    await expect(service.stop()).resolves.toBeUndefined();
    expect(calls).toEqual([`launchctl print ${label}`]);
  });

  it('fails closed on launchctl permission, malformed, and bootout errors', async () => {
    const cases: Array<{ readonly print: CommandResult; readonly bootout?: CommandResult; readonly message: string }> = [
      { print: commandResult(1, '', 'Operation not permitted\n'), message: 'launchctl print failed' },
      { print: commandResult(0), message: 'malformed service state' },
      {
        print: commandResult(0, 'service state\n'),
        bootout: commandResult(5, '', 'Input/output error\n'),
        message: 'launchctl failed',
      },
    ];
    for (const failure of cases) {
      const service = createMacosServiceOperations({
        paths,
        uid: UID,
        port: 47_821,
        runner: async (_command, args) => args[0] === 'print' ? failure.print : failure.bootout!,
      });
      await expect(service.stop()).rejects.toThrow(failure.message);
    }
  });

  it('accepts only lsof no-match as a free port and rejects operational or malformed results', async () => {
    let freeProbeArgs: readonly string[] = [];
    await expect(createMacosServiceOperations({
      paths,
      uid: UID,
      port: 47_821,
      runner: async (command, args) => {
        expect(command).toBe('lsof');
        freeProbeArgs = [...args];
        return commandResult(1);
      },
    }).waitForPortFree()).resolves.toBeUndefined();
    expect(freeProbeArgs).toContain('-w');

    for (const failure of [
      commandResult(1, '', 'unexpected warning\n'),
      commandResult(2, '', 'permission denied\n'),
      commandResult(0),
      commandResult(0, 'not-a-pid\n'),
    ]) {
      await expect(createMacosServiceOperations({
        paths,
        uid: UID,
        port: 47_821,
        runner: async () => failure,
      }).waitForPortFree()).rejects.toThrow(InstallerValidationError);
    }
  });

  it('fails closed unless ps proves absence or returns one complete identity', async () => {
    const identity = processIdentity(9001, 'Sat Jul 11 03:00:00 2026');
    await expect(createProcessLivenessCheck(async () => commandResult(1))(identity)).resolves.toBe(false);
    await expect(createProcessLivenessCheck(async () => commandResult(
      0,
      `${identity.uid} ${identity.startSignature}\n`,
    ))(identity)).resolves.toBe(true);
    await expect(createProcessLivenessCheck(async () => commandResult(
      0,
      `${identity.uid} Sat Jul 11 04:00:00 2026\n`,
    ))(identity)).resolves.toBe(false);
    await expect(createProcessLivenessCheck(async () => commandResult(
      1,
      '',
      'Operation not permitted\n',
    ))(identity)).rejects.toThrow('ps failed');
    await expect(createProcessLivenessCheck(async () => commandResult(0))(identity)).rejects.toThrow(
      'malformed process identity',
    );
  });
});

describe('bundle and plist boundaries', () => {
  it('revalidates the strict six-field bundle from the helper path', async () => {
    const bundle = path.join(root, 'bundle');
    await fs.mkdir(bundle);
    const helper = path.join(bundle, INSTALLER_PROGRAM_NAME);
    const helperBytes = randomBytes(19);
    const archiveBytes = randomBytes(23);
    const sourceCommit = 'a'.repeat(40);
    const version = '0.8.0-provenance-safe.1';
    const archive = `pxpipe-proxy-${version}-${sourceCommit}.tgz`;
    await fs.writeFile(helper, helperBytes);
    await fs.writeFile(path.join(bundle, archive), archiveBytes);
    await fs.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      version,
      sourceCommit,
      archive,
      sha256: sha256(archiveBytes),
      installer: INSTALLER_PROGRAM_NAME,
      installerSha256: sha256(helperBytes),
    }));
    await expect(validateInstallerBundle(helper)).resolves.toMatchObject({
      bundleDirectory: bundle,
      archivePath: path.join(bundle, archive),
    });
    await fs.appendFile(helper, 'tamper');
    await expect(validateInstallerBundle(helper)).rejects.toThrow('installer checksum mismatch');
  });

  it('extracts only the verified archive bytes after the source path is replaced', async () => {
    const bundle = path.join(root, 'bundle-race');
    await fs.mkdir(bundle);
    const helper = path.join(bundle, INSTALLER_PROGRAM_NAME);
    const helperBytes = randomBytes(19);
    const archiveBytes = randomBytes(23);
    const sourceCommit = 'c'.repeat(40);
    const version = '0.8.0-provenance-safe.1';
    const archive = `pxpipe-proxy-${version}-${sourceCommit}.tgz`;
    const archivePath = path.join(bundle, archive);
    await fs.writeFile(helper, helperBytes);
    await fs.writeFile(archivePath, archiveBytes);
    await fs.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      version,
      sourceCommit,
      archive,
      sha256: sha256(archiveBytes),
      installer: INSTALLER_PROGRAM_NAME,
      installerSha256: sha256(helperBytes),
    }));
    const verified = await validateInstallerBundle(helper);
    await fs.writeFile(archivePath, randomBytes(23));
    const stagedPaths: string[] = [];
    const destination = path.join(root, 'extract-race');
    const entries = [
      'package/',
      'package/package.json',
      'package/bin/',
      'package/bin/cli.js',
      'package/dist/',
      'package/dist/node.js',
      'package/dist/macos-local-installer.js',
    ];
    await extractVerifiedPackage(verified, destination, async (command, args) => {
      if (command === 'tar') {
        const staged = args[1]!;
        stagedPaths.push(staged);
        expect(staged).not.toBe(archivePath);
        expect(await fs.readFile(staged)).toEqual(Buffer.from(archiveBytes));
        if (args[0] === '-tzf') return commandResult(0, `${entries.join('\n')}\n`);
        if (args[0] === '-tvzf') {
          return commandResult(0, `${entries.map((entry) => `${entry.endsWith('/') ? 'd' : '-'} fixture ${entry}`).join('\n')}\n`);
        }
        const target = args[args.indexOf('-C') + 1]!;
        await fs.mkdir(path.join(target, 'package', 'bin'), { recursive: true });
        await fs.mkdir(path.join(target, 'package', 'dist'), { recursive: true });
        await fs.writeFile(path.join(target, 'package', 'package.json'), JSON.stringify({ version }));
        await fs.writeFile(path.join(target, 'package', 'bin', 'cli.js'), 'cli');
        await fs.writeFile(path.join(target, 'package', 'dist', 'node.js'), 'node');
        await fs.writeFile(path.join(target, 'package', 'dist', 'macos-local-installer.js'), helperBytes);
        return commandResult(0);
      }
      if (command === process.execPath) return commandResult(0, `${version}\n`);
      return commandResult(127, '', 'unexpected command');
    });
    expect(stagedPaths).toHaveLength(3);
    expect(new Set(stagedPaths).size).toBe(1);
  });

  it('rejects a packaged installer whose bytes differ from the running verified helper', async () => {
    const bundle = path.join(root, 'bundle-installer-mismatch');
    await fs.mkdir(bundle);
    const helper = path.join(bundle, INSTALLER_PROGRAM_NAME);
    const helperBytes = randomBytes(19);
    const archiveBytes = randomBytes(23);
    const sourceCommit = 'd'.repeat(40);
    const version = '0.8.0-provenance-safe.1';
    const archive = `pxpipe-proxy-${version}-${sourceCommit}.tgz`;
    await fs.writeFile(helper, helperBytes);
    await fs.writeFile(path.join(bundle, archive), archiveBytes);
    await fs.writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({
      version,
      sourceCommit,
      archive,
      sha256: sha256(archiveBytes),
      installer: INSTALLER_PROGRAM_NAME,
      installerSha256: sha256(helperBytes),
    }));
    const verified = await validateInstallerBundle(helper);
    const entries = [
      'package/',
      'package/package.json',
      'package/bin/',
      'package/bin/cli.js',
      'package/dist/',
      'package/dist/node.js',
      'package/dist/macos-local-installer.js',
    ];
    let packagedCommandRan = false;
    await expect(extractVerifiedPackage(
      verified,
      path.join(root, 'extract-installer-mismatch'),
      async (command, args) => {
        if (command === 'tar') {
          if (args[0] === '-tzf') return commandResult(0, `${entries.join('\n')}\n`);
          if (args[0] === '-tvzf') {
            return commandResult(0, `${entries.map((entry) => `${entry.endsWith('/') ? 'd' : '-'} fixture ${entry}`).join('\n')}\n`);
          }
          const target = args[args.indexOf('-C') + 1]!;
          await fs.mkdir(path.join(target, 'package', 'bin'), { recursive: true });
          await fs.mkdir(path.join(target, 'package', 'dist'), { recursive: true });
          await fs.writeFile(path.join(target, 'package', 'package.json'), JSON.stringify({ version }));
          await fs.writeFile(path.join(target, 'package', 'bin', 'cli.js'), 'cli');
          await fs.writeFile(path.join(target, 'package', 'dist', 'node.js'), 'node');
          await fs.writeFile(path.join(target, 'package', 'dist', 'macos-local-installer.js'), 'different');
          return commandResult(0);
        }
        if (command === process.execPath) packagedCommandRan = true;
        return commandResult(127, '', 'unexpected command');
      },
    )).rejects.toThrow('packaged installer checksum does not match the running installer');
    expect(packagedCommandRan).toBe(false);
  });

  it('generates only the five approved environment values', () => {
    const plist = new TextDecoder().decode(buildLaunchAgentPlist('/release/bin/pxpipe', 47_821));
    expect(plist).toContain('<key>HOST</key>');
    expect(plist).toContain('<string>127.0.0.1</string>');
    expect(plist).toContain('<key>PORT</key>');
    expect(plist).toContain(`<string>${INSTALLED_MODELS}</string>`);
    expect(plist).toContain(`<string>${CODEX_SUBSCRIPTION_UPSTREAM}</string>`);
    expect(plist).toContain(`<string>${GROK_SUBSCRIPTION_UPSTREAM}</string>`);
    expect(plist).not.toMatch(/API_KEY|GATEWAY|PROVIDER/u);
    expect((plist.match(/<key>(?:HOST|PORT|PXPIPE_[A-Z_]+)<\/key>/gu) ?? [])).toHaveLength(5);
  });

  it('compares complete resource identities, not hashes alone', () => {
    expect(sameResourceIdentity(present('x', 0o600), present('x', 0o644))).toBe(false);
    expect(sameResourceIdentity({ exists: false }, { exists: false })).toBe(true);
  });
});
