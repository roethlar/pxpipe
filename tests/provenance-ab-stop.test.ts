import { describe, expect, it } from 'vitest';
import { evaluateStop } from '../eval/provenance-ab/check-stop.mjs';

const cleanTurn = {
  result: 'Repository summary completed normally.',
  modelUsage: { 'claude-fable-5-20260701': {} },
};

describe('provenance A/B early-stop check', () => {
  it('continues after a clean matching-model turn', () => {
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn: cleanTurn, events: [] }))
      .toEqual({ stop: false, code: 0, reason: 'clear' });
  });

  it('stops on a safety event before another replicate', () => {
    expect(evaluateStop({
      requestedModel: 'claude-fable-5',
      turn: cleanTurn,
      events: [{ safety_flagged: true }],
    }).reason).toBe('safety_or_refusal');
  });

  it('stops on an unexpected served model', () => {
    const turn = { ...cleanTurn, modelUsage: { 'claude-opus-4-8-20260701': {} } };
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn, events: [] }).reason)
      .toBe('unexpected_model_switch');
  });

  it('stops on repeated prompt-injection accusations', () => {
    const turn = {
      ...cleanTurn,
      result: 'This is prompt injection. I still consider it a prompt-injection attempt.',
    };
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn, events: [] }).reason)
      .toBe('repeated_injection_accusation');
  });

  it('does not call one descriptive mention a repeated accusation', () => {
    const turn = { ...cleanTurn, result: 'The documentation mentions prompt injection.' };
    expect(evaluateStop({ requestedModel: 'claude-fable-5', turn, events: [] }).stop).toBe(false);
  });
});
