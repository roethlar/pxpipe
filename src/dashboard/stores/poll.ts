// Polling helper. Replaces the legacy `tick()` / `tickSlow()` setInterval pair
// with a Svelte-friendly writable store that auto-refreshes on an interval.
//
// Each panel subscribes to the store it cares about; the fetch only runs
// when something is listening, which means the session-detail page (separate
// HTML doc) doesn't pay the cost of the dashboard's polling loop.

import { readable, type Readable } from 'svelte/store';
import { fetchJson } from '../lib/api.js';

export interface Polled<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Polling readable store. Fetches `url` immediately and every `intervalMs`
 * while subscribed. Stops the interval when the last subscriber leaves so a
 * navigation away from the dashboard tab doesn't keep hitting the proxy.
 */
/**
 * A polling store plus an imperative `run()` to force an out-of-band refresh
 * (e.g. right after a mutation, so the table doesn't wait for the next tick).
 */
export interface PollStore<T> extends Readable<Polled<T>> {
  run: () => void;
}

export function pollJson<T>(url: string, intervalMs: number): PollStore<T> {
  // `refresh` is rebound to the live fetch while a subscriber is attached, and
  // reset to a no-op once the last subscriber leaves (interval stopped).
  let refresh: () => void = () => {};
  const store = readable<Polled<T>>({ data: null, error: null, loading: true }, (set) => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastData: T | null = null;

    const run = async () => {
      try {
        const data = await fetchJson<T>(url);
        if (cancelled) return;
        lastData = data;
        set({ data, error: null, loading: false });
      } catch (e) {
        if (cancelled) return;
        // Keep the last successful payload visible so transient errors don't
        // wipe the table. Surface the message in the sub-line.
        set({
          data: lastData,
          error: (e as Error).message,
          loading: false,
        });
      }
    };

    refresh = () => {
      void run();
    };
    run();
    timer = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      refresh = () => {};
      if (timer) clearInterval(timer);
    };
  });

  return {
    subscribe: store.subscribe,
    run: () => refresh(),
  };
}
