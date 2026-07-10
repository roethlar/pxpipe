export interface StopCheckInput {
  requestedModel: string;
  turn: { result?: unknown; modelUsage?: Record<string, unknown> };
  events: Array<{ safety_flagged?: boolean; stop_reason?: string }>;
}

export interface StopCheckResult {
  stop: boolean;
  code: number;
  reason: string;
}

export function evaluateStop(input: StopCheckInput): StopCheckResult;
