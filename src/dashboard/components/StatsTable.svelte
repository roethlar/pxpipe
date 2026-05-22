<script lang="ts">
  // Full-history aggregate table - same shape as the legacy "stats" panel.
  // Sourced from /api/stats.json which re-runs the aggregation on every
  // poll. Cheap because the JSONL is line-streamed.

  import { stats } from '../stores/index.js';
  import { numFmt, fmtBytes, round1 } from '../lib/format.js';

  $: payload = $stats.data;
  $: err = payload?.error;
  $: s = payload?.summary;

  // Hit rate / char ratio are derived numbers - keep the math here rather
  // than baking them into the API response so the formulas are visible.
  $: hitRateTok = (() => {
    if (!s) return '-';
    const totalIn =
      (s.inputTokensTotal || 0) + (s.cacheCreateTokensTotal || 0) + (s.cacheReadTokensTotal || 0);
    return totalIn > 0 ? ((s.cacheReadTokensTotal / totalIn) * 100).toFixed(1) + '%' : '-';
  })();
  $: hitRateEv = (() => {
    if (!s) return '-';
    return s.eventsWithBaseline > 0
      ? ((s.cacheHitEvents / s.eventsWithBaseline) * 100).toFixed(1) + '%'
      : '-';
  })();
  $: charRatio = (() => {
    if (!s) return '-';
    return s.origCharsTotal > 0
      ? ((s.imageBytesTotal / s.origCharsTotal) * 100).toFixed(3) + 'x'
      : '-';
  })();
</script>

<div class="status">
  {#if $stats.loading && !payload}
    loading…
  {:else if err}
    {err}
  {:else if payload}
    {numFmt(payload.parsed)} events parsed
  {:else}
    -
  {/if}
</div>

<table>
  <tbody>
    {#if s}
      <tr>
        <td>requests</td>
        <td class="num">{numFmt(s.total)}</td>
      </tr>
      <tr>
        <td>2xx / 4xx / 5xx</td>
        <td class="num">{numFmt(s.ok2xx)} / {numFmt(s.err4xx)} / {numFmt(s.err5xx)}</td>
      </tr>
      <tr>
        <td>compressed</td>
        <td class="num">{numFmt(s.compressed)}</td>
      </tr>
      <tr>
        <td>passthrough</td>
        <td class="num">{numFmt(s.passthrough)}</td>
      </tr>
      <tr>
        <td>input tokens</td>
        <td class="num">{numFmt(s.inputTokensTotal)}</td>
      </tr>
      <tr>
        <td>cache create</td>
        <td class="num">{numFmt(s.cacheCreateTokensTotal)}</td>
      </tr>
      <tr>
        <td>cache read</td>
        <td class="num">{numFmt(s.cacheReadTokensTotal)}</td>
      </tr>
      <tr>
        <td>cache hit (tok)</td>
        <td class="num">{hitRateTok}</td>
      </tr>
      <tr>
        <td>cache hit (ev)</td>
        <td class="num">{hitRateEv}</td>
      </tr>
      <tr>
        <td>orig chars</td>
        <td class="num">{numFmt(s.origCharsTotal)}</td>
      </tr>
      <tr>
        <td>image bytes</td>
        <td class="num">{numFmt(s.imageBytesTotal)}</td>
      </tr>
      <tr>
        <td>bytes/char</td>
        <td class="num">{charRatio}</td>
      </tr>
      <tr>
        <td>latency p50/p95</td>
        <td class="num">{numFmt(s.durationP50)} / {numFmt(s.durationP95)} ms</td>
      </tr>
      <tr>
        <td>first-byte p50/p95</td>
        <td class="num">{numFmt(s.firstBytemsP50)} / {numFmt(s.firstBytemsP95)} ms</td>
      </tr>
    {/if}
  </tbody>
</table>

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
</style>
