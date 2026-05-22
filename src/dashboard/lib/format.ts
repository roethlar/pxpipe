// Number / size / time formatters. Identical output to the legacy dashboard
// so visual regression is a non-issue.

export function numFmt(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString();
}

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '-';
  return String(iso).replace('T', ' ').slice(0, 19);
}

export function formatDuration(s: number): string {
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (h ? h + 'h ' : '') + (m || h ? m + 'm ' : '') + sec + 's';
}

export function shortPath(p: string | null | undefined): string {
  if (!p) return '-';
  const parts = String(p).split('/');
  return parts[parts.length - 1] || p;
}

// Rounding helpers used by the savings math panels — the headline tokens
// number is rounded to whole tokens, the dollar number to four decimal places.
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// HTML-escape for the few places we interpolate operator-provided strings
// (session ids, project paths) into rendered markup. Svelte's `{value}` form
// already escapes, but anchor titles / attribute interpolations through `{@html}`
// would not.
export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}
