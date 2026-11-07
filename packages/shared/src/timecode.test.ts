import { describe, expect, it } from 'vitest';
import { formatTimecode, PhoneSchema } from './index.js';

describe('30 fps time positions', () => {
  it.each([
    [0, '00:00:00'],
    [29, '00:00:29'],
    [30, '00:01:00'],
    [162, '00:05:12'],
    [107999, '59:59:29'],
    [108000, '01:00:00:00'],
    [108162, '01:00:05:12'],
  ])('formats frame %i', (frame, expected) => {
    expect(formatTimecode(frame as number)).toBe(expected);
  });
  it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid position %s',
    (frame) => expect(() => formatTimecode(frame)).toThrow(),
  );
  it('rejects malformed phone numbers', () => {
    expect(PhoneSchema.safeParse('13800138000').success).toBe(true);
    for (const phone of ['12345678901', '1380013800', '+8613800138000'])
      expect(PhoneSchema.safeParse(phone).success).toBe(false);
  });
});
