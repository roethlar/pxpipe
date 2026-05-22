<script lang="ts">
  // Bottom-right toast tray. Subscribes to the toast store and renders
  // up to N visible items. Each toast carries its own timeout (set by the
  // store) so we don't need a timer here.

  import { toasts } from '../stores/index.js';
</script>

<div class="tray">
  {#each $toasts as t (t.id)}
    <div class="toast {t.level}">
      <span>{t.text}</span>
      <button type="button" on:click={() => toasts.dismiss(t.id)} aria-label="dismiss">×</button>
    </div>
  {/each}
</div>

<style>
  .tray {
    position: fixed;
    bottom: 16px;
    right: 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 1000;
    pointer-events: none;
  }
  .toast {
    background: #21262d;
    color: #c9d1d9;
    border: 1px solid #30363d;
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 12px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    display: flex;
    align-items: center;
    gap: 12px;
    pointer-events: auto;
    max-width: 360px;
  }
  .toast.error {
    border-color: #f85149;
    color: #f85149;
  }
  .toast.warn {
    border-color: #d29922;
    color: #d29922;
  }
  .toast.info {
    border-color: #58a6ff;
  }
  button {
    background: transparent;
    color: inherit;
    border: 0;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0;
  }
</style>
