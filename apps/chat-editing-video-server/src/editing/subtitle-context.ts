import type { Timeline } from '@cev/shared';

/** Keep collection operations small while retaining exact identities for refs. */
export function subtitleContext(t: Timeline, text: string, playhead: number, selectedId?: string) {
  const all = [...(t.packaging?.subtitles ?? [])].sort(
    (a, b) => a.startFrame - b.startFrame || a.number - b.number,
  );
  const numbers = new Set([...text.matchAll(/\bS(\d+)\b/gi)].map((m) => Number(m[1])));
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const ordinal = /第\s*(\d+|[一二三四五六七八九十]+)\s*条/.exec(text)?.[1];
  const ordinalNumber = ordinal
    ? /^\d+$/.test(ordinal)
      ? Number(ordinal)
      : ordinal.includes('十')
        ? (digits[ordinal.split('十')[0]!] ?? 1) * 10 + (digits[ordinal.split('十')[1]!] ?? 0)
        : digits[ordinal]
    : undefined;
  const relevant = all
    .map((s, i) => ({ ...s, label: 'S' + s.number, ordinal: i + 1 }))
    .filter(
      (s, i) =>
        i < 5 ||
        s.id === selectedId ||
        numbers.has(s.number) ||
        s.ordinal === ordinalNumber ||
        (s.startFrame <= playhead && s.endFrame >= playhead),
    );
  return { total: all.length, items: relevant };
}
