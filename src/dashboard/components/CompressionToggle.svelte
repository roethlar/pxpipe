<script lang="ts">
  // Runtime kill switch for compression. POSTs to /api/compression with the
  // new state. Server returns the new state and the next tick repaints. The
  // optimistic update + final reconciliation keeps the UI from flickering
  // when the user mashes the button.
  //
  // The legacy dashboard read the current state from the button text
  // ("Enable compression" / "Disable") which broke as soon as anyone
  // re-styled the button. The store carries the boolean explicitly.

  import { recent } from '../stores/index.js';
  import { setCompressionEnabled } from '../lib/api.js';
  import { toasts } from '../stores/index.js';

  $: enabled = $recent.data?.compression_enabled !== false;
  let busy = false;

  async function toggle() {
    if (busy) return;
    const next = !enabled;
    if (!next) {
      if (
        !window.confirm(
          'Disable compression?\n\n/v1/messages will forward unchanged to upstream. Use this when upstream is unhealthy or to A/B test the proxy. Restart resets to enabled.',
        )
      ) {
        return;
      }
    }
    busy = true;
    try {
      await setCompressionEnabled(next);
      // Force an immediate refresh so the banner + button update without
      // waiting for the next tick.
      recent.run();
    } catch (e) {
      toasts.push({ level: 'error', text: 'failed to toggle: ' + (e as Error).message });
    } finally {
      busy = false;
    }
  }
</script>

{#if !enabled}
  <!-- Passthrough banner. Hidden by default; shown in red when compression
       is off. Matches the visual weight of the legacy dashboard so operators
       glancing at the page can tell at a distance. -->
  <div class="banner">
    <strong>PASSTHROUGH MODE</strong> - compression disabled. Every /v1/messages
    forwards unchanged to upstream. No image encoding, no break-even gate, no
    transforms.
  </div>
{/if}

<div class="toggle-wrap">
  <button class="toggle" type="button" disabled={busy} on:click={toggle}>
    {busy ? 'loading…' : enabled ? 'Disable compression' : 'Enable compression'}
  </button>
  <span class="hint">runtime kill switch · not persisted across restart</span>
</div>

<style>
  .banner {
    display: inline-block;
    margin: 8px 0;
    padding: 10px 14px;
    background: #21262d;
    border: 1px solid #f85149;
    border-radius: 6px;
    color: #f85149;
    font-size: 12px;
  }
  .toggle-wrap {
    margin-bottom: 14px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .toggle {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    padding: 6px 12px;
    cursor: pointer;
    border-radius: 6px;
    font: inherit;
    font-size: 12px;
  }
  .toggle:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .hint {
    color: #6e7681;
    font-size: 11px;
  }
</style>
