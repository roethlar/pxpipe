import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectRun } from '../eval/provenance-ab/collect.mjs';
import { buildRunMetadata } from '../eval/provenance-ab/run-metadata.mjs';

const roots: string[] = [];
const completeAssessment = {
  project_guidance_legitimate: 'yes',
  live_request_distinguishable: 'yes',
  injection_loop: 'none',
  task_outcome: 'completed',
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRun(assessment: Record<string, string | null>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-'));
  roots.push(root);
  const dir = path.join(root, '20260710-120000-PROJECT_RUNTIME-empty-r1');
  fs.mkdirSync(path.join(dir, 'turns'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
    path: '/v1/messages',
    model: 'claude-fable-5',
    tool_disposition: 'native_default',
    input_tokens: 10,
  }) + '\n');
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

  it('refuses a run with no served-model evidence', () => {
    const dir = makeRun(completeAssessment);
    fs.rmSync(path.join(dir, 'turns', 'turn-1.json'));

    expect(() => collectRun(dir)).toThrow(/served model is required/);
  });

  it('refuses a run with no requested-model event', () => {
    const dir = makeRun(completeAssessment);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');

    expect(() => collectRun(dir)).toThrow(/message event with a requested model is required/);
  });

  it('refuses disagreement between recorded and observed requested models', () => {
    const dir = makeRun(completeAssessment);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({
      path: '/v1/messages',
      model: 'claude-sonnet-5',
    }) + '\n');

    expect(() => collectRun(dir)).toThrow(/does not match metadata.requested_model/);
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

  it('builds the selected patched source and allows only its PROJECT label', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-runner-'));
    roots.push(root);
    const fakeBin = path.join(root, 'bin');
    const sourceDir = path.join(root, 'patched-source');
    const marker = path.join(root, 'built-from.txt');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(sourceDir);
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
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      PXPIPE_TEST_BUILD_MARKER: marker,
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
  });
});
