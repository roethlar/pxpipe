import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateStop } from '../eval/provenance-ab/check-stop.mjs';
import {
  createDrainTracker,
  loadStrictJsonl,
} from '../eval/provenance-ab/run-evidence.mjs';

const cleanTurn = {
  result: 'Repository summary completed normally.',
  modelUsage: { 'claude-fable-5-20260701': {} },
};

const drained = (events: Array<Record<string, unknown>>) => [
  ...events,
  {
    pxpipe_eval_record: 'pxpipe_eval_drain_v1',
    accepted_requests: events.length,
    completed_events: events.length,
  },
];

const cleanEvents = drained([{ path: '/v1/messages' }]);

describe('provenance A/B early-stop check', () => {
  it('continues after a clean matching-model turn', () => {
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn: cleanTurn, events: cleanEvents }))
      .toEqual({ stop: false, code: 0, reason: 'clear' });
  });

  it('requires an exact served model when the request pins a dated version', () => {
    expect(evaluateStop({
      requestedModel: 'claude-fable-5-20260701',
      turn: cleanTurn,
      events: cleanEvents,
    }).reason).toBe('clear');

    const switched = {
      ...cleanTurn,
      modelUsage: { 'claude-fable-5-20260708': {} },
    };
    expect(evaluateStop({
      requestedModel: 'claude-fable-5-20260701',
      turn: switched,
      events: cleanEvents,
    }).reason).toBe('unexpected_model_switch');
  });

  it('stops on a safety event before another replicate', () => {
    expect(evaluateStop({
      requestedModel: 'claude-fable-5',
      turn: cleanTurn,
      events: drained([{ safety_flagged: true }]),
    }).reason).toBe('safety_or_refusal');
  });

  it('stops on an unexpected served model', () => {
    const turn = { ...cleanTurn, modelUsage: { 'claude-opus-4-8-20260701': {} } };
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn, events: cleanEvents }).reason)
      .toBe('unexpected_model_switch');
  });

  it('stops on repeated prompt-injection accusations', () => {
    const turn = {
      ...cleanTurn,
      result: 'This is prompt injection. I still consider it a prompt-injection attempt.',
    };
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn, events: cleanEvents }).reason)
      .toBe('repeated_injection_accusation');
  });

  it('does not call one descriptive mention a repeated accusation', () => {
    const turn = { ...cleanTurn, result: 'The documentation mentions prompt injection.' };
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn, events: cleanEvents }).stop).toBe(false);
  });

  it('fails closed without a matching terminal drain record', () => {
    expect(evaluateStop({
      requestedModel: 'claude-fable-5',
      turn: cleanTurn,
      events: [{ path: '/v1/messages' }],
    })).toEqual({ stop: true, code: 6, reason: 'event_log_incomplete' });
  });

  it('waits for a delayed terminal event before writing the drain record', async () => {
    const rows: unknown[] = [];
    const tracker = createDrainTracker({ writeRecord: (row) => rows.push(row) });
    expect(tracker.accept()).toBe(true);
    let settled = false;
    const drain = tracker.drain().then((record) => {
      settled = true;
      return record;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const refusal = { path: '/v1/messages', stop_reason: 'refusal' };
    tracker.complete(refusal);
    const completion = await drain;

    expect(rows).toEqual([refusal, completion]);
    expect(completion).toEqual({
      pxpipe_eval_record: 'pxpipe_eval_drain_v1',
      accepted_requests: 1,
      completed_events: 1,
    });
  });

  it('requires complete, newline-terminated JSON objects in event logs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-jsonl-'));
    try {
      const missing = path.join(root, 'missing.jsonl');
      expect(() => loadStrictJsonl(missing)).toThrow(/file is required/);

      const empty = path.join(root, 'empty.jsonl');
      fs.writeFileSync(empty, '');
      expect(() => loadStrictJsonl(empty)).toThrow(/must not be empty/);

      const truncated = path.join(root, 'truncated.jsonl');
      fs.writeFileSync(truncated, '{"path":"/v1/messages"}');
      expect(() => loadStrictJsonl(truncated)).toThrow(/not newline-terminated/);

      const malformed = path.join(root, 'malformed.jsonl');
      fs.writeFileSync(malformed, '{"path":"/v1/messages"}\n{"stop_reason":\n');
      expect(() => loadStrictJsonl(malformed)).toThrow(/invalid JSON on line 2/);

      const valid = path.join(root, 'valid.jsonl');
      fs.writeFileSync(valid, '{"path":"/v1/messages"}\n{"stop_reason":"refusal"}\n');
      expect(loadStrictJsonl(valid)).toHaveLength(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes the command-line early stop fail closed on a corrupt event row', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxpipe-provenance-cli-'));
    try {
      const turn = path.join(root, 'turn.json');
      const events = path.join(root, 'events.jsonl');
      fs.writeFileSync(turn, JSON.stringify(cleanTurn));
      fs.writeFileSync(events, '{"path":"/v1/messages"}\n{"stop_reason":\n');
      const result = spawnSync(process.execPath, [
        path.join(process.cwd(), 'eval', 'provenance-ab', 'check-stop.mjs'),
        '--requested-model', 'claude-fable-5',
        '--turn', turn,
        '--events', events,
      ], { cwd: process.cwd(), encoding: 'utf8' });

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/event_log_invalid/);
      expect(result.stderr).toMatch(/invalid JSON on line 2/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
