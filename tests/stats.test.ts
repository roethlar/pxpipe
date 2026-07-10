import { describe, it, expect } from 'vitest';
import { newSummary, fold, renderTextReport, summaryToJson } from '../src/stats.js';
import type { TrackEvent } from '../src/core/tracker.js';

function ev(partial: Partial<TrackEvent>): TrackEvent {
  return {
    ts: '2026-05-18T00:00:00Z',
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    duration_ms: 100,
    ...partial,
  };
}

describe('stats aggregator', () => {
  it('counts status buckets', () => {
    const s = newSummary();
    fold(s, ev({ status: 200 }));
    fold(s, ev({ status: 201 }));
    fold(s, ev({ status: 404 }));
    fold(s, ev({ status: 503 }));
    fold(s, ev({ status: 500 }));
    expect(s.total).toBe(5);
    expect(s.ok2xx).toBe(2);
    expect(s.err4xx).toBe(1);
    expect(s.err5xx).toBe(2);
  });

  it('separates compressed vs passthrough and collects skip reasons', () => {
    const s = newSummary();
    fold(s, ev({ compressed: true, orig_chars: 1000, image_bytes: 200 }));
    fold(s, ev({ compressed: true, orig_chars: 2000, image_bytes: 300 }));
    fold(s, ev({ compressed: false, reason: 'below_min_chars (50 < 2000)' }));
    fold(s, ev({ compressed: false, reason: 'below_min_chars (60 < 2000)' }));
    fold(s, ev({ compressed: false, reason: 'compress=false' }));
    expect(s.compressed).toBe(2);
    expect(s.passthrough).toBe(3);
    expect(s.origCharsTotal).toBe(3000);
    expect(s.imageBytesTotal).toBe(500);
    // Reasons keep their exact string form (parenthetical char counts and
    // all) — useful for spotting outliers without collapsing detail.
    expect(s.skipReasons.size).toBe(3);
    expect(s.skipReasons.get('below_min_chars (50 < 2000)')).toBe(1);
    expect(s.skipReasons.get('below_min_chars (60 < 2000)')).toBe(1);
    expect(s.skipReasons.get('compress=false')).toBe(1);
  });

  it('uses measured imaged chars and falls back to orig_chars only for legacy rows', () => {
    const s = newSummary();
    // Current runtime-only row: project was a rejected candidate, so none of
    // its chars may enter the rendered-char total.
    fold(s, ev({
      compressed: true,
      cwd: '/runtime-only',
      orig_chars: 20_256,
      compressed_chars: 0,
      image_count: 0,
      runtime_metadata_disposition: 'moved',
    }));
    // Current mixed row: only 1,200 of 9,000 candidate chars were imaged.
    fold(s, ev({
      compressed: true,
      cwd: '/mixed',
      orig_chars: 9_000,
      compressed_chars: 1_200,
      image_count: 1,
    }));
    // Historical row: compressed_chars did not exist, so retain orig_chars.
    fold(s, ev({ compressed: true, cwd: '/legacy', orig_chars: 800, image_count: 1 }));

    expect(s.origCharsTotal).toBe(2_000);
    expect(s.byCwd.get('/runtime-only')?.origChars).toBe(0);
    expect(s.byCwd.get('/mixed')?.origChars).toBe(1_200);
    expect(s.byCwd.get('/legacy')?.origChars).toBe(800);
  });

  it('aggregates Anthropic token usage and computes cache hit metrics', () => {
    const s = newSummary();
    fold(
      s,
      ev({
        input_tokens: 100,
        output_tokens: 10,
        cache_read_tokens: 0,
        cache_create_tokens: 5000,
      }),
    );
    fold(
      s,
      ev({
        input_tokens: 50,
        output_tokens: 5,
        cache_read_tokens: 5000,
        cache_create_tokens: 0,
      }),
    );
    fold(
      s,
      ev({
        input_tokens: 60,
        output_tokens: 6,
        cache_read_tokens: 5000,
        cache_create_tokens: 0,
      }),
    );
    // 3 events all carried usage; 2 had cache_read > 0.
    expect(s.eventsWithUsage).toBe(3);
    expect(s.cacheHitEvents).toBe(2);
    expect(s.inputTokensTotal).toBe(210);
    expect(s.outputTokensTotal).toBe(21);
    expect(s.cacheReadTokensTotal).toBe(10000);
    expect(s.cacheCreateTokensTotal).toBe(5000);
  });

  it('buckets by cwd and tracks system_sha8 reuse', () => {
    const s = newSummary();
    fold(s, ev({ cwd: '/a', system_sha8: 'aaa', orig_chars: 100, image_bytes: 20 }));
    fold(s, ev({ cwd: '/a', system_sha8: 'aaa', orig_chars: 100, image_bytes: 20 }));
    fold(s, ev({ cwd: '/b', system_sha8: 'bbb', orig_chars: 200, image_bytes: 40 }));
    expect(s.byCwd.size).toBe(2);
    expect(s.byCwd.get('/a')!.count).toBe(2);
    expect(s.byCwd.get('/a')!.origChars).toBe(200);
    expect(s.systemShaHist.get('aaa')).toBe(2);
    expect(s.systemShaHist.get('bbb')).toBe(1);
  });

  it('prefers cache_prefix_sha8, falls back historically, and ignores history image hashes', () => {
    const s = newSummary();
    fold(s, ev({
      cache_prefix_sha8: 'exact-prefix',
      system_sha8: 'old-system',
      history_image_sha8: 'old-history',
    }));
    fold(s, ev({
      cache_prefix_sha8: 'exact-prefix',
      system_sha8: 'new-system',
      history_image_sha8: 'new-history',
    }));
    fold(s, ev({
      cache_prefix_sha8: 'other-prefix',
      system_sha8: 'new-system',
      history_image_sha8: 'new-history',
    }));
    fold(s, ev({ system_sha8: 'legacy-system', history_image_sha8: 'stable-history' }));
    fold(s, ev({ history_image_sha8: 'history-only' }));

    expect([...s.systemShaHist.entries()]).toEqual([
      ['exact-prefix', 2],
      ['other-prefix', 1],
      ['legacy-system', 1],
    ]);
    expect(s.systemShaHist.has('old-system')).toBe(false);
    expect(s.systemShaHist.has('new-system')).toBe(false);
    expect(s.systemShaHist.has('history-only')).toBe(false);
    // Preserve the existing dashboard JSON field name while correcting its
    // identity semantics.
    expect(summaryToJson(s).systemShaHist).toEqual([
      ['exact-prefix', 2],
      ['other-prefix', 1],
      ['legacy-system', 1],
    ]);
  });

  it('collects unknown_static_tags across events', () => {
    const s = newSummary();
    fold(s, ev({ unknown_static_tags: ['recent_files', 'todo_list'] }));
    fold(s, ev({ unknown_static_tags: ['recent_files'] }));
    fold(s, ev({}));
    expect(s.unknownTags.get('recent_files')).toBe(2);
    expect(s.unknownTags.get('todo_list')).toBe(1);
  });

  it('renders a non-empty text report for a populated summary', () => {
    const s = newSummary();
    for (let i = 0; i < 100; i++) {
      fold(
        s,
        ev({
          compressed: true,
          orig_chars: 5000,
          image_bytes: 1000,
          input_tokens: 50,
          cache_read_tokens: i % 2 === 0 ? 4000 : 0,
          cache_create_tokens: i % 2 === 0 ? 0 : 4000,
          duration_ms: 100 + i,
          first_byte_ms: 30 + i,
          cwd: '/Users/x/code/pp',
          system_sha8: 'stable',
        }),
      );
    }
    const out = renderTextReport(s);
    expect(out).toContain('pxpipe stats');
    expect(out).toContain('compressed');
    expect(out).toContain('cache hit rate');
    expect(out).toContain('/Users/x/code/pp');
    expect(out).toContain('stable');
    expect(out).toContain(
      'top cache prefixes (cache_prefix_sha8; historical system_sha8 fallback)',
    );
    expect(out).toContain('unique prefixes: 1');
    // 50% cache hit rate by event.
    expect(out).toMatch(/cache hit rate \(by events\):\s+50.0%/);
  });
});
