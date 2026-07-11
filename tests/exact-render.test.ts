import { describe, expect, it } from 'vitest';
import {
  CELL_H,
  PAD_Y,
  renderTextToPngsExact,
} from '../src/core/render.js';

function concatSource(pages: Awaited<ReturnType<typeof renderTextToPngsExact>>): string {
  return pages.map((page) => page.sourceText).join('');
}

function concatBytes(pages: Awaited<ReturnType<typeof renderTextToPngsExact>>): number[] {
  return pages.flatMap((page) => [...page.png]);
}

describe('renderTextToPngsExact', () => {
  it('preserves leading/trailing spaces, tabs, and blank-line runs exactly', async () => {
    const source = '   leading  \n\n\n\n\tmiddle\t  \ntrailing     ';
    const pages = await renderTextToPngsExact(source, { cols: 80 });

    expect(pages).toHaveLength(1);
    expect(pages[0]!.sourceText).toBe(source);
    expect(concatSource(pages)).toBe(source);
    expect(pages.reduce((sum, page) => sum + page.charsRendered, 0)).toBe([...source].length);
    expect(pages[0]!.sourceText.startsWith('   ')).toBe(true);
    expect(pages[0]!.sourceText.endsWith('     ')).toBe(true);
    expect(pages[0]!.sourceText).toContain('\n\n\n\n');
  });

  it('segments only at codepoint boundaries and never splits surrogate pairs', async () => {
    const source = 'A😀B𐐷C';
    const oneRowHeight = 2 * PAD_Y + CELL_H;
    const pages = await renderTextToPngsExact(source, {
      cols: 1,
      maxHeightPx: oneRowHeight,
      aa: false,
    });

    expect(concatSource(pages)).toBe(source);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.sourceStart).toBeGreaterThanOrEqual(0);
      expect(page.sourceEnd).toBeGreaterThan(page.sourceStart);
      expect(source.slice(page.sourceStart, page.sourceEnd)).toBe(page.sourceText);
      expect(page.sourceText).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
  });

  it('never emits a source-empty page for a trailing newline', async () => {
    const source = 'first line\n';
    const pages = await renderTextToPngsExact(source, {
      cols: 80,
      maxHeightPx: 2 * PAD_Y + CELL_H,
      aa: false,
    });

    expect(concatSource(pages)).toBe(source);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.sourceText.length > 0)).toBe(true);
  });

  it('does not normalize canonically distinct Unicode source', async () => {
    const source = `decomposed=e\u0301\ncomposed=é\n${'界'.repeat(20)}`;
    const pages = await renderTextToPngsExact(source, {
      cols: 8,
      maxHeightPx: 2 * PAD_Y + 2 * CELL_H,
    });

    expect(concatSource(pages)).toBe(source);
    expect(concatSource(pages)).not.toBe(source.normalize('NFC'));
    expect(pages[0]!.sourceStart).toBe(0);
    expect(pages.at(-1)!.sourceEnd).toBe(source.length);
  });

  it('produces deterministic unlabeled pages without adding source text', async () => {
    const source = Array.from({ length: 30 }, (_, index) => `row ${index}    `).join('\n');
    const opts = { cols: 12, maxHeightPx: 2 * PAD_Y + 3 * CELL_H, aa: false } as const;
    const first = await renderTextToPngsExact(source, opts);
    const second = await renderTextToPngsExact(source, opts);

    expect(first.length).toBeGreaterThan(1);
    expect(concatSource(first)).toBe(source);
    expect(first.map((page) => page.sourceText)).toEqual(
      second.map((page) => page.sourceText),
    );
    expect(concatBytes(first)).toEqual(concatBytes(second));
    expect(first.every((page) => page.png.slice(0, 8).every(
      (byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index],
    ))).toBe(true);
  });

  it('reports every atlas-missing codepoint so callers can reject the bucket', async () => {
    const source = 'plain\tCR\rESC\u001b[31m max=\u{10FFFF}';
    const pages = await renderTextToPngsExact(source, { cols: 80, aa: false });
    const dropped = new Map<number, number>();
    for (const page of pages) {
      for (const [codepoint, count] of page.droppedCodepoints) {
        dropped.set(codepoint, (dropped.get(codepoint) ?? 0) + count);
      }
    }

    expect(concatSource(pages)).toBe(source);
    expect(pages.reduce((sum, page) => sum + page.droppedChars, 0)).toBe(
      [...dropped.values()].reduce((sum, count) => sum + count, 0),
    );
    expect(dropped.get(0x09)).toBe(1);
    expect(dropped.get(0x0d)).toBe(1);
    expect(dropped.get(0x1b)).toBe(1);
    expect(dropped.get(0x10ffff)).toBe(1);
  });
});
