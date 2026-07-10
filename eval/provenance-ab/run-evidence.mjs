// Durable event-log completion for the owner-gated provenance matrix.

import fs from 'node:fs';

export const DRAIN_RECORD_KIND = 'pxpipe_eval_drain_v1';

export function requestedModelMatches(requestedModel, observedModel) {
  const requested = String(requestedModel ?? '');
  const observed = String(observedModel ?? '');
  if (/-\d{8}$/.test(requested)) return observed === requested;
  return observed.replace(/-\d{8}$/, '') === requested;
}

export function loadStrictJsonl(file, label = file) {
  if (!fs.existsSync(file)) throw new Error(`${label}: file is required`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.length === 0) throw new Error(`${label}: file must not be empty`);
  if (!text.endsWith('\n')) {
    throw new Error(`${label}: final JSONL row is not newline-terminated`);
  }
  const lines = text.slice(0, -1).split('\n');
  return lines.map((line, index) => {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${label}: invalid JSON on line ${index + 1}`);
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label}: line ${index + 1} must be a JSON object`);
    }
    return value;
  });
}

export function createDrainTracker({ writeRecord, timeoutMs = 60_000 }) {
  let acceptedRequests = 0;
  let completedEvents = 0;
  let draining = false;
  let writeError;
  const waiters = new Set();

  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };

  return {
    accept() {
      if (draining) return false;
      acceptedRequests += 1;
      return true;
    },

    complete(record) {
      try {
        writeRecord(record);
      } catch (error) {
        writeError ??= error;
      } finally {
        completedEvents += 1;
        wake();
      }
    },

    async drain() {
      draining = true;
      const deadline = Date.now() + timeoutMs;
      while (completedEvents < acceptedRequests) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(
            `timed out draining evaluation events (${completedEvents}/${acceptedRequests})`,
          );
        }
        await new Promise((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            waiters.delete(done);
            reject(new Error(
              `timed out draining evaluation events (${completedEvents}/${acceptedRequests})`,
            ));
          }, remaining);
          waiters.add(done);
        });
      }
      if (writeError) throw writeError;
      if (completedEvents !== acceptedRequests) {
        throw new Error(
          `evaluation event count mismatch (${completedEvents}/${acceptedRequests})`,
        );
      }
      const record = {
        pxpipe_eval_record: DRAIN_RECORD_KIND,
        accepted_requests: acceptedRequests,
        completed_events: completedEvents,
      };
      writeRecord(record);
      return record;
    },
  };
}

export function splitCompletedEvents(rows, label = 'events') {
  const completions = rows.filter(
    (row) => row?.pxpipe_eval_record === DRAIN_RECORD_KIND,
  );
  const completion = completions[0];
  if (completions.length !== 1 || rows.at(-1) !== completion) {
    throw new Error(`${label}: one terminal drain record is required`);
  }
  const accepted = completion.accepted_requests;
  const completed = completion.completed_events;
  const events = rows.slice(0, -1);
  if (
    !Number.isInteger(accepted) || accepted < 1 ||
    !Number.isInteger(completed) || completed !== accepted ||
    events.length !== completed
  ) {
    throw new Error(`${label}: drained event counts are incomplete or inconsistent`);
  }
  return { events, completion };
}
