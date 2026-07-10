#!/usr/bin/env node
// Variant proxy for the provenance-safe live A/B matrix (plan §7).
//
// The stock Node entrypoint deliberately exposes no per-bucket transform
// config (core defaults are the product). The matrix needs non-default cells,
// so this thin host wires createProxy with explicit per-variant overrides and
// logs TrackEvents to a JSONL file. No dashboard, loopback only.
//
//   node eval/provenance-ab/variant-proxy.mjs --variant TOOLS --port 47911 \
//        --log /path/to/events.jsonl
//
// Requires `npm run build` first (imports compiled dist/ modules).
//
// OWNER GATE: this proxy exists only for the separately-authorized live
// matrix. Do not point day-to-day sessions at it.

import fs from 'node:fs';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const { createProxy } = await import('../../dist/core/proxy.js').catch(() => {
  console.error('[variant-proxy] dist/ missing — run `npm run build` first');
  process.exit(1);
});
const { toTrackEvent } = await import('../../dist/core/tracker.js');

// Per-variant transform overrides (plan §7.1). Core defaults already equal the
// chosen design (project pages on; runtime tail on; tools/reminders native),
// so PROJECT_RUNTIME passes no overrides.
//
// PROJECT (runtime forced native) is NOT expressible as an option on the
// current build — the runtime tail is unconditional once its exact shape is
// recognized. Run that cell from a disposable worktree with the documented
// one-line neutralization (see README) rather than a silent config lie here.
const VARIANTS = {
  OFF: { compress: false },
  PROJECT_RUNTIME: {},
  TOOLS: { compressProjectGuidance: false, compressTools: true },
  BOTH: { compressTools: true },
};

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const variant = opt('variant', '');
const port = Number(opt('port', '47911'));
const logPath = opt('log', '');

if (!(variant in VARIANTS)) {
  console.error(
    `[variant-proxy] unknown or unsupported variant "${variant}" — one of: ` +
      `${Object.keys(VARIANTS).join(', ')} (LEGACY and PROJECT run from pinned/` +
      `patched worktrees, see README.md)`,
  );
  process.exit(2);
}
if (!logPath) {
  console.error('[variant-proxy] --log <events.jsonl> is required');
  process.exit(2);
}

const handle = createProxy({
  transform: () => ({ ...VARIANTS[variant] }),
  onRequest: (e) => {
    try {
      fs.appendFileSync(logPath, `${JSON.stringify(toTrackEvent(e))}\n`);
    } catch (err) {
      console.error(`[variant-proxy] event write failed: ${err.message}`);
    }
  },
});

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const url = `http://127.0.0.1:${port}${req.url ?? '/'}`;
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const webReq = new Request(url, {
        method: req.method,
        headers: req.headers,
        ...(body !== undefined ? { body, duplex: 'half' } : {}),
      });
      const webRes = await handle(webReq);
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
      if (webRes.body) Readable.fromWeb(webRes.body).pipe(res);
      else res.end();
    } catch (err) {
      console.error('[variant-proxy] handler error:', err);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[variant-proxy] variant=${variant} listening on http://127.0.0.1:${port}`);
  console.log(`[variant-proxy] events → ${logPath}`);
});
