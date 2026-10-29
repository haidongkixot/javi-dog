// Dated price table for estimated Gemini cost (ADR-0016 §4). USD per 1 000 000 tokens,
// standard on-demand tier, prompts ≤ 200k tokens; reasoning ("thinking") billed as output.

export interface ModelPrice {
  /** Gemini model id as reported in OTel `model` (lower case), e.g. `gemini-2.5-pro`. */
  model: string;
  inputPerM: number;
  cachedInputPerM: number;
  outputPerM: number;
  /** ISO dates (UTC, inclusive start / exclusive end) for introductory prices; absent = open. */
  validFrom?: string;
  validUntil?: string;
}

export interface PriceTable {
  source: string;
  /** Date the source was read (YYYY-MM-DD). */
  pricedAt: string;
  tier: string;
  models: readonly ModelPrice[];
}

export const GEMINI_PRICES: PriceTable = {
  source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
  pricedAt: '2026-10-29',
  tier: 'Standard (on-demand), Global, prompts ≤ 200k tokens',
  models: [],
};

/** Estimated USD for the counters, or `null` when the model has no price valid at `at`. */
export const estimateGeminiCostUsd = (
  _model: string,
  _counters: {
    input_tokens?: number;
    cache_read_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
  },
  _at: Date,
): number | null => {
  void [_model, _counters, _at];
  throw new Error('not implemented (S5b lane A)');
};
