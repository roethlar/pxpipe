<script lang="ts">
  // Session table with industry-standard multi-select-and-delete pattern
  // (Gmail / GitHub / Linear): per-row checkbox + header tri-state checkbox
  //  + shift-click range + contextual action bar + Esc-clears. Selection
  // survives diff-renders (Svelte's reactivity handles that natively now -
  // the legacy dashboard had to re-apply checked state after each innerHTML
  // wipe). Filter chips switch between warm/cold/compressed/uncompressed
  // and a free-text search box. Column headers are sortable; sort state
  // persists in localStorage so a page refresh doesn't shuffle the rows.

  import { sessions, visibleSessions, sessionFilters, toasts } from '../stores/index.js';
  import { fmtBytes, fmtTs, shortPath } from '../lib/format.js';
  import { executePrune } from '../lib/api.js';
  import type { SessionFilters } from '../types.js';

  type SortKey =
    | 'lastSeen'
    | 'requestCount'
    | 'tokensSavedEst'
    | 'cacheReadTokens'
    | 'sidecarBytes';
  type SortDir = 'asc' | 'desc';

  const SORT_KEY = 'pixelpipe.sessionSort';
  let sortKey: SortKey = 'lastSeen';
  let sortDir: SortDir = 'desc';

  // Restore sort state. Defensive: invalid JSON or unknown keys fall back
  // to the default. localStorage may throw in private browsing modes.
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ key: SortKey; dir: SortDir }>;
      if (parsed.key) sortKey = parsed.key;
      if (parsed.dir) sortDir = parsed.dir;
    }
  } catch {
    /* swallow */
  }

  function setSort(k: SortKey) {
    if (sortKey === k) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = k;
      sortDir = 'desc';
    }
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify({ key: sortKey, dir: sortDir }));
    } catch {
      /* swallow */
    }
  }

  function sortArrow(k: SortKey): string {
    if (k !== sortKey) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  // Reactive sorted rows. The store already applies warm/cold/compressed/
  // search filters; we just sort on top.
  $: rawRows = $visibleSessions;
  $: rows = [...rawRows].sort((a, b) => {
    const av = a[sortKey] as number | string | undefined;
    const bv = b[sortKey] as number | string | undefined;
    const an = typeof av === 'number' ? av : 0;
    const bn = typeof bv === 'number' ? bv : 0;
    return sortDir === 'asc' ? an - bn : bn - an;
  });

  // ---- multi-select state machine (per-row checkbox + header tri-state) ----
  let selected = new Set<string>();
  let anchorId: string | null = null;

  $: visibleIds = rows.map((r) => r.id);
  // Drop selections that vanished from the visible rows. Matches Gmail:
  // selecting "old" then filtering doesn't preserve invisible selections.
  $: {
    const seen = new Set(visibleIds);
    let changed = false;
    for (const id of [...selected]) {
      if (!seen.has(id)) {
        selected.delete(id);
        changed = true;
      }
    }
    if (changed) selected = new Set(selected); // trigger reactivity
  }

  $: selCount = selected.size;
  $: headerState =
    selCount === 0
      ? 'empty'
      : selCount === visibleIds.length
        ? 'all'
        : 'indeterminate';

  function setRowSelected(id: string, on: boolean) {
    if (on) selected.add(id);
    else selected.delete(id);
    selected = new Set(selected);
  }

  function onRowCheckbox(ev: MouseEvent, id: string) {
    const target = ev.currentTarget as HTMLInputElement;
    const on = target.checked;
    // Shift-click: range selection between anchor and clicked row. Matches
    // macOS Finder / Gmail. Anchor itself doesn't move on a shift-click -
    // subsequent shift-clicks re-extend from the same id.
    if (ev.shiftKey && anchorId && anchorId !== id) {
      const a = visibleIds.indexOf(anchorId);
      const b = visibleIds.indexOf(id);
      if (a >= 0 && b >= 0) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = lo; i <= hi; i++) {
          if (on) selected.add(visibleIds[i]);
          else selected.delete(visibleIds[i]);
        }
        selected = new Set(selected);
        return;
      }
    }
    setRowSelected(id, on);
    anchorId = id;
  }

  function onHeaderCheckbox(ev: MouseEvent) {
    // Tri-state: empty -> all, indeterminate -> empty, all -> empty.
    // The browser only gives us a boolean; we infer from headerState.
    const turnOn = headerState !== 'all';
    const target = ev.currentTarget as HTMLInputElement;
    target.checked = turnOn;
    if (turnOn) for (const id of visibleIds) selected.add(id);
    else selected.clear();
    selected = new Set(selected);
  }

  // Esc clears the selection - fast escape hatch when the operator changed
  // their mind. Only fires when no input/textarea has focus so it doesn't
  // trample text input.
  function onKeydown(ev: KeyboardEvent) {
    if (ev.key !== 'Escape') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (selected.size === 0) return;
    selected.clear();
    selected = new Set(selected);
  }

  // ---- bulk + per-row delete ----
  let busy = false;

  async function deleteSession(id: string) {
    if (busy) return;
    // Show one row's worth of detail in the confirm so the operator can
    // scan what they're about to delete.
    const row = rows.find((r) => r.id === id);
    const detail = row
      ? '?\n\n' +
        (row.requestCount ?? 0) +
        ' events, last seen ' +
        fmtTs(row.lastSeen ?? '') +
        '\n\nThis cannot be undone.'
      : '?';
    if (!window.confirm('Delete session ' + id + detail)) return;
    busy = true;
    try {
      const r = await executePrune({ sessionId: id });
      toasts.push({
        level: 'info',
        text: 'removed ' + id + ' - ' + (r.eventsRemoved ?? 0) + ' events',
      });
      sessions.run();
    } catch (e) {
      toasts.push({ level: 'error', text: (e as Error).message });
    } finally {
      busy = false;
    }
  }

  async function bulkDelete() {
    if (busy) return;
    const ids = [...selected];
    if (ids.length === 0) return;
    // First 3 ids, ", and N more". Matches the legacy modal but rendered
    // as a real list with newlines instead of a single joined string.
    const sample = ids.slice(0, 3).map((i) => i.slice(0, 12)).join(', ');
    const more = ids.length > 3 ? ' + ' + (ids.length - 3) + ' more' : '';
    if (
      !window.confirm(
        'Delete ' +
          ids.length +
          ' session' +
          (ids.length === 1 ? '' : 's') +
          '?\n\n' +
          sample +
          more +
          '\n\nThis cannot be undone.',
      )
    )
      return;
    busy = true;
    try {
      const r = await executePrune({ sessionIds: ids });
      toasts.push({
        level: 'info',
        text:
          'removed ' +
          (r.sessionsRemoved?.length || 0) +
          ' sessions, ' +
          (r.eventsRemoved ?? 0) +
          ' events, ' +
          fmtBytes((r.jsonlBytesFreed ?? 0) + (r.sidecarBytesFreed ?? 0)),
      });
      selected.clear();
      selected = new Set(selected);
      sessions.run();
    } catch (e) {
      toasts.push({ level: 'error', text: (e as Error).message });
    } finally {
      busy = false;
    }
  }

  function clearSelection() {
    selected.clear();
    selected = new Set(selected);
  }

  // ---- filter chip helpers ----
  // Filters live in their own store so the data-fetch URL stays in sync.
  // Two chips (warm/compressed) are exclusive booleans; "all" clears both.
  function toggleFilter<K extends keyof SessionFilters>(key: K, value: SessionFilters[K]) {
    sessionFilters.update((f) => ({ ...f, [key]: value }));
  }
  $: filters = $sessionFilters;

  let searchInput = $sessionFilters.search || '';
  // Debounce: typing shouldn't fire a request on every keystroke.
  // 300ms matches Gmail's search-as-you-type lag.
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  function onSearchInput() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      sessionFilters.update((f) => ({ ...f, search: searchInput }));
    }, 300);
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="status">
  {#if $sessions.loading && rows.length === 0}
    loading…
  {:else if $sessions.error}
    {$sessions.error}
  {:else}
    ({rows.length})
  {/if}
</div>

<div class="filters">
  <button
    type="button"
    class="chip"
    class:active={!filters.warmOnly && !filters.compressedOnly}
    on:click={() =>
      sessionFilters.set({ warmOnly: false, compressedOnly: false, search: filters.search })}
  >all</button>
  <button
    type="button"
    class="chip"
    class:active={filters.warmOnly === true}
    on:click={() => toggleFilter('warmOnly', !filters.warmOnly)}
  >warm only</button>
  <button
    type="button"
    class="chip"
    class:active={filters.compressedOnly === true}
    on:click={() => toggleFilter('compressedOnly', !filters.compressedOnly)}
  >compressed only</button>
  <input
    type="text"
    class="search"
    placeholder="search project / session id"
    bind:value={searchInput}
    on:input={onSearchInput}
  />
</div>

{#if selCount > 0}
  <div class="action-bar">
    <span class="small">{selCount} selected</span>
    <button type="button" class="danger" on:click={bulkDelete} disabled={busy}>
      Delete selected
    </button>
    <button type="button" on:click={clearSelection}>Clear (Esc)</button>
    <span class="small hint">Shift-click to range-select</span>
  </div>
{/if}

<table>
  <thead>
    <tr>
      <th class="check">
        <input
          type="checkbox"
          aria-label="select all visible"
          checked={headerState === 'all'}
          indeterminate={headerState === 'indeterminate'}
          on:click={onHeaderCheckbox}
        />
      </th>
      <th>session</th>
      <th>project</th>
      <th>cc</th>
      <th class="num clickable" on:click={() => setSort('lastSeen')}>
        last seen{sortArrow('lastSeen')}
      </th>
      <th class="num clickable" on:click={() => setSort('requestCount')}>
        reqs{sortArrow('requestCount')}
      </th>
      <th class="num clickable" on:click={() => setSort('tokensSavedEst')}>
        saved{sortArrow('tokensSavedEst')}
      </th>
      <th class="num clickable" on:click={() => setSort('cacheReadTokens')}>
        cache read{sortArrow('cacheReadTokens')}
      </th>
      <th class="num clickable" on:click={() => setSort('sidecarBytes')}>
        disk{sortArrow('sidecarBytes')}
      </th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    {#each rows as r (r.id)}
      <tr class:selected={selected.has(r.id)}>
        <td class="check">
          <input
            type="checkbox"
            checked={selected.has(r.id)}
            on:click={(ev) => onRowCheckbox(ev, r.id)}
            aria-label="select session {r.id}"
          />
        </td>
        <td>
          <a href="/sessions/{r.id}">{r.id.slice(0, 12)}</a>
        </td>
        <td>
          {#if r.project}
            <span title={r.project}>{shortPath(r.project)}</span>
          {:else}
            <span class="muted">-</span>
          {/if}
        </td>
        <td class="small">
          {#if r.claudeCode}
            <span title={r.claudeCode.projectPath || ''}>
              {r.claudeCode.projectPath ? shortPath(r.claudeCode.projectPath) : 'ref'}
            </span>
          {:else}
            <span class="muted">-</span>
          {/if}
        </td>
        <td class="num small">{fmtTs(r.lastSeen ?? '')}</td>
        <td class="num">{(r.requestCount ?? 0).toLocaleString('en-US')}</td>
        <td class="num good">{(r.tokensSavedEst ?? 0).toLocaleString('en-US')}</td>
        <td class="num">{(r.cacheReadTokens ?? 0).toLocaleString('en-US')}</td>
        <td class="num">{fmtBytes(r.sidecarBytes ?? 0)}</td>
        <td>
          <button
            type="button"
            class="row-del"
            disabled={busy}
            on:click={() => deleteSession(r.id)}
            aria-label="delete {r.id}"
          >del</button>
        </td>
      </tr>
    {/each}
    {#if rows.length === 0 && !$sessions.loading}
      <tr><td colspan="10" class="empty">no sessions match</td></tr>
    {/if}
  </tbody>
</table>

<style>
  .status {
    margin-bottom: 12px;
    color: #6e7681;
    font-size: 12px;
  }
  .filters {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 12px;
    flex-wrap: wrap;
  }
  .chip {
    background: transparent;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 4px 10px;
    border-radius: 14px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  .chip.active {
    background: #1f2a37;
    border-color: #58a6ff;
    color: #58a6ff;
  }
  .search {
    flex: 1;
    min-width: 180px;
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 4px 8px;
    font: inherit;
    font-size: 12px;
    border-radius: 4px;
  }
  .action-bar {
    display: flex;
    align-items: center;
    gap: 12px;
    background: #1f2a37;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 10px;
  }
  .action-bar button {
    background: transparent;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 4px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    border-radius: 4px;
  }
  .action-bar .danger {
    background: #21262d;
    color: #f85149;
    border-color: #30363d;
  }
  .hint {
    margin-left: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th {
    text-align: left;
    color: #6e7681;
    font-weight: 500;
    padding: 6px 8px;
    border-bottom: 1px solid #30363d;
  }
  th.clickable {
    cursor: pointer;
    user-select: none;
  }
  th.num,
  td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  th.check,
  td.check {
    width: 24px;
    padding: 6px 4px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
  }
  tr.selected td {
    background: #58a6ff0d;
  }
  td.small {
    font-size: 11px;
    color: #6e7681;
  }
  td.good {
    color: #3fb950;
  }
  td.empty {
    text-align: center;
    color: #6e7681;
    padding: 24px;
  }
  .muted {
    color: #6e7681;
  }
  a {
    color: #58a6ff;
    text-decoration: none;
  }
  a:hover {
    text-decoration: underline;
  }
  .row-del {
    background: #21262d;
    color: #f85149;
    border: 1px solid #30363d;
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    border-radius: 4px;
  }
  .row-del:disabled {
    opacity: 0.5;
    cursor: wait;
  }
</style>
