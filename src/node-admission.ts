/**
 * Process-local defense in depth for the Node host.
 *
 * The Workers-safe four-probe gate remains authoritative. This coordinator only
 * prevents concurrent duplicate candidates and remembers an observed negative
 * result for the exact same provider/route/model/source/candidate/cache tuple.
 */

import { createHash } from 'node:crypto';

export type CompressionLeaseDeniedReason = 'in_flight' | 'disabled_after_negative';

export interface CompressionFingerprintInput {
  readonly provider: string;
  readonly route: string;
  readonly model: string;
  readonly sourceBody: Uint8Array;
  readonly candidateBody: Uint8Array;
  readonly cacheTier: string;
}

export function buildCompressionFingerprint(input: CompressionFingerprintInput): string {
  const hash = createHash('sha256');
  for (const field of [input.provider, input.route, input.model, input.cacheTier]) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    hash.update(length);
    hash.update(bytes);
  }
  for (const body of [input.sourceBody, input.candidateBody]) {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(body.byteLength));
    hash.update(length);
    hash.update(body);
  }
  return `pxa_${hash.digest('hex')}`;
}

export interface CompressionLease {
  readonly fingerprint: string;
  /** Record the signed live counterfactual and release the in-flight lock. */
  finish(signedSavingsTokens?: number): void;
}

export type CompressionLeaseResult =
  | { readonly acquired: true; readonly lease: CompressionLease }
  | { readonly acquired: false; readonly reason: CompressionLeaseDeniedReason };

export interface CompressionCoordinator {
  acquire(fingerprint: string): CompressionLeaseResult;
}

/**
 * State is intentionally unbounded by time: expiry alone cannot prove a
 * previously losing candidate safe. The request-space is bounded in practice by
 * the process lifetime; restart clears this defense-in-depth memory but not the
 * mandatory per-request admission gate.
 */
export class ProcessCompressionBreaker implements CompressionCoordinator {
  private readonly inFlight = new Set<string>();
  private readonly disabled = new Set<string>();

  acquire(fingerprint: string): CompressionLeaseResult {
    if (this.disabled.has(fingerprint)) {
      return { acquired: false, reason: 'disabled_after_negative' };
    }
    if (this.inFlight.has(fingerprint)) {
      return { acquired: false, reason: 'in_flight' };
    }
    this.inFlight.add(fingerprint);
    let finished = false;
    return {
      acquired: true,
      lease: {
        fingerprint,
        finish: (signedSavingsTokens?: number): void => {
          if (finished) return;
          finished = true;
          this.inFlight.delete(fingerprint);
          if (
            typeof signedSavingsTokens === 'number'
            && Number.isFinite(signedSavingsTokens)
            && signedSavingsTokens < 0
          ) {
            this.disabled.add(fingerprint);
          }
        },
      },
    };
  }

  isDisabled(fingerprint: string): boolean {
    return this.disabled.has(fingerprint);
  }

  isInFlight(fingerprint: string): boolean {
    return this.inFlight.has(fingerprint);
  }

  /** Re-entry is explicit and must only follow a separately proven positive. */
  recordProvenPositive(fingerprint: string): void {
    this.disabled.delete(fingerprint);
  }
}
