#!/usr/bin/env node
// Variant proxy for the provenance-safe live A/B matrix (plan §7).
//
// The stock Node entrypoint deliberately exposes no per-bucket transform
// config (core defaults are the product). The matrix needs non-default cells,
// so this thin host wires createProxy with explicit per-variant overrides and
// logs TrackEvents to a JSONL file. No dashboard, loopback only.
//
//   node eval/provenance-ab/variant-proxy.mjs --variant TOOLS --port 47911 \
//        --source-dir /path/to/built/worktree --log /path/to/events.jsonl
//
// Requires `npm run build` first (imports compiled dist/ modules).
//
// OWNER GATE: this proxy exists only for the separately-authorized live
// matrix. Do not point day-to-day sessions at it.

import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createDrainTracker } from './run-evidence.mjs';

// Per-variant transform overrides (plan §7.1). Core defaults already equal the
// chosen design (project pages on; runtime tail on; tools/reminders native),
// so PROJECT_RUNTIME passes no overrides.
//
// PROJECT (runtime forced native) is NOT expressible as an option on the
// current build — the runtime tail is unconditional once its exact shape is
// recognized. Run that cell from a disposable worktree with the documented
// one-line neutralization (see README) rather than a silent config lie here.
const VARIANTS = {
  LEGACY: {},
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
const sourceDir = path.resolve(opt('source-dir', ''));

if (!(variant in VARIANTS)) {
  console.error(
    `[variant-proxy] unknown or unsupported variant "${variant}" — one of: ` +
      `${Object.keys(VARIANTS).join(', ')} (PROJECT runs from a patched worktree ` +
      `through LEGACY, see README.md)`,
  );
  process.exit(2);
}
if (!logPath) {
  console.error('[variant-proxy] --log <events.jsonl> is required');
  process.exit(2);
}
if (!opt('source-dir', '')) {
  console.error('[variant-proxy] --source-dir <built worktree> is required');
  process.exit(2);
}

const builtModule = (relative) =>
  pathToFileURL(path.join(sourceDir, 'dist', ...relative.split('/'))).href;
let createProxy;
let toTrackEvent;
try {
  ({ createProxy } = await import(builtModule('core/proxy.js')));
  ({ toTrackEvent } = await import(builtModule('core/tracker.js')));
} catch (error) {
  console.error(`[variant-proxy] cannot load built source ${sourceDir}: ${error.message}`);
  process.exit(1);
}

const appendRecord = (record) => {
  fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
};
const drainTracker = createDrainTracker({ writeRecord: appendRecord });

const handle = createProxy({
  transform: () => ({ ...VARIANTS[variant] }),
  onRequest: (e) => {
    try {
      drainTracker.complete(toTrackEvent(e));
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
      if (req.method === 'POST' && req.url === '/__pxpipe_eval/drain') {
        const completion = await drainTracker.drain();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion));
        return;
      }
      if (!drainTracker.accept()) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'evaluation proxy is draining' }));
        return;
      }
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
