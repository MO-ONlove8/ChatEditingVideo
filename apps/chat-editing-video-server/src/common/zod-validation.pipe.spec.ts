import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateProjectSchema } from '@cev/shared';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(CreateProjectSchema);

  it('returns parsed (trimmed) data', () => {
    expect(pipe.transform({ name: '  Demo  ' })).toEqual({ name: 'Demo' });
  });

  it('throws 400 with field-level issues', () => {
    try {
      pipe.transform({ name: '' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as { issues: { path: string }[] };
      expect(body.issues[0]?.path).toBe('name');
    }
  });
});
