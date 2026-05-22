<script lang="ts">
  // Latest rendered image preview pane. The PNG itself is served as a
  // separate route (/proxy-latest-png?t=…) so the browser caches it and we
  // don't re-send the bytes on every tick. The `meta` line in the recent
  // payload tells us when the image changed so we cache-bust correctly.

  import { recent } from '../stores/index.js';

  $: hasPreview = $recent.data?.has_preview === true;
  $: meta = $recent.data?.preview_meta ?? '';
  // ts in the URL changes whenever the meta changes, forcing a re-fetch.
  // Without this the browser would happily serve a stale 304 forever.
  $: imgUrl = hasPreview ? '/proxy-latest-png?t=' + encodeURIComponent(meta) : '';
</script>

<div class="wrap">
  {#if hasPreview}
    <div class="preview-crop">
      <img src={imgUrl} alt="latest rendered" />
    </div>
  {:else}
    <div class="sub">(none yet)</div>
  {/if}
</div>
<div class="small">{meta ? meta + ' - showing top-left at native resolution' : ''}</div>

<style>
  .wrap {
    margin-top: 0;
  }
  /* Crop is done client-side via CSS (object-position + overflow:hidden).
     The legacy dashboard pulled a separately-cropped PNG which doubled
     image traffic. The full 1466×1568 image lives on disk; we just show
     the top-left corner at native res. */
  .preview-crop {
    width: 100%;
    height: 400px;
    overflow: hidden;
    background: #fff;
    border: 1px solid #30363d;
    border-radius: 4px;
    padding: 4px;
    box-sizing: border-box;
  }
  .preview-crop img {
    display: block;
    width: auto;
    height: auto;
    max-width: none;
    image-rendering: pixelated;
  }
  .sub {
    color: #6e7681;
    font-size: 12px;
  }
  .small {
    font-size: 11px;
    color: #6e7681;
    margin-top: 8px;
  }
</style>
