#!/usr/bin/env node
// Redacted matrix collector for the provenance-safe live A/B (plan §7.2).
//
//   node eval/provenance-ab/collect.mjs eval/provenance-ab/runs/<dir> [...]
//
// Emits one row per run dir into matrix.jsonl (next to this script) and
// prints a SUMMARY.md table. Rows carry ONLY: variant/config identifiers,
// requested/served models, stop reasons, safety flags, dispositions, refs,
// hashes, and aggregate token counts. Raw prompts, transcripts, rendered
// PNGs, and repository text never enter a row — commit matrix.jsonl and
// SUMMARY.md, never the run dirs themselves.

import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node eval/provenance-ab/collect.mjs <run-dir> [...]');
  process.exit(1);
}

const loadJsonl = (p) =>
  fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch { return []; }
      })
    : [];

function collectRun(dir) {
  const name = path.basename(dir.replace(/\/+$/, ''));
  // <stamp>-<VARIANT>-<workspace>-r<N>
  const m = name.match(/^\d{8}-\d{6}-(.+)-([^-]+)-r(\d+)$/);
  const events = loadJsonl(path.join(dir, 'events.jsonl')).filter(
    (r) => (r.path ?? '').includes('/v1/messages') && !(r.path ?? '').includes('count_tokens'),
  );

  const servedModels = new Set();
  let taskOutcome = 'unknown';
  const turnsDir = path.join(dir, 'turns');
  if (fs.existsSync(turnsDir)) {
    for (const f of fs.readdirSync(turnsDir).filter((f) => f.endsWith('.json'))) {
      try {
        const turn = JSON.parse(fs.readFileSync(path.join(turnsDir, f), 'utf8'));
        for (const model of Object.keys(turn.modelUsage ?? {})) servedModels.add(model);
        if (typeof turn.is_error === 'boolean') taskOutcome = turn.is_error ? 'errored' : 'completed';
      } catch { /* absent/partial turn file → leave unknown */ }
    }
  }

  const sum = (k) => events.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const uniq = (k) => [...new Set(events.map((r) => r[k]).filter((v) => v !== undefined))];
  const requestedModels = uniq('model');
  const stopReasons = uniq('stop_reason');
  const safetyFlagged = events.some((r) => r.safety_flagged === true);
  // Fallback = a served model whose base matches no requested model.
  const base = (model) => String(model).replace(/-\d{8}$/, '');
  const requestedBases = new Set(requestedModels.map(base));
  const modelSwitch = [...servedModels].some((model) => !requestedBases.has(base(model)));

  return {
    run: name,
    variant: m?.[1] ?? 'unknown',
    workspace: m?.[2] ?? 'unknown',
    replicate: m ? Number(m[3]) : undefined,
    requests: events.length,
    requested_models: requestedModels,
    served_models: [...servedModels],
    unexpected_model_switch: modelSwitch,
    stop_reasons: stopReasons,
    safety_flagged: safetyFlagged,
    task_outcome: taskOutcome,
    context_modes: uniq('context_mode'),
    project_dispositions: uniq('project_disposition'),
    project_refs: uniq('project_ref'),
    project_image_count: sum('project_image_count'),
    tool_modes: uniq('tool_mode'),
    tool_refs: uniq('tool_ref'),
    tool_image_count: sum('tool_image_count'),
    runtime_dispositions: uniq('runtime_metadata_disposition'),
    cache_prefix_sha8s: uniq('cache_prefix_sha8'),
    cache_boundary_kinds: uniq('cache_boundary_kind'),
    compressed_requests: events.filter((r) => r.compressed === true).length,
    input_tokens: sum('input_tokens'),
    cache_create_tokens: sum('cache_create_tokens'),
    cache_read_tokens: sum('cache_read_tokens'),
    output_tokens: sum('output_tokens'),
  };
}

const rows = dirs.map(collectRun);
const outPath = new URL('./matrix.jsonl', import.meta.url).pathname;
fs.appendFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`appended ${rows.length} row(s) → ${outPath}\n`);

console.log('| run | variant | reqs | safety | switch | outcome | proj imgs | tool imgs | in | cc | cr | out |');
console.log('|---|---|---:|---|---|---|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  console.log(
    `| ${r.run} | ${r.variant} | ${r.requests} | ${r.safety_flagged ? 'FLAGGED' : 'clean'} ` +
      `| ${r.unexpected_model_switch ? 'SWITCHED' : 'no'} | ${r.task_outcome} ` +
      `| ${r.project_image_count} | ${r.tool_image_count} ` +
      `| ${r.input_tokens} | ${r.cache_create_tokens} | ${r.cache_read_tokens} | ${r.output_tokens} |`,
  );
}
