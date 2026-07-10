#!/usr/bin/env node
// Writes redacted source identity and an empty operator-assessment form.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

function buildTreeSha256(distDir) {
  const files = [];
  const visit = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), relative);
      else files.push(relative);
    }
  };
  visit(distDir);
  if (files.length === 0) throw new Error(`${distDir}: built output is empty`);
  const hash = createHash('sha256');
  for (const relative of files.sort()) {
    hash.update(relative).update('\0');
    hash.update(fs.readFileSync(path.join(distDir, ...relative.split('/')))).update('\0');
  }
  return hash.digest('hex');
}

export function buildSourceReceipt(sourceDir) {
  const sourceCommit = git(sourceDir, ['rev-parse', 'HEAD']).trim();
  const status = git(sourceDir, ['status', '--porcelain']);
  const patch = git(sourceDir, ['diff', '--binary', 'HEAD']);
  const untracked = git(sourceDir, ['ls-files', '--others', '--exclude-standard']).trim().length > 0;
  if (untracked) {
    throw new Error(`${sourceDir}: untracked source files make the run identity incomplete`);
  }
  const distDir = path.join(sourceDir, 'dist');
  if (!fs.existsSync(distDir)) {
    throw new Error(`${sourceDir}: built output is required; build the source worktree first`);
  }
  return {
    source_commit: sourceCommit,
    source_dirty: status.length > 0,
    source_patch_sha256: patch.length > 0
      ? createHash('sha256').update(patch).digest('hex')
      : null,
    source_untracked: untracked,
    source_build_sha256: buildTreeSha256(distDir),
  };
}

export function buildRunMetadata({ variant, workspace, replicate, requestedModel, sourceDir }) {
  return {
    schema_version: 1,
    variant,
    workspace,
    replicate,
    requested_model: requestedModel,
    ...buildSourceReceipt(sourceDir),
    assessment: {
      project_guidance_legitimate: null,
      live_request_distinguishable: null,
      injection_loop: null,
      task_outcome: null,
    },
  };
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const validateSource = option(args, 'validate-source');
  if (validateSource) {
    try {
      buildSourceReceipt(validateSource);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    process.exit(0);
  }
  const output = option(args, 'output');
  const variant = option(args, 'variant');
  const workspace = option(args, 'workspace');
  const requestedModel = option(args, 'requested-model');
  const sourceDir = option(args, 'source-dir');
  const replicate = Number(option(args, 'replicate'));
  if (!output || !variant || !workspace || !requestedModel || !sourceDir || !Number.isInteger(replicate)) {
    console.error('usage: run-metadata.mjs --output <file> --variant <name> --workspace <name> --replicate <n> --requested-model <id> --source-dir <dir>');
    process.exit(2);
  }
  fs.writeFileSync(
    output,
    JSON.stringify(buildRunMetadata({ variant, workspace, replicate, requestedModel, sourceDir }), null, 2) + '\n',
  );
}
