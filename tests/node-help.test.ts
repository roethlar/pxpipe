import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tsxCli = require.resolve('tsx/cli');

function proxyHelp(): string {
  return execFileSync(
    process.execPath,
    [tsxCli, path.join(repoRoot, 'src', 'node.ts'), '--help'],
    { cwd: repoRoot, encoding: 'utf8' },
  );
}

describe('proxy CLI public contract', () => {
  it('describes only the current same-container Anthropic compression paths', () => {
    const help = proxyHelp();
    expect(help).toContain('only eligible Anthropic project guidance and safe prose');
    expect(help).toContain('inside successful tool results');
    expect(help).toContain('in their original containers');
    expect(help).toContain('OpenAI-compatible requests pass through unchanged');
    expect(help).not.toContain('compresses eligible tools, schemas, reminders');
    expect(help).not.toContain('system prompt');
    expect(help).not.toContain('and history');
  });

  it('does not advertise the rejected per-run OpenAI setup or old raw capture', () => {
    const help = proxyHelp();
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'node.ts'), 'utf8');
    const bin = fs.readFileSync(path.join(repoRoot, 'bin', 'cli.js'), 'utf8');
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      keywords?: string[];
    };
    expect(help).not.toContain('OPENAI_BASE_URL=http://127.0.0.1');
    expect(source).not.toContain('captured request context');
    expect(help).toContain('not request or error bodies');
    expect(bin).toContain('pnpm@10.21.0');
    expect(bin).not.toContain('`npm run build`');
    expect(pkg.keywords).not.toContain('cloudflare-workers');
  });

  it('marks OpenAI renderer profiles and old live demos as inactive', () => {
    const profiles = fs.readFileSync(
      path.join(repoRoot, 'docs', 'MODEL_RENDER_PROFILES.md'),
      'utf8',
    );
    const sizing = fs.readFileSync(path.join(repoRoot, 'docs', 'RENDER_SIZING.md'), 'utf8');
    expect(profiles).toContain('They cannot enable proxy compression');
    expect(profiles).toContain('current proxy does not invoke either profile');
    expect(profiles).not.toContain("PXPIPE_MODELS='claude-fable-5,gpt-5.6-sol'");
    expect(sizing).toContain('OpenAI proxy requests do not invoke them');

    for (const rel of [
      'demo/README.md',
      'demo/cost-ab/README.md',
      'demo/effective-context/README.md',
    ]) {
      const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
      expect(text).toContain('Pre-correction historical material');
      expect(text).toContain('do not run');
    }
  });
});
