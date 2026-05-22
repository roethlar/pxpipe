<script lang="ts">
  // Disk usage rows + prune-older-than action. The destructive prune
  // requires a typed-confirm in the legacy UI; we keep that but route it
  // through a native confirm() instead of inline text comparison - the
  // operator still has to read the impact summary before clicking through.

  import { disk, toasts } from '../stores/index.js';
  import { dryRunPrune, executePrune } from '../lib/api.js';
  import { fmtBytes } from '../lib/format.js';

  $: d = $disk.data;
  $: err = $disk.error;

  let days = 30;
  let busy = false;
  let result = '';

  async function runPrune() {
    if (busy) return;
    result = '';
    busy = true;
    try {
      const dry = await dryRunPrune({ olderThanDays: days });
      if (!dry.sessionsRemoved || dry.sessionsRemoved.length === 0) {
        result = 'nothing older than ' + days + ' days';
        return;
      }
      const msg =
        'Prune ' +
        dry.sessionsRemoved.length +
        ' sessions (' +
        (dry.eventsRemoved ?? 0).toLocaleString('en-US') +
        ' events, ' +
        fmtBytes(
          (dry.jsonlBytesFreed ?? 0) + (dry.sidecarBytesFreed ?? 0),
        ) +
        ') older than ' +
        days +
        ' days?\n\nThis cannot be undone.';
      if (!window.confirm(msg)) return;
      const real = await executePrune({ olderThanDays: days });
      result =
        'removed ' +
        (real.sessionsRemoved?.length || 0) +
        ' sessions, ' +
        (real.eventsRemoved ?? 0).toLocaleString('en-US') +
        ' events, ' +
        fmtBytes((real.jsonlBytesFreed ?? 0) + (real.sidecarBytesFreed ?? 0));
      disk.run();
    } catch (e) {
      result = 'error: ' + (e as Error).message;
      toasts.push({ level: 'error', text: result });
    } finally {
      busy = false;
    }
  }
</script>

<div class="status">
  {#if $disk.loading && !d}
    loading…
  {:else if err}
    {err}
  {:else if d}
    {fmtBytes(d.totalBytes)} on disk
  {:else}
    -
  {/if}
</div>

<table>
  <tbody>
    {#if d}
      <tr>
        <td>events.jsonl</td>
        <td class="num">{fmtBytes(d.eventsJsonlBytes)}</td>
        <td class="small">{d.paths?.eventsFile ?? ''}</td>
      </tr>
      <tr>
        <td>4xx-bodies</td>
        <td class="num">{fmtBytes(d.sidecarBytes)}</td>
        <td class="small">{d.sidecarCount ?? 0} files</td>
      </tr>
    {/if}
  </tbody>
</table>

<div class="prune-row">
  <label class="small" for="prune-days">prune older than</label>
  <select id="prune-days" bind:value={days}>
    <option value={7}>7 days</option>
    <option value={30}>30 days</option>
    <option value={90}>90 days</option>
  </select>
  <button type="button" disabled={busy} on:click={runPrune}>
    {busy ? 'pruning…' : 'prune button'}
  </button>
</div>
<div class="result">{result}</div>

<style>
  .status {
    margin-bottom: 12px;
    color: #6e7681;
    font-size: 12px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-bottom: 14px;
  }
  td {
    padding: 6px 8px;
    border-bottom: 1px solid #21262d;
    vertical-align: top;
    font-variant-numeric: tabular-nums;
  }
  td:last-child {
    border-bottom: none;
  }
  .num {
    text-align: right;
  }
  .small {
    color: #6e7681;
    font-size: 11px;
  }
  .prune-row {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  select {
    background: #0d1117;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 4px;
    font: inherit;
    font-size: 12px;
  }
  button {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 4px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
  }
  button:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .result {
    margin-top: 10px;
    color: #6e7681;
    font-size: 12px;
  }
</style>
