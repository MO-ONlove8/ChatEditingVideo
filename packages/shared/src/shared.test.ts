import { describe, expect, it } from 'vitest';
import {
  EditPlanSchema,
  JobEventSchema,
  createSseParser,
  encodeSse,
  type SseMessage,
} from './index.js';

describe('EditPlanSchema', () => {
  it('applies output defaults', () => {
    const plan = EditPlanSchema.parse({
      version: 1,
      clips: [{ source: 'a.mp4', startSec: 0, endSec: 3 }],
    });
    expect(plan.output.container).toBe('mp4');
  });

  it('rejects clips that end before they start', () => {
    const r = EditPlanSchema.safeParse({
      version: 1,
      clips: [{ source: 'a.mp4', startSec: 5, endSec: 2 }],
    });
    expect(r.success).toBe(false);
  });
});

describe('SSE', () => {
  it('round-trips events across chunk boundaries', () => {
    const got: SseMessage[] = [];
    const parser = createSseParser((m) => got.push(m));
    const wire =
      encodeSse({ type: 'progress', jobId: 'j1', progress: 50 }, 'job') +
      ': keep-alive\n\n' +
      encodeSse('line1\nline2');
    // split at an awkward point to exercise buffering
    parser.push(wire.slice(0, 17));
    parser.push(wire.slice(17));

    expect(got).toHaveLength(2);
    expect(got[0]?.event).toBe('job');
    expect(JobEventSchema.parse(JSON.parse(got[0]!.data))).toMatchObject({ progress: 50 });
    expect(got[1]?.data).toBe('line1\nline2');
  });
});
