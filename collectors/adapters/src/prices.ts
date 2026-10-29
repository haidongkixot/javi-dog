// Dated price table for estimated Gemini cost (ADR-0016 §4). USD per 1 000 000 tokens,
// standard on-demand tier, prompts ≤ 200k tokens; reasoning ("thinking") billed as output.
//
// Source: the text of https://cloud.google.com/vertex-ai/generative-ai/pricing, read
// 2026-10-29. Rows come only from the "Standard" tab of the "Gemini 3" and "Gemini 2.5" tables
// (not Priority, Flex/Batch, Live API, image, audio or computer-use rows), Region "Global"
// where the table has a Region column (the Gemini 2.5 table has none), column "<= 200K input
// tokens" / "<= 200K cached input tokens", text input and "Text output (response and
// reasoning)". Each row quotes the page fragment it was read from. Not listed, on purpose:
// Gemini 3 Flash Preview (its Standard row has no text output price), Gemini 3.8 Flash Cyber
// (a specialised variant; its model id is not stated), the Gemini 3.8 Live API (non-global
// only), Gemini 4 Argon (a code name, not a model id), Gemini 3.1 Pro and Gemini 3 Pro without
// "Preview" (only in the CodeMender and provisioned-throughput tables) and Gemini 2.0.
//
// Model ids: the page name lower-cased and hyphenated ("Gemini 3.5 Flash-Lite" →
// `gemini-3.5-flash-lite`; "Gemini 2.5 Flash Lite" → `gemini-2.5-flash-lite`). Matching is
// exact: no prefix, suffix or preview rule. A preview model is priced only when the page lists
// the preview itself (`gemini-3.1-pro-preview`).
//
// Date windows: "through December 31, 2026" → `validUntil: '2027-01-01'` and "Starting
// January 1, 2027" → `validFrom: '2027-01-01'`, read as UTC midnight (the page names no time
// zone). The page marks the introductory 3.6/3.7/3.8 Flash prices with "* Promotional pricing
// provided through 50% credits back on net spend on select models within a given period", so
// the estimate is the net price after the credit.

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

/** Boundary between the introductory and the later Gemini 3.6/3.7/3.8 Flash prices. */
const INTRO_END = '2027-01-01';

export const GEMINI_PRICES: PriceTable = {
  source: 'https://cloud.google.com/vertex-ai/generative-ai/pricing',
  pricedAt: '2026-10-29',
  tier: 'Standard (on-demand), Global, prompts ≤ 200k tokens',
  models: [
    // "Gemini 2.5 Pro Input (text, image, video, audio) $1.25 $2.50 $0.125 $0.25 Text output
    // (response and reasoning) $10.00 $15.00 N/A N/A"
    { model: 'gemini-2.5-pro', inputPerM: 1.25, cachedInputPerM: 0.125, outputPerM: 10 },
    // "Gemini 2.5 Flash Input (text, image, video) $0.30 $0.30 $0.03 $0.03 Audio Input $1.00
    // $0.30 $0.10 $0.10 Text output (response and reasoning) $2.50 $2.50 N/A N/A"
    { model: 'gemini-2.5-flash', inputPerM: 0.3, cachedInputPerM: 0.03, outputPerM: 2.5 },
    // "Gemini 2.5 Flash Lite Input (text, image, video) $0.10 $0.10 $0.01 $0.01 Audio Input
    // $0.30 $0.30 $0.03 $0.03 Text output (response and reasoning) $0.40 $0.40 N/A N/A"
    { model: 'gemini-2.5-flash-lite', inputPerM: 0.1, cachedInputPerM: 0.01, outputPerM: 0.4 },
    // "Gemini 3.1 Pro Preview Input (text, image, video, audio) Global $2.00 $4.00 $0.20 $0.40
    // Text output (response and reasoning) Global $12.00 $18.00 N/A N/A"
    { model: 'gemini-3.1-pro-preview', inputPerM: 2, cachedInputPerM: 0.2, outputPerM: 12 },
    // "Gemini 3.8 Flash* through December 31, 2026 Input (text, image, video, audio) Global
    // $0.75 $0.75 $0.075 $0.075 Non-global $0.825 $0.825 $0.0825 $0.0825 Text output (response
    // and reasoning) Global $3.75 $3.75 N/A N/A"
    {
      model: 'gemini-3.8-flash',
      inputPerM: 0.75,
      cachedInputPerM: 0.075,
      outputPerM: 3.75,
      validUntil: INTRO_END,
    },
    // "Gemini 3.8 Flash Starting January 1, 2027 Input (text, image, video, audio) Global $1.50
    // $1.50 $0.15 $0.15 Non-global $1.65 $1.65 $0.165 $0.165 Text output (response and
    // reasoning) Global $7.50 $7.50 N/A N/A"
    {
      model: 'gemini-3.8-flash',
      inputPerM: 1.5,
      cachedInputPerM: 0.15,
      outputPerM: 7.5,
      validFrom: INTRO_END,
    },
    // "Gemini 3.7 Flash * through December 31, 2026 Input (text, image, video, audio) Global
    // $0.75 $0.75 $0.075 $0.075 Non-global $0.825 $0.825 $0.0825 $0.0825 Text output (response
    // and reasoning) Global $3.75 $3.75 N/A N/A"
    {
      model: 'gemini-3.7-flash',
      inputPerM: 0.75,
      cachedInputPerM: 0.075,
      outputPerM: 3.75,
      validUntil: INTRO_END,
    },
    // "Gemini 3.7 Flash starting January 1, 2027 Input (text, image, video, audio) Global $1.50
    // $1.50 $0.15 $0.15 Non-global $1.65 $1.65 $0.165 $0.165 Text output (response and
    // reasoning) Global $7.50 $7.50 N/A N/A"
    {
      model: 'gemini-3.7-flash',
      inputPerM: 1.5,
      cachedInputPerM: 0.15,
      outputPerM: 7.5,
      validFrom: INTRO_END,
    },
    // "Gemini 3.6 Flash * through December 31, 2026 Input (text, image, video, audio) Global
    // $0.75 $0.75 $0.075 $0.075 Non-global $0.825 $0.825 $0.0825 $0.0825 Text output (response
    // and reasoning) Global $3.75 $3.75 N/A N/A"
    {
      model: 'gemini-3.6-flash',
      inputPerM: 0.75,
      cachedInputPerM: 0.075,
      outputPerM: 3.75,
      validUntil: INTRO_END,
    },
    // "Gemini 3.6 Flash starting January 1, 2027 Input (text, image, video, audio) Global $1.50
    // $1.50 $0.15 $0.15 Non-global $1.65 $1.65 $0.165 $0.165 Text output (response and
    // reasoning) Global $7.50 $7.50 N/A N/A"
    {
      model: 'gemini-3.6-flash',
      inputPerM: 1.5,
      cachedInputPerM: 0.15,
      outputPerM: 7.5,
      validFrom: INTRO_END,
    },
    // "Gemini 3.5 Flash Input (text, image, video, audio) Global $1.50 $1.50 $0.15 $0.15
    // Non-global * $1.65 $1.65 $0.165 $0.165 Text output (response and reasoning) Global $9.00
    // $9.00 N/A N/A"
    { model: 'gemini-3.5-flash', inputPerM: 1.5, cachedInputPerM: 0.15, outputPerM: 9 },
    // "Gemini 3.5 Flash-Lite Input (text, image, video, audio) Global $0.30 $0.30 $0.03 $0.03
    // Non-global * $0.33 $0.33 $0.033 $0.033 Text output (response and reasoning) Global $2.50
    // $2.50 N/A N/A"
    { model: 'gemini-3.5-flash-lite', inputPerM: 0.3, cachedInputPerM: 0.03, outputPerM: 2.5 },
    // "Gemini 3.1 Flash-Lite Input (text, image, video) Global $0.25 $0.25 $0.025 $0.025
    // Non-global * $0.275 $0.275 $0.0275 $0.0275 Input (audio) Global $0.50 $0.50 $0.05 $0.05
    // Non-global * $0.55 $0.55 $0.055 $0.055 Text output (response and reasoning) Global $1.50
    // $1.50 N/A N/A"
    { model: 'gemini-3.1-flash-lite', inputPerM: 0.25, cachedInputPerM: 0.025, outputPerM: 1.5 },
  ],
};

const utcMs = (isoDate: string) => Date.parse(`${isoDate}T00:00:00Z`);

/** The table row for `model` valid at `at` (exact id match), or `null`. */
export const findGeminiPrice = (
  model: string,
  at: Date,
  table: PriceTable = GEMINI_PRICES,
): ModelPrice | null => {
  const t = at.getTime();
  if (!Number.isFinite(t)) return null;
  return (
    table.models.find(
      (row) =>
        row.model === model &&
        (row.validFrom === undefined || t >= utcMs(row.validFrom)) &&
        (row.validUntil === undefined || t < utcMs(row.validUntil)),
    ) ?? null
  );
};

/**
 * Estimated USD for the counters, or `null` when the model has no price valid at `at`.
 * cost = (input × inputPerM + cache_read × cachedInputPerM + (output + reasoning) × outputPerM)
 * / 1e6, rounded to 1e-9 USD. `input_tokens` must already exclude cached tokens
 * (`geminiUsageDelta`); absent counters count as 0.
 */
export const estimateGeminiCostUsd = (
  model: string,
  counters: {
    input_tokens?: number;
    cache_read_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
  },
  at: Date,
): number | null => {
  const price = findGeminiPrice(model, at);
  if (!price) return null;
  // Σ tokens × USD per 1M tokens, i.e. USD × 1e6.
  const usdTimesMillion =
    (counters.input_tokens ?? 0) * price.inputPerM +
    (counters.cache_read_tokens ?? 0) * price.cachedInputPerM +
    ((counters.output_tokens ?? 0) + (counters.reasoning_tokens ?? 0)) * price.outputPerM;
  // USD rounded to 1e-9: round(USD × 1e9) / 1e9 = round(usdTimesMillion × 1e3) / 1e9.
  const usd = Math.round(usdTimesMillion * 1e3) / 1e9;
  // Counters are non-negative integers from `geminiUsageDelta`; anything else gets no estimate.
  return Number.isFinite(usd) && usd >= 0 ? usd : null;
};
