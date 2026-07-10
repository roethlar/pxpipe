#!/usr/bin/env node
// No-network early-stop check for one live-matrix replicate.

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  loadStrictJsonl,
  requestedModelMatches,
  splitCompletedEvents,
} from './run-evidence.mjs';

const accusationPatterns = [
  /\bprompt[- ]injection\b/gi,
  /\bmalicious\s+(?:prompt|instructions?)\b/gi,
  /\buntrusted\s+(?:prompt|instructions?)\b/gi,
];

export function evaluateStop({ requestedModel, turn, events }) {
  let observedEvents;
  try {
    ({ events: observedEvents } = splitCompletedEvents(events, 'early-stop events'));
  } catch {
    return { stop: true, code: 6, reason: 'event_log_incomplete' };
  }
  const safety = observedEvents.some(
    (event) =>
      event?.safety_flagged === true ||
      event?.stop_reason === 'refusal' ||
      event?.stop_reason === 'content_filter',
  );
  if (safety) return { stop: true, code: 3, reason: 'safety_or_refusal' };

  const servedModels = Object.keys(turn?.modelUsage ?? {});
  if (servedModels.length === 0) {
    return { stop: true, code: 4, reason: 'served_model_missing' };
  }
  if (servedModels.some((model) => !requestedModelMatches(requestedModel, model))) {
    return { stop: true, code: 4, reason: 'unexpected_model_switch' };
  }

  const result = typeof turn?.result === 'string' ? turn.result : '';
  const accusationCount = accusationPatterns.reduce(
    (count, pattern) => count + (result.match(pattern)?.length ?? 0),
    0,
  );
  if (accusationCount >= 2) {
    return { stop: true, code: 5, reason: 'repeated_injection_accusation' };
  }

  return { stop: false, code: 0, reason: 'clear' };
}

function cliOption(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const requestedModel = cliOption(args, 'requested-model');
  const turnPath = cliOption(args, 'turn');
  const eventsPath = cliOption(args, 'events');
  if (!requestedModel || !turnPath || !eventsPath) {
    console.error('usage: check-stop.mjs --requested-model <id> --turn <turn.json> --events <events.jsonl>');
    process.exit(2);
  }

  let turn;
  try {
    turn = JSON.parse(fs.readFileSync(turnPath, 'utf8'));
  } catch {
    console.error(JSON.stringify({ stop: true, code: 4, reason: 'turn_unreadable' }));
    process.exit(4);
  }
  let events;
  try {
    events = loadStrictJsonl(eventsPath);
  } catch (error) {
    console.error(JSON.stringify({
      stop: true,
      code: 6,
      reason: 'event_log_invalid',
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exit(6);
  }
  const verdict = evaluateStop({ requestedModel, turn, events });
  console.error(JSON.stringify(verdict));
  process.exit(verdict.code);
}
