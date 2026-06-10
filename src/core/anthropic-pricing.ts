/**
 * v0.28: Anthropic model pricing constants for the dream-cycle budget meter.
 *
 * Prices in USD per 1M tokens (input | output). Numbers reflect Anthropic's
 * published pricing as of 2026-05-01. Update when Anthropic publishes new
 * pricing — the JSON in `~/.gbrain/audit/dream-budget-*.jsonl` carries the
 * snapshot per call so historical estimates stay reproducible.
 *
 * Codex P1 #10 fold: non-Anthropic models (gemini, gpt, anything not in
 * this map) bypass the budget gate with a `BUDGET_METER_NO_PRICING` warn
 * once per process. The cycle still runs unbounded for those models.
 * Future: per-provider pricing modules.
 */

export interface ModelPricing {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
}

/** Map of Anthropic model id → pricing. Aliases (opus/sonnet/haiku) resolve via DEFAULT_ALIASES. */
export const ANTHROPIC_PRICING: Record<string, ModelPricing> = {
  // Claude 4.7 generation (current)
  // Opus 4.7 dropped from $15/$75 (Opus 4) to $5/$25 per
  // https://platform.claude.com/docs/en/about-claude/models/overview (verified 2026-05-10).
  'claude-opus-4-7':            { input:  5.00, output: 25.00 },
  'claude-sonnet-4-6':          { input:  3.00, output: 15.00 },
  'claude-haiku-4-5-20251001':  { input:  1.00, output:  5.00 },
  // Older but still frequently aliased
  'claude-opus-4-6':            { input:  5.00, output: 25.00 },
  'claude-3-5-sonnet-20241022': { input:  3.00, output: 15.00 },
  'claude-3-5-haiku-20241022':  { input:  0.80, output:  4.00 },
  // KoA omniroute virtual models (route via local omniroute :20128). Priced so
  // the BudgetTracker can enforce --max-cost; koa-claude-synth -> sonnet-class,
  // koa-default -> adaptive (conservative mid estimate). Added 2026-06-04.
  'koa-claude-synth':           { input:  3.00, output: 15.00 },
  'koa-default':                { input:  1.50, output:  7.50 },
  // koa-gbrain -> free-first combo (gemini free -> claude-haiku -> ce/gpt-5.4-mini).
  // Low estimate reflects free/cheap lead; budget meter stays conservative. Added 2026-06-05.
  'koa-gbrain':                 { input:  0.30, output:  1.20 },
  // koa-gbrain-reasoning -> ce/claude-sonnet (Codex Everywhere @ ~6% of official price) lead -> ce/gpt-5.4-mini (@3%) -> free gemini insurance.
  // Priced at the CE discount (6% of sonnet's 3.00/15.00) so the budget meter reflects real spend.
  'koa-gbrain-reasoning':       { input:  0.18, output:  0.90 },
  // cos OmniRoute taxonomy combos (combos.koa.json). Estimates reflect each combo's
  // lead model so the budget meter works; actual cost is lower when free tiers serve. 2026-06-05.
  'koa-floor':                  { input:  0.20, output:  0.80 },
  'koa-fast':                   { input:  0.20, output:  0.80 },
  'koa-judge':                  { input:  0.20, output:  0.80 },
  'koa-smart':                  { input:  0.40, output:  1.60 },
  'koa-code':                   { input:  1.00, output:  4.00 },
  'koa-claude-haiku-resilient': { input:  0.80, output:  4.00 },
  'koa-claude-sonnet-resilient':{ input:  3.00, output: 15.00 },
  'koa-claude-opus-resilient':  { input:  5.00, output: 25.00 },
};

import { splitProviderModelId } from './model-id.ts';

/**
 * Estimate the upper-bound USD cost of a single submit.
 * Uses (estimatedInputTokens × inputRate) + (maxOutputTokens × outputRate).
 * The maxOutputTokens upper-bounds the output cost — actual completions
 * usually return less.
 *
 * Returns null when the model isn't in the pricing map. Callers warn-once
 * and treat as zero-cost (the cycle runs unbounded for that submit).
 *
 * Accepts bare (`claude-opus-4-7`), colon-prefixed (`anthropic:claude-opus-4-7`),
 * and slash-prefixed (`anthropic/claude-opus-4-7`) ids. Routes through
 * `splitProviderModelId` so the slash-form (which arrives via CLI `--judge-model`
 * and OpenRouter recipe lists) hits the pricing table. Pre-v0.41.21.0 the inline
 * `:`-only split missed slash form → BudgetTracker no_pricing hard-fail with
 * `--max-cost N` (closes #1540).
 */
export function estimateMaxCostUsd(
  modelId: string,
  estimatedInputTokens: number,
  maxOutputTokens: number,
): number | null {
  let p: ModelPricing | undefined = ANTHROPIC_PRICING[modelId];
  if (!p) {
    const { model: tail } = splitProviderModelId(modelId);
    if (tail) p = ANTHROPIC_PRICING[tail];
  }
  if (!p) return null;
  return (
    (estimatedInputTokens / 1_000_000) * p.input +
    (maxOutputTokens     / 1_000_000) * p.output
  );
}
