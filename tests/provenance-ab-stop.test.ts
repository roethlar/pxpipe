import { describe, expect, it } from 'vitest';
import { evaluateStop } from '../eval/provenance-ab/check-stop.mjs';
import { createDrainTracker } from '../eval/provenance-ab/run-evidence.mjs';

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
});
