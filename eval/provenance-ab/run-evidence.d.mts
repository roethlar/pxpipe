export interface DrainRecord {
  pxpipe_eval_record: 'pxpipe_eval_drain_v1';
  accepted_requests: number;
  completed_events: number;
}

export interface DrainTracker {
  accept(): boolean;
  complete(record: unknown): void;
  drain(): Promise<DrainRecord>;
}

export function requestedModelMatches(
  requestedModel: unknown,
  observedModel: unknown,
): boolean;

export function loadStrictJsonl(
  file: string,
  label?: string,
): Array<Record<string, unknown>>;

export function createDrainTracker(options: {
  writeRecord: (record: unknown) => void;
  timeoutMs?: number;
}): DrainTracker;

export function splitCompletedEvents(
  rows: unknown[],
  label?: string,
): { events: unknown[]; completion: DrainRecord };
