import type { AdapterUsagePoint } from '@javis-dog/collector-adapters';
import { describe, expect, it } from 'vitest';
import { toUsageGroups, type CumulativeBaselines } from '../src/index.ts';

// S5b B2: cumulative baselines for Gemini CLI series (ADR-0011 rules + ADR-0016 Changes, QA
// finding G5: a new series of a known run has an implicit baseline of 0).
const point = (
  counter: AdapterUsagePoint['counter'],
  value: number,
  endNs: string,
  opts: { startNs?: string; sessionId?: string; model?: string } = {},
): AdapterUsagePoint => ({
  sessionId: opts.sessionId ?? 's1',
  model: opts.model ?? 'gemini-2.5-pro',
  counter,
  value,
  startNs: opts.startNs ?? '1000',
  endNs,
  temporality: 'cumulative',
});

describe('toUsageGroups for Gemini CLI (platform gemini-cli)', () => {
  it('counts a series that appears mid-run in full (cache deltas reach the input − cache rule)', () => {
    const baselines: CumulativeBaselines = new Map();
    expect(
      toUsageGroups(
        [point('input_tokens', 100, '2000'), point('output_tokens', 10, '2000')],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    const groups = toUsageGroups(
      [
        point('input_tokens', 700, '3000'),
        point('output_tokens', 40, '3000'),
        point('cache_read_tokens', 400, '3000'), // first seen now, same startNs as its siblings
        point('reasoning_tokens', 25, '3000'),
      ],
      baselines,
      'gemini-cli',
    );
    expect(groups).toEqual([
      {
        sessionId: 's1',
        model: 'gemini-2.5-pro',
        startNs: '1000',
        endNs: '3000',
        delta: {
          input_tokens: 600,
          output_tokens: 30,
          cache_read_tokens: 400,
          reasoning_tokens: 25,
        },
        platform: 'gemini-cli',
      },
    ]);
    // From then on the new series has a real baseline.
    const next = toUsageGroups([point('cache_read_tokens', 450, '4000')], baselines, 'gemini-cli');
    expect(next[0]!.delta).toEqual({ cache_read_tokens: 50 });
  });

  it('all series new in the same request (first export) only set baselines', () => {
    const baselines: CumulativeBaselines = new Map();
    expect(
      toUsageGroups(
        [point('input_tokens', 100, '2000'), point('cache_read_tokens', 40, '2000')],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    expect(baselines.size).toBe(2);
  });

  it('a new series whose siblings have another startNs (restart) only sets a baseline', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([point('input_tokens', 100, '2000')], baselines, 'gemini-cli');
    expect(
      toUsageGroups(
        [point('cache_read_tokens', 40, '9000', { startNs: '8000' })],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    // After a restart, the new run's series reset first; a later new series of that run counts.
    expect(
      toUsageGroups(
        [point('input_tokens', 30, '9000', { startNs: '8000' })],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
    const groups = toUsageGroups(
      [
        point('input_tokens', 50, '9500', { startNs: '8000' }),
        point('output_tokens', 7, '9500', { startNs: '8000' }),
      ],
      baselines,
      'gemini-cli',
    );
    expect(groups[0]!.delta).toEqual({ input_tokens: 20, output_tokens: 7 });
  });

  it('a new series of another session or model is not a sibling', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([point('input_tokens', 100, '2000')], baselines, 'gemini-cli');
    expect(
      toUsageGroups(
        [
          point('output_tokens', 5, '3000', { sessionId: 's2' }),
          point('output_tokens', 5, '3000', { model: 'gemini-2.5-flash' }),
        ],
        baselines,
        'gemini-cli',
      ),
    ).toEqual([]);
  });

  it('Claude Code groups keep the plain rule: a new series only sets a baseline', () => {
    const baselines: CumulativeBaselines = new Map();
    toUsageGroups([point('input_tokens', 100, '2000')], baselines);
    expect(toUsageGroups([point('output_tokens', 5, '3000')], baselines)).toEqual([]);
  });
});
