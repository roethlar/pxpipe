// Reactive stores for each dashboard panel. The polling cadence matches the
// legacy dashboard exactly: 2s for the live counters + recent table,
// 5s for the slower aggregates. The Svelte stores are dev-time only — the
// proxy still serves a single static HTML string at runtime (built by
// scripts/build-dashboard-ui.mjs from these sources).

import { writable, derived } from 'svelte/store';
import { pollJson } from './poll.js';
import type {
  StatsPayload,
  RecentPayload,
  SessionsPayload,
  FullStatsPayload,
  DiskPayload,
  SessionFilters,
} from '../types.js';

// Live counters + recent table (legacy poll cadence: 2s).
export const stats = pollJson<StatsPayload>('/proxy-stats', 2000);
export const recent = pollJson<RecentPayload>('/proxy-recent', 2000);

// Slower endpoints (legacy: 5s).
export const sessions = pollJson<SessionsPayload>('/api/sessions.json', 5000);
export const fullStats = pollJson<FullStatsPayload>('/api/stats.json', 5000);
export const disk = pollJson<DiskPayload>('/api/disk.json', 5000);

// Session table filter + selection state. UI-only — survives across diff
// renders but not across reloads. Persists to localStorage opportunistically.
export const sessionFilters = writable<SessionFilters>(loadFilters());

sessionFilters.subscribe((f) => {
  try {
    localStorage.setItem('pixelpipe.dashboard.filters', JSON.stringify(f));
  } catch {
    /* private mode / no storage — best effort */
  }
});

function loadFilters(): SessionFilters {
  try {
    const raw = localStorage.getItem('pixelpipe.dashboard.filters');
    if (!raw) return defaultFilters();
    const parsed = JSON.parse(raw) as Partial<SessionFilters>;
    return {
      warmOnly: parsed.warmOnly === true,
      compressedOnly: parsed.compressedOnly === true,
      search: typeof parsed.search === 'string' ? parsed.search : '',
    };
  } catch {
    return defaultFilters();
  }
}

function defaultFilters(): SessionFilters {
  return { warmOnly: false, compressedOnly: false, search: '' };
}

// Multi-select bookkeeping for the session table (bulk delete pattern).
// Just the IDs — the row data lives in the `sessions` store.
export const selectedSessionIds = writable<Set<string>>(new Set());

// Filtered + sorted view that the table component reads. Re-derives whenever
// raw sessions or filter state change; this is where sort/filter/search lives
// so the rendering component stays presentational.
export const visibleSessions = derived(
  [sessions, sessionFilters],
  ([$sessions, $filters]) => {
    const rows = $sessions.data?.sessions ?? [];
    const q = $filters.search.trim().toLowerCase();
    return rows.filter((s) => {
      if ($filters.warmOnly && (s.cacheReadTokens ?? 0) <= 0) return false;
      if ($filters.compressedOnly && (s.tokensSavedEst ?? 0) <= 0) return false;
      if (q) {
        const hay = [s.id, s.project, s.claudeCode?.projectPath, s.claudeCode?.firstUserPreview]
          .filter((x): x is string => typeof x === 'string')
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  },
);

// The selection anchor for shift-click range select. Matches the legacy
// dashboard's Gmail/Finder/GitHub multi-select semantics.
export const lastClickedSessionId = writable<string | null>(null);

// Toast-style messages for confirm/error feedback. Components can push and
// the App-level component renders them. Tiny on purpose — full toast library
// would blow the zero-dep budget.
export interface Toast {
  id: number;
  level: 'info' | 'error';
  text: string;
}
function makeToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);
  let nextId = 1;
  return {
    subscribe,
    push(level: Toast['level'], text: string) {
      const id = nextId++;
      update((arr) => [...arr, { id, level, text }]);
      setTimeout(() => update((arr) => arr.filter((t) => t.id !== id)), 5000);
    },
    dismiss(id: number) {
      update((arr) => arr.filter((t) => t.id !== id));
    },
  };
}
export const toasts = makeToastStore();
