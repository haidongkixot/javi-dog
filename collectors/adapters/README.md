# JD-C02 · `@javis-dog/collector-adapters` — platform adapters for `javi`

Status: **in-progress** (S5b). Pure functions that turn Gemini CLI (and, in S5c, Codex CLI) signals into JGR records for the `javi` collector (JD-C01). No I/O; JD-C01 owns settings files, state, spool, receiver and delivery. Decision: [ADR-0016](../../docs/adr/0016-gemini-and-codex-collectors.md).

| Export                                                                                 | Contract                                                                                             |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `mapGeminiHook(raw, ctx)`                                                              | Gemini hook stdin → JGR record or `null` (allowlist; prompts, responses, tool I/O, paths never read) |
| `parseGeminiMetrics(body)`                                                             | OTLP/HTTP JSON → usage points from `gemini_cli.token.usage` only (`session.id`, `model`, `type`)     |
| `geminiUsageDelta(delta, model, at)`                                                   | Final counters: input − cache (clamped), estimated cost from the price table                         |
| `GEMINI_PRICES`, `estimateGeminiCostUsd(model, counters, at)`                          | Dated Vertex AI price table (USD per 1M tokens) and estimate, `null` for unknown models              |
| `GEMINI_HOOK_EVENTS`, `GEMINI_PLATFORM`, `GEMINI_THREAD_PREFIX`, `GEMINI_TOKEN_METRIC` | Constants                                                                                            |
