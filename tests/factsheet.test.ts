import { describe, it, expect } from 'vitest';
import { extractFactSheetTokens, factSheetText } from '../src/core/factsheet.js';

describe('factsheet extraction', () => {
  it('captures precision-critical, hard-to-OCR tokens', () => {
    const text = [
      'Edited src/lib/__tests__/livekit-egress.test.ts and agents/transcription/agent.ts',
      'opened https://github.com/Keplogic/atlas/pull/93 at commit 6d80bd6',
      'set LIVEKIT_API_SECRET and ran with --max-tokens 64000, coverage 97.82',
    ].join('\n');
    const toks = extractFactSheetTokens(text);
    expect(toks).toContain('src/lib/__tests__/livekit-egress.test.ts');
    expect(toks).toContain('https://github.com/Keplogic/atlas/pull/93');
    expect(toks).toContain('6d80bd6');
    expect(toks).toContain('LIVEKIT_API_SECRET');
    expect(toks).toContain('--max-tokens');
    expect(toks).toContain('97.82');
  });

  it('drops substrings of longer kept tokens', () => {
    const toks = extractFactSheetTokens('see https://github.com/o/r/pull/9 in repo');
    // The bare /github.com path must collapse into the full URL.
    expect(toks).toContain('https://github.com/o/r/pull/9');
    expect(toks).not.toContain('/github.com');
  });

  it('does not flag pure-letter hex words (decade, facade)', () => {
    const toks = extractFactSheetTokens('this decade the facade was added');
    expect(toks).not.toContain('decade');
    expect(toks).not.toContain('facade');
  });

  it('is deterministic — identical input yields byte-identical output (cache stability)', () => {
    const text = 'paths /a/b/c.ts /d/e/f.ts ids 1a2b3c4 9f8e7d6 nums 12345 6789.0 FLAG_X FLAG_Y';
    expect(factSheetText(text)).toBe(factSheetText(text));
  });

  it('returns empty string when nothing notable is present', () => {
    expect(factSheetText('the quick brown fox jumps over')).toBe('');
  });

  it('caps the token budget', () => {
    const many = Array.from({ length: 200 }, (_, i) => `/dir${i}/file${i}.ts`).join(' ');
    expect(extractFactSheetTokens(many).length).toBeLessThanOrEqual(64);
  });

  it('protects short high-consequence tokens from eviction by long URLs', () => {
    // 80 long doc-URLs (well over the 64-token budget) plus a short commit SHA and a port —
    // the exact shape that silently dropped the SHA a coding agent needed off the image.
    const urls = Array.from({ length: 80 }, (_, i) =>
      `https://platform.claude.com/docs/en/build-with-claude/page-${String(i).padStart(2, '0')}-guide.md`);
    const text = [...urls.slice(0, 40), 'fix in commit 9d121ac on port 47821', ...urls.slice(40)].join('\n');
    const toks = extractFactSheetTokens(text);
    expect(toks).toContain('9d121ac');
    expect(toks).toContain('47821');
    expect(toks.length).toBeLessThanOrEqual(64);
    expect(toks.filter((t) => t.startsWith('http')).length).toBeLessThanOrEqual(8);
  });
});
