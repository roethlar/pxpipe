import { describe, expect, it } from 'vitest';
import {
  ProcessCompressionBreaker,
  buildCompressionFingerprint,
} from '../src/node-admission.js';

const enc = new TextEncoder();

function fingerprint(overrides: Partial<Parameters<typeof buildCompressionFingerprint>[0]> = {}): string {
  return buildCompressionFingerprint({
    provider: 'anthropic',
    route: '/v1/messages',
    model: 'claude-fable-5',
    sourceBody: enc.encode('{"source":1}'),
    candidateBody: enc.encode('{"candidate":1}'),
    cacheTier: '5m',
    ...overrides,
  });
}

describe('buildCompressionFingerprint', () => {
  it('is stable and isolates provider, route, model, source, candidate, and tier', () => {
    const base = fingerprint();
    expect(fingerprint()).toBe(base);
    expect(fingerprint({ provider: 'openai' })).not.toBe(base);
    expect(fingerprint({ route: '/anthropic/messages' })).not.toBe(base);
    expect(fingerprint({ model: 'grok-4.5' })).not.toBe(base);
    expect(fingerprint({ sourceBody: enc.encode('{"source":2}') })).not.toBe(base);
    expect(fingerprint({ candidateBody: enc.encode('{"candidate":2}') })).not.toBe(base);
    expect(fingerprint({ cacheTier: '1h' })).not.toBe(base);
  });
});

describe('ProcessCompressionBreaker', () => {
  it('sends an overlapping duplicate native until the first response is measured', () => {
    const breaker = new ProcessCompressionBreaker();
    const key = fingerprint();
    const first = breaker.acquire(key);
    expect(first.acquired).toBe(true);
    expect(breaker.acquire(key)).toEqual({ acquired: false, reason: 'in_flight' });
    if (first.acquired) first.lease.finish(100);
    expect(breaker.acquire(key).acquired).toBe(true);
  });

  it('keeps an exact negative fingerprint disabled without a time reset', () => {
    const breaker = new ProcessCompressionBreaker();
    const key = fingerprint();
    const result = breaker.acquire(key);
    if (!result.acquired) throw new Error(result.reason);
    result.lease.finish(-1);
    expect(breaker.isDisabled(key)).toBe(true);
    expect(breaker.acquire(key)).toEqual({
      acquired: false,
      reason: 'disabled_after_negative',
    });
  });

  it('does not let one model or source disable another and requires explicit re-entry proof', () => {
    const breaker = new ProcessCompressionBreaker();
    const fable = fingerprint();
    const sol = fingerprint({ model: 'gpt-5.6-sol' });
    const fableLease = breaker.acquire(fable);
    if (!fableLease.acquired) throw new Error(fableLease.reason);
    fableLease.lease.finish(-50);
    expect(breaker.acquire(sol).acquired).toBe(true);
    expect(breaker.acquire(fable)).toEqual({
      acquired: false,
      reason: 'disabled_after_negative',
    });
    breaker.recordProvenPositive(fable);
    expect(breaker.acquire(fable).acquired).toBe(true);
  });

  it('releases once and does not disable on missing, zero, positive, or non-finite feedback', () => {
    for (const feedback of [undefined, 0, 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const breaker = new ProcessCompressionBreaker();
      const key = fingerprint({ model: String(feedback) });
      const result = breaker.acquire(key);
      if (!result.acquired) throw new Error(result.reason);
      result.lease.finish(feedback);
      result.lease.finish(-100);
      expect(breaker.isDisabled(key)).toBe(false);
      expect(breaker.isInFlight(key)).toBe(false);
    }
  });
});
