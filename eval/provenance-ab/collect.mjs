#!/usr/bin/env node
// Redacted matrix collector for the provenance-safe live A/B (plan §7.2).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitCompletedEvents } from './run-evidence.mjs';

const loadJsonl = (file) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      })
    : [];

const assessmentEnums = {
  project_guidance_legitimate: new Set(['yes', 'no', 'unclear', 'not_applicable']),
  live_request_distinguishable: new Set(['yes', 'no', 'unclear']),
  injection_loop: new Set(['none', 'suspected', 'sustained']),
  task_outcome: new Set(['completed', 'errored', 'blocked', 'unclear']),
};

function loadMetadata(dir) {
  const file = path.join(dir, 'metadata.json');
  if (!fs.existsSync(file)) throw new Error(`${dir}: metadata.json is required`);
  let metadata;
  try {
    metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${dir}: metadata.json is not valid JSON`);
  }
  if (metadata?.schema_version !== 1) throw new Error(`${dir}: unsupported metadata schema`);
  for (const field of ['variant', 'workspace', 'requested_model', 'source_commit']) {
    if (typeof metadata[field] !== 'string' || metadata[field].length === 0) {
      throw new Error(`${dir}: metadata.${field} is required`);
    }
  }
  if (!Number.isInteger(metadata.replicate) || metadata.replicate < 1) {
    throw new Error(`${dir}: metadata.replicate must be a positive integer`);
  }
  for (const field of ['source_dirty', 'source_untracked']) {
    if (typeof metadata[field] !== 'boolean') {
      throw new Error(`${dir}: metadata.${field} must be boolean`);
    }
  }
  if (!/^[0-9a-f]{64}$/.test(metadata.source_build_sha256 ?? '')) {
    throw new Error(`${dir}: metadata.source_build_sha256 must be a SHA-256 digest`);
  }
  if (
    metadata.source_patch_sha256 !== null &&
    !/^[0-9a-f]{64}$/.test(metadata.source_patch_sha256 ?? '')
  ) {
    throw new Error(`${dir}: metadata.source_patch_sha256 must be null or a SHA-256 digest`);
  }
  if (metadata.source_untracked) {
    throw new Error(`${dir}: untracked source cannot produce complete run evidence`);
  }
  if (metadata.source_dirty !== (metadata.source_patch_sha256 !== null)) {
    throw new Error(`${dir}: source dirty state and patch identity disagree`);
  }
  for (const [field, allowed] of Object.entries(assessmentEnums)) {
    const value = metadata.assessment?.[field];
    if (!allowed.has(value)) {
      throw new Error(`${dir}: metadata.assessment.${field} requires an operator judgment`);
    }
  }
  return metadata;
}

export function collectRun(dir) {
  const name = path.basename(dir.replace(/\/+$/, ''));
  const metadata = loadMetadata(dir);
  const loadedEvents = loadJsonl(path.join(dir, 'events.jsonl'));
  const { events: completedEvents } = splitCompletedEvents(
    loadedEvents,
    `${dir}/events.jsonl`,
  );
  const events = completedEvents.filter(
    (row) => (row.path ?? '').includes('/v1/messages') && !(row.path ?? '').includes('count_tokens'),
  );

  const servedModels = new Set();
  const turnsDir = path.join(dir, 'turns');
  if (fs.existsSync(turnsDir)) {
    for (const file of fs.readdirSync(turnsDir).filter((entry) => entry.endsWith('.json'))) {
      try {
        const turn = JSON.parse(fs.readFileSync(path.join(turnsDir, file), 'utf8'));
        for (const model of Object.keys(turn.modelUsage ?? {})) servedModels.add(model);
      } catch { /* partial turn: early-stop/assessment records the outcome */ }
    }
  }

  const sum = (key) => events.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const uniq = (key) => [...new Set(events.map((row) => row[key]).filter((value) => value !== undefined))];
  const requestedModels = uniq('model');
  const stopReasons = uniq('stop_reason');
  const safetyFlagged = events.some((row) => row.safety_flagged === true);
  const modelBase = (model) => String(model).replace(/-\d{8}$/, '');
  const requestedBase = modelBase(metadata.requested_model);
  if (events.length === 0 || requestedModels.length === 0) {
    throw new Error(`${dir}: at least one message event with a requested model is required`);
  }
  if (requestedModels.some((model) => modelBase(model) !== requestedBase)) {
    throw new Error(`${dir}: event requested model does not match metadata.requested_model`);
  }
  if (servedModels.size === 0) {
    throw new Error(`${dir}: a served model is required for complete run evidence`);
  }
  const fallbackOccurred = [...servedModels].some(
    (model) => modelBase(model) !== requestedBase,
  );

  return {
    run: name,
    variant: metadata.variant,
    workspace: metadata.workspace,
    replicate: metadata.replicate,
    source_commit: metadata.source_commit,
    source_dirty: metadata.source_dirty === true,
    source_patch_sha256: metadata.source_patch_sha256 ?? null,
    source_untracked: metadata.source_untracked === true,
    source_build_sha256: metadata.source_build_sha256,
    requested_model: metadata.requested_model,
    requests: events.length,
    requested_models: requestedModels,
    served_models: [...servedModels],
    unexpected_model_switch: fallbackOccurred === true,
    fallback_occurred: fallbackOccurred,
    stop_reasons: stopReasons,
    safety_flagged: safetyFlagged,
    task_outcome: metadata.assessment.task_outcome,
    project_guidance_legitimate: metadata.assessment.project_guidance_legitimate,
    live_request_distinguishable: metadata.assessment.live_request_distinguishable,
    injection_loop: metadata.assessment.injection_loop,
    context_modes: uniq('context_mode'),
    project_dispositions: uniq('project_disposition'),
    project_refs: uniq('project_ref'),
    project_image_count: sum('project_image_count'),
    tool_modes: uniq('tool_mode'),
    tool_dispositions: uniq('tool_disposition'),
    tool_refs: uniq('tool_ref'),
    tool_image_count: sum('tool_image_count'),
    runtime_dispositions: uniq('runtime_metadata_disposition'),
    cache_prefix_sha8s: uniq('cache_prefix_sha8'),
    cache_boundary_kinds: uniq('cache_boundary_kind'),
    compressed_requests: events.filter((row) => row.compressed === true).length,
    input_tokens: sum('input_tokens'),
    cache_create_tokens: sum('cache_create_tokens'),
    cache_read_tokens: sum('cache_read_tokens'),
    output_tokens: sum('output_tokens'),
  };
}

function main(args) {
  if (args.length === 0) {
    console.error('usage: node eval/provenance-ab/collect.mjs <run-dir> [...]');
    return 1;
  }
  let rows;
  try {
    rows = args.map(collectRun);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const outPath = fileURLToPath(new URL('./matrix.jsonl', import.meta.url));
  fs.appendFileSync(outPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  console.log(`appended ${rows.length} row(s) → ${outPath}\n`);
  console.log('| run | variant | reqs | safety | switch | outcome | proj imgs | tool imgs | in | cc | cr | out |');
  console.log('|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|');
  for (const row of rows) {
    console.log(
      `| ${row.run} | ${row.variant} | ${row.requests} | ${row.safety_flagged ? 'FLAGGED' : 'clean'} ` +
        `| ${row.fallback_occurred ? 'SWITCHED' : 'no'} | ${row.task_outcome} ` +
        `| ${row.project_image_count} | ${row.tool_image_count} ` +
        `| ${row.input_tokens} | ${row.cache_create_tokens} | ${row.cache_read_tokens} | ${row.output_tokens} |`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
