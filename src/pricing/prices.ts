/**
 * Versioned pricing table.
 *
 * Prices are per 1,000,000 tokens, in USD.
 *
 * IMPORTANT — honesty note: these are the published list prices as
 * understood in November 2026 (Anthropic Claude and OpenAI model
 * pricing pages). Prices change, and the exact model ids in a user's
 * logs may not match this table. `priceFor()` returns null for an
 * unknown model instead of guessing: in that case the receipt reports
 * token counts only and says the price is unknown.
 *
 * Dollar figures produced from this table are ALWAYS estimates at
 * published list prices, not your invoice. Never present them as a
 * bill. See README.md "Honest limits".
 */
export interface ModelPrices {
  /** Fresh (uncached) input tokens. */
  input: number;
  /** Cache-write (creating a new cache entry) tokens. */
  cacheWrite: number;
  /** Cache-read (cache hit) tokens. */
  cacheRead: number;
  /** Output tokens. */
  output: number;
}

export const PRICE_TABLE_VERSION = "2026-11-09";
export const PRICE_TABLE_SOURCE =
  "Anthropic and OpenAI published list prices, as known November 2026. " +
  "Verify against the vendor pricing page before relying on any figure.";

/** Prefix-matched, in order. First match wins. */
const TABLE: Array<{ prefix: string; prices: ModelPrices }> = [
  // Claude family (Anthropic). Cache write 5m TTL; 1h TTL costs more.
  { prefix: "claude-opus-4", prices: { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 } },
  { prefix: "claude-opus", prices: { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 } },
  { prefix: "claude-sonnet-4", prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } },
  { prefix: "claude-sonnet", prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } },
  { prefix: "claude-haiku-4", prices: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } },
  { prefix: "claude-haiku", prices: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } },
  // Codex / OpenAI family. Cached input is the cache-read price.
  { prefix: "gpt-6", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  { prefix: "gpt-5-codex", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  { prefix: "gpt-5", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  { prefix: "gpt-4", prices: { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 10 } },
  { prefix: "codex", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
];

export function priceFor(model: string | undefined): ModelPrices | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const entry of TABLE) {
    if (lower.startsWith(entry.prefix)) return entry.prices;
  }
  return null;
}

/** Cost in USD for one usage record, or null if the model price is unknown. */
export function costOf(
  model: string | undefined,
  usage: { input: number; cacheWrite: number; cacheRead: number; output: number },
): number | null {
  const p = priceFor(model);
  if (!p) return null;
  const perMillion = 1_000_000;
  return (
    (usage.input * p.input +
      usage.cacheWrite * p.cacheWrite +
      usage.cacheRead * p.cacheRead +
      usage.output * p.output) /
    perMillion
  );
}

/** Cache-write-only cost (used by the resume forecast). Null if price unknown. */
export function cacheWriteCost(model: string | undefined, tokens: number): number | null {
  const p = priceFor(model);
  if (!p) return null;
  return (tokens * p.cacheWrite) / 1_000_000;
}
