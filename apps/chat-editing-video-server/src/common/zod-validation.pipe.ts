import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ApiErrorBody } from '@cev/shared';
import type { z } from 'zod';

/** Validates a request part (body/query/param) against a shared zod schema. */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const body: ApiErrorBody = {
      statusCode: 400,
      message: 'Validation failed',
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
    throw new BadRequestException(body);
  }
}
