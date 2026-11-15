import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openSync, type Font, type Glyph } from 'fontkit';
import { LineBreaker } from 'linebreak';
import { Resvg } from '@resvg/resvg-js';
import { validateText, type TextStyle } from '@cev/shared';

const directory = fileURLToPath(
  new URL('../../../../packages/shared/assets/fonts/', import.meta.url),
);
@Injectable()
export class LayoutService {
  private cache = new Map<
    string,
    { svg: string; x: number; y: number; width: number; height: number; lines: string[] }
  >();
  private cacheBytes = 0;
  private shapes = new Map<string, ReturnType<Font['layout']>>();
  private glyphs = new Map<string, { path: string; box: Glyph['bbox'] }>();
  private shape(text: string, font: Font, bold: boolean) {
    const key = bold + ':' + text,
      old = this.shapes.get(key);
    if (old) return old;
    const run = font.layout(text);
    this.shapes.set(key, run);
    if (this.shapes.size > 4096) this.shapes.delete(this.shapes.keys().next().value!);
    return run;
  }
  private glyph(glyph: Glyph, bold: boolean) {
    const key = bold + ':' + glyph.id,
      old = this.glyphs.get(key);
    if (old) return old;
    const value = { path: glyph.path.toSVG(), box: glyph.bbox };
    this.glyphs.set(key, value);
    if (this.glyphs.size > 2048) this.glyphs.delete(this.glyphs.keys().next().value!);
    return value;
  }
  private fonts = {
    regular: openSync(`${directory}/NotoSansCJKsc-Regular.otf`) as Font,
    bold: openSync(`${directory}/NotoSansCJKsc-Bold.otf`) as Font,
  };
  readonly fontHash = createHash('sha256')
    .update(readFileSync(`${directory}/NotoSansCJKsc-Regular.otf`))
    .update(readFileSync(`${directory}/NotoSansCJKsc-Bold.otf`))
    .digest('hex');
  text(
    text: string,
    style: TextStyle,
    canvas: { width: number; height: number },
    maxLines: number,
    raster = true,
  ) {
    const key = JSON.stringify([text, style, canvas, maxLines]),
      cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      const { svg, ...layout } = cached;
      return {
        ...layout,
        png: raster
          ? new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng()
          : Buffer.alloc(0),
      };
    }
    validateText(text, maxLines);
    const font = this.fonts[style.bold ? 'bold' : 'regular'];
    const missing = [
      ...new Set(
        Array.from(text).filter((c) => c !== '\n' && !font.hasGlyphForCodePoint(c.codePointAt(0)!)),
      ),
    ];
    if (missing.length)
      throw new Error(
        `字体缺少字符：${missing.map((c) => `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase()})`).join('、')}`,
      );
    const size = (Math.min(canvas.width, canvas.height) * style.size) / 100,
      scale = size / font.unitsPerEm;
    const stroke = (Math.min(canvas.width, canvas.height) * style.outline) / 100;
    const padding = Math.ceil(stroke + 2),
      width = Math.round((canvas.width * style.width) / 100),
      available = width - 2 * padding;
    const measure = (s: string) =>
      this.shape(s, font, style.bold).positions.reduce((n, v) => n + v.xAdvance, 0) * scale;
    const lines: string[] = [];
    for (const paragraph of text.split('\n')) {
      if (!paragraph) {
        lines.push('');
        continue;
      }
      const breaker = new LineBreaker(paragraph),
        points: number[] = [];
      let point;
      while ((point = breaker.nextBreak())) points.push(point.position);
      let start = 0,
        last = start;
      for (const end of points) {
        if (measure(paragraph.slice(start, end)) > available) {
          if (last === start) throw new Error('文字无法在文本框中换行，请缩短文字或调整样式');
          lines.push(paragraph.slice(start, last));
          start = last;
          if (measure(paragraph.slice(start, end)) > available)
            throw new Error('文字超出文本框宽度');
        }
        last = end;
      }
      lines.push(paragraph.slice(start));
    }
    if (lines.length > maxLines)
      throw new Error(`实际排版${lines.length}行，最多${maxLines}行，请缩短文字或调整样式`);
    const lineHeight = (font.ascent - font.descent + font.lineGap) * scale;
    const height = Math.ceil(lines.length * lineHeight + 2 * padding);
    const x = (canvas.width * style.x) / 100 - width / 2;
    const y =
      (canvas.height * style.y) / 100 -
      (style.anchor === 'bottom' ? height : style.anchor === 'center' ? height / 2 : 0);
    if (x < 0 || y < 0 || x + width > canvas.width || y + height > canvas.height)
      throw new Error('文字整体超出画布，请调整位置、字号或文本框');
    let paths = '';
    for (let row = 0; row < lines.length; row++) {
      const run = this.shape(lines[row]!, font, style.bold),
        lineWidth = measure(lines[row]!);
      let cursor =
        padding +
        (style.align === 'center'
          ? (available - lineWidth) / 2
          : style.align === 'right'
            ? available - lineWidth
            : 0);
      for (let i = 0; i < run.glyphs.length; i++) {
        const pos = run.positions[i]!,
          glyph = run.glyphs[i]!;
        const gx = cursor + pos.xOffset * scale,
          gy = padding + font.ascent * scale + row * lineHeight - pos.yOffset * scale;
        const data = this.glyph(glyph, style.bold),
          box = data.box;
        if (
          gx + box.minX * scale - stroke < 0 ||
          gx + box.maxX * scale + stroke > width ||
          gy - box.maxY * scale - stroke < 0 ||
          gy - box.minY * scale + stroke > height
        )
          throw new Error('文字字形或描边超出文本框');
        paths += `<path d="${data.path}" transform="translate(${gx} ${gy}) scale(${scale} ${-scale})"/>`;
        cursor += pos.xAdvance * scale;
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${style.background}" fill-opacity="${style.backgroundOpacity / 100}"/><g fill="${style.color}" opacity="${style.opacity / 100}" stroke="${style.outlineColor}" stroke-width="${stroke / scale}" stroke-linejoin="round" paint-order="stroke fill">${paths}</g></svg>`;
    this.cache.set(key, { svg, x, y, width, height, lines });
    this.cacheBytes += Buffer.byteLength(svg);
    while (this.cache.size > 2048 || this.cacheBytes > 32 * 1024 * 1024) {
      const [old, value] = this.cache.entries().next().value!;
      this.cacheBytes -= Buffer.byteLength(value.svg);
      this.cache.delete(old);
    }
    return {
      png: raster
        ? new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng()
        : Buffer.alloc(0),
      x,
      y,
      width,
      height,
      lines,
    };
  }
}
