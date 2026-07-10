import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectRun } from '../eval/provenance-ab/collect.mjs';
import { evaluateStop } from '../eval/provenance-ab/check-stop.mjs';
import { buildRunMetadata } from '../eval/provenance-ab/run-metadata.mjs';

const roots: string[] = [];
const completeAssessment = {
  project_guidance_legitimate: 'yes',
  live_request_distinguishable: 'yes',
  injection_loop: 'none',
  task_outcome: 'completed',
};

function drainedJsonl(events: Array<Record<string, unknown>>) {
  return [...events, {
    pxpipe_eval_record: 'pxpipe_eval_drain_v1',
    accepted_requests: events.length,
    completed_events: events.length,
  }].map((row) => JSON.stringify(row)).join('\n') + '\n';
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('free port unavailable');
  return address.port;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRun(assessment: Record<string, string | null>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-'));
  roots.push(root);
  const dir = path.join(root, '20260710-120000-PROJECT_RUNTIME-empty-r1');
  fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), drainedJsonl([{
    path: '/v1/messages',
    model: 'claude-fable-5',
    tool_disposition: 'native_default',
    input_tokens: 10,
  }]));
  fs.writeFileSync(path.join(dir, 'turns', 'turn-1.json'), JSON.stringify({
    is_error: false,
    modelUsage: { 'claude-opus-4-8-20260701': {} },
  }));
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    schema_version: 1,
    variant: 'PROJECT_RUNTIME',
    workspace: 'empty',
    replicate: 1,
    requested_model: 'claude-fable-5',
    source_commit: 'abc1234',
    source_dirty: true,
    source_patch_sha256: 'd'.repeat(64),
    source_untracked: false,
    source_build_sha256: 'b'.repeat(64),
    assessment,
  }));
  return dir;
}

describe('provenance A/B collector evidence', () => {
  it('uses operator outcome judgments and records source/tool/fallback evidence', () => {
    const row = collectRun(makeRun({
      project_guidance_legitimate: 'no',
      live_request_distinguishable: 'no',
      injection_loop: 'sustained',
      task_outcome: 'blocked',
    }));

    expect(row.task_outcome).toBe('blocked');
    expect(row.injection_loop).toBe('sustained');
    expect(row.source_commit).toBe('abc1234');
    expect(row.source_patch_sha256).toBe('d'.repeat(64));
    expect(row.source_build_sha256).toBe('b'.repeat(64));
    expect(row.tool_dispositions).toEqual(['native_default']);
    expect(row.fallback_occurred).toBe(true);
  });

  it('refuses collection until every operator judgment is recorded', () => {
    expect(() => collectRun(makeRun({
      project_guidance_legitimate: null,
      live_request_distinguishable: null,
      injection_loop: null,
      task_outcome: null,
    }))).toThrow(/requires an operator judgment/);
  });

  it('refuses collection before the terminal drain record is written', () => {
    const dir = makeRun(completeAssessment);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
      path: '/v1/messages',
      model: 'claude-fable-5',
    }) + '\n');

    expect(() => collectRun(dir)).toThrow(/terminal drain record is required/);
  });

  it('refuses a malformed terminal event instead of dropping it', () => {
    const dir = makeRun(completeAssessment);
    fs.writeFileSync(
      path.join(dir, 'events.jsonl'),
      '{"path":"/v1/messages","model":"claude-fable-5"}\n' +
        '{"stop_reason":\n' +
        '{"pxpipe_eval_record":"pxpipe_eval_drain_v1",' +
        '"accepted_requests":2,"completed_events":2}\n',
    );

    expect(() => collectRun(dir)).toThrow(/invalid JSON on line 2/);
  });

  it('drains a delayed refusal event before the evaluation host can stop', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-drain-'));
    roots.push(root);
    const sourceDir = path.join(root, 'source');
    const coreDir = path.join(sourceDir, 'dist', 'core');
    const logPath = path.join(root, 'events.jsonl');
    fs.mkdirSync(coreDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({ type: 'module' }));
    fs.writeFileSync(path.join(coreDir, 'proxy.js'), [
      'export function createProxy(config) {',
      '  return async () => {',
      '    setTimeout(() => config.onRequest?.({',
      '      path: "/v1/messages",',
      '      model: "claude-fable-5",',
      '      stop_reason: "refusal",',
      '      safety_flagged: true,',
      '    }), 75);',
      '    return new Response("ok", { status: 200 });',
      '  };',
      '}',
      '',
    ].join('\n'));
    fs.writeFileSync(
      path.join(coreDir, 'tracker.js'),
      'export const toTrackEvent = (event) => event;\n',
    );
    const port = await freePort();
    const child = spawn(process.execPath, [
      path.join(process.cwd(), 'eval', 'provenance-ab', 'variant-proxy.mjs'),
      '--variant', 'LEGACY',
      '--source-dir', sourceDir,
      '--port', String(port),
      '--log', logPath,
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`proxy start timed out: ${output}`)), 5_000);
        child.stdout?.on('data', (chunk) => {
          output += String(chunk);
          if (output.includes('listening on')) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.stderr?.on('data', (chunk) => { output += String(chunk); });
        child.once('exit', (code) => reject(new Error(`proxy exited early (${code}): ${output}`)));
      });

      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(response.status).toBe(200);
      const drain = await fetch(`http://127.0.0.1:${port}/__pxpipe_eval/drain`, {
        method: 'POST',
      });
      expect(drain.status).toBe(200);

      const rows = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
      expect(rows.map((row) => row.stop_reason ?? row.pxpipe_eval_record)).toEqual([
        'refusal',
        'pxpipe_eval_drain_v1',
      ]);
      expect(evaluateStop({
        requestedModel: 'claude-fable-5',
        turn: { modelUsage: { 'claude-fable-5-20260701': {} } },
        events: rows,
      }).reason).toBe('safety_or_refusal');
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });

  it('refuses a run with no served-model evidence', () => {
    const dir = makeRun(completeAssessment);
    fs.rmSync(path.join(dir, 'turns', 'turn-1.json'));

    expect(() => collectRun(dir)).toThrow(/served model is required/);
  });

  it('refuses a run with no requested-model event', () => {
    const dir = makeRun(completeAssessment);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), drainedJsonl([{ path: '/health' }]));

    expect(() => collectRun(dir)).toThrow(/message event with a requested model is required/);
  });

  it('refuses disagreement between recorded and observed requested models', () => {
    const dir = makeRun(completeAssessment);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), drainedJsonl([{
      path: '/v1/messages',
      model: 'claude-sonnet-5',
    }]));

    expect(() => collectRun(dir)).toThrow(/does not match metadata.requested_model/);
  });

  it('does not collapse distinct dated model requests in event evidence', () => {
    const dir = makeRun(completeAssessment);
    const metadataPath = path.join(dir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.requested_model = 'claude-fable-5-20260701';
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), drainedJsonl([{
      path: '/v1/messages',
      model: 'claude-fable-5-20260708',
    }]));

    expect(() => collectRun(dir)).toThrow(/does not match metadata.requested_model/);
  });

  it('records a different served date as a fallback from an exact request', () => {
    const dir = makeRun(completeAssessment);
    const metadataPath = path.join(dir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.requested_model = 'claude-fable-5-20260701';
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));
    fs.writeFileSync(path.join(dir, 'events.jsonl'), drainedJsonl([{
      path: '/v1/messages',
      model: 'claude-fable-5-20260701',
    }]));
    fs.writeFileSync(path.join(dir, 'turns', 'turn-1.json'), JSON.stringify({
      modelUsage: { 'claude-fable-5-20260708': {} },
    }));

    const row = collectRun(dir);
    expect(row.fallback_occurred).toBe(true);
    expect(row.unexpected_model_switch).toBe(true);
  });

  it('preserves a hyphenated workspace label from run metadata', () => {
    const original = makeRun(completeAssessment);
    const dir = path.join(
      path.dirname(original),
      '20260710-120000-PROJECT_RUNTIME-ai-rpg-engine-r1',
    );
    fs.renameSync(original, dir);
    const metadataPath = path.join(dir, 'metadata.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    metadata.workspace = 'ai-rpg-engine';
    fs.writeFileSync(metadataPath, JSON.stringify(metadata));

    const row = collectRun(dir);
    expect(row.variant).toBe('PROJECT_RUNTIME');
    expect(row.workspace).toBe('ai-rpg-engine');
    expect(row.replicate).toBe(1);
  });

  it('fingerprints the built proxy that a recorded source tree will execute', () => {
    const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-source-'));
    roots.push(sourceDir);
    fs.mkdirSync(path.join(sourceDir, 'dist', 'core'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'dist', 'node.js'), 'built proxy\n');
    fs.writeFileSync(path.join(sourceDir, 'dist', 'core', 'proxy.js'), 'built core\n');
    fs.writeFileSync(path.join(sourceDir, 'source.txt'), 'source\n');
    execFileSync('git', ['-C', sourceDir, 'init', '-q']);
    execFileSync('git', ['-C', sourceDir, 'add', '.']);
    execFileSync('git', [
      '-C', sourceDir,
      '-c', 'user.email=ab@pxpipe',
      '-c', 'user.name=ab',
      '-c', 'commit.gpgSign=false',
      'commit', '-qm', 'seed',
    ]);

    const metadata = buildRunMetadata({
      variant: 'PROJECT',
      workspace: 'empty',
      replicate: 1,
      requestedModel: 'claude-fable-5',
      sourceDir,
    });

    expect(metadata.source_dirty).toBe(false);
    expect(metadata.source_build_sha256).toBe(
      createHash('sha256')
        .update('core/proxy.js').update('\0')
        .update('built core\n').update('\0')
        .update('node.js').update('\0')
        .update('built proxy\n').update('\0')
        .digest('hex'),
    );

    fs.writeFileSync(path.join(sourceDir, 'dist', 'core', 'proxy.js'), 'different build\n');
    const changedBuild = buildRunMetadata({
      variant: 'PROJECT',
      workspace: 'empty',
      replicate: 1,
      requestedModel: 'claude-fable-5',
      sourceDir,
    });
    expect(changedBuild.source_build_sha256).not.toBe(metadata.source_build_sha256);

    fs.writeFileSync(path.join(sourceDir, 'untracked.txt'), 'unknown source\n');
    expect(() => buildRunMetadata({
      variant: 'PROJECT',
      workspace: 'empty',
      replicate: 1,
      requestedModel: 'claude-fable-5',
      sourceDir,
    })).toThrow(/untracked source files/);
  });

  it('validates the selected source before prepare-only can succeed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-runner-'));
    roots.push(root);
    const fakeBin = path.join(root, 'bin');
    const sourceDir = path.join(root, 'patched-source');
    const marker = path.join(root, 'built-from.txt');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, '.gitignore'), 'dist/\n');
    fs.writeFileSync(path.join(sourceDir, 'source.txt'), 'source\n');
    execFileSync('git', ['-C', sourceDir, 'init', '-q']);
    execFileSync('git', ['-C', sourceDir, 'add', '.']);
    execFileSync('git', [
      '-C', sourceDir,
      '-c', 'user.email=ab@pxpipe',
      '-c', 'user.name=ab',
      '-c', 'commit.gpgSign=false',
      'commit', '-qm', 'seed',
    ]);
    const fakeNpm = path.join(fakeBin, 'npm');
    fs.writeFileSync(fakeNpm, [
      '#!/usr/bin/env bash',
      'set -eu',
      'mkdir -p dist',
      "printf 'built proxy\\n' > dist/node.js",
      'pwd > "$PXPIPE_TEST_BUILD_MARKER"',
      '',
    ].join('\n'));
    fs.chmodSync(fakeNpm, 0o755);
    const modelMarker = path.join(root, 'model-called.txt');
    const fakeClaude = path.join(fakeBin, 'claude');
    fs.writeFileSync(fakeClaude, [
      '#!/usr/bin/env bash',
      'touch "$PXPIPE_TEST_MODEL_MARKER"',
      '',
    ].join('\n'));
    fs.chmodSync(fakeClaude, 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PXPIPE_TEST_BUILD_MARKER: marker,
      PXPIPE_TEST_MODEL_MARKER: modelMarker,
      CLAUDE_BIN: fakeClaude,
    };
    const runner = path.join(process.cwd(), 'eval', 'provenance-ab', 'run-variant.sh');

    const accepted = spawnSync('bash', [
      runner,
      '--variant', 'LEGACY',
      '--record-variant', 'PROJECT',
      '--legacy-dir', sourceDir,
      '--prepare-only',
    ], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(sourceDir);
    expect(fs.existsSync(modelMarker)).toBe(false);

    fs.writeFileSync(path.join(sourceDir, 'untracked.txt'), 'unknown source\n');
    const untracked = spawnSync('bash', [
      runner,
      '--variant', 'LEGACY',
      '--record-variant', 'PROJECT',
      '--legacy-dir', sourceDir,
      '--prepare-only',
    ], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(untracked.status).not.toBe(0);
    expect(untracked.stderr).toMatch(/untracked source files/);
    expect(fs.existsSync(modelMarker)).toBe(false);

    const nonGitSource = path.join(root, 'non-git-source');
    fs.mkdirSync(nonGitSource);
    const nonGit = spawnSync('bash', [
      runner,
      '--variant', 'LEGACY',
      '--record-variant', 'PROJECT',
      '--legacy-dir', nonGitSource,
      '--prepare-only',
    ], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(nonGit.status).not.toBe(0);
    expect(fs.existsSync(modelMarker)).toBe(false);

    fs.rmSync(marker);
    const rejected = spawnSync('bash', [
      runner,
      '--variant', 'OFF',
      '--record-variant', 'BOTH',
      '--prepare-only',
    ], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toMatch(/may only relabel a patched LEGACY run as PROJECT/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(modelMarker)).toBe(false);
  });
});
