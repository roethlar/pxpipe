#!/usr/bin/env node
// Tiny shim: just runs the bundled Node entry. Real CLI logic lives in src/node.ts.
import('../dist/node.js').catch((err) => {
  console.error('[pxpipe] failed to start:', err);
  console.error('[pxpipe] did you forget to `npx -y -p pnpm@10.21.0 pnpm run build`?');
  process.exit(1);
});
