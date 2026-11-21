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
 * Last verified 2026-11-20 against:
 *   - https://platform.claude.com/docs/en/about-claude/pricing
 *   - https://platform.openai.com/docs/pricing
 *   - https://ai.google.dev/gemini-api/docs/pricing
 * That check added the Gemini rows below. The Claude check found the
 * table was 3x too high for Claude Opus 4.5–4.8 (the old `claude-opus-4`
 * prefix priced them at Opus 4.1 rates) and was missing every Claude
 * 5-family, Fable and Mythos model, so those sessions reported tokens
 * only. Both are fixed below.
 *
 * Gemini rows (Standard paid tier, per 1M tokens, verified 2026-11-20):
 *   - gemini-3.8-flash and gemini-3.6-flash: $0.75 in / $3.75 out /
 *     $0.075 cached through 2026-12-31; $1.50 / $7.50 / $0.15 from
 *     2027-01-01. The table uses the through-2026-12-31 rates.
 *   - gemini-3.5-flash-lite: $0.30 / $2.50 / $0.03 (no expiry note).
 *   - gemini-2.5-pro: $1.25 / $10.00 / $0.125 for prompts <= 200k
 *     tokens; above 200k it is $2.50 / $15.00 / $0.25. The table uses
 *     the <= 200k rate: a long-prompt session may be understated, and
 *     the receipt still says "estimate at list prices". Deprecated:
 *     from 2026-12-01 requests route to gemini-3.8-flash.
 *   - gemini-2.5-flash: $0.30 / $2.50 / $0.03. Deprecated: from
 *     2026-12-01 requests route to gemini-3.5-flash-lite.
 *   - gemini-2.5-flash-lite: $0.10 / $0.40 / $0.01.
 *   - cacheWrite is 0 for every Gemini row: Gemini has no per-token
 *     cache-write charge (cache storage is billed per hour, which a
 *     receipt cannot attribute per request), so there is nothing to
 *     charge here — the parser never reports cacheWrite for Gemini.
 *   - "gemini-2.5-flash-lite" must stay before "gemini-2.5-flash" in
 *     the table or prefix matching would price it as Flash.
 *   - No generic "gemini" fallback: an unlisted Gemini model stays
 *     tokens-only rather than guessed from a family price.
 *
 * Deliberately NOT priced:
 *   - Claude Haiku 5.5: its price depends on prompt length (up to
 *     100k tokens vs over 100k), which a receipt cannot attribute per
 *     request, so it stays tokens-only rather than guessed.
 *   - Claude Sonnet 5 input/output are derived from the same page's
 *     Batch table (batch is a flat 50% discount: $1/$5 batch implies
 *     $2/$10 standard); the cache columns come from its main row.
 *   - GPT-5 / GPT-5-Codex rows were not visible on the OpenAI pricing
 *     page at verification time, so their earlier entries are unchanged
 *     and still carry the old version's uncertainty.
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

export const PRICE_TABLE_VERSION = "2026-11-20";
export const PRICE_TABLE_SOURCE =
  "Anthropic, OpenAI, and Google published list prices, verified 2026-11-20 against " +
  "platform.claude.com/docs/en/about-claude/pricing, " +
  "platform.openai.com/docs/pricing, and " +
  "ai.google.dev/gemini-api/docs/pricing. Verify against the vendor pricing page " +
  "before relying on any figure.";

/**
 * Prefixes that must never fall through to a family price: their price
 * depends on something a receipt cannot see, so guessing would be worse
 * than reporting tokens only. Checked before TABLE in priceFor().
 */
const UNPRICED_PREFIXES = [
  // Haiku 5.5: $0.10/$0.50 per 1M for prompts up to 100k tokens,
  // $0.50/$2.50 above that. The receipt does not track prompt length
  // per request, so no single price is correct.
  "claude-haiku-5-5",
];

/** Prefix-matched, in order. First match wins. */
const TABLE: Array<{ prefix: string; prices: ModelPrices }> = [
  // Claude family (Anthropic). Cache write 5m TTL; 1h TTL costs more.
  // Opus 5.5's cache read is 0.05x input ($0.20), not the usual 0.1x.
  { prefix: "claude-opus-5-5", prices: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 } },
  { prefix: "claude-opus-5", prices: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
  // Opus 4.5–4.8 dropped to $5/$25; Opus 4 / 4.1 stay at $15/$75 below.
  // These must come before "claude-opus-4" or they would be priced 3x high.
  { prefix: "claude-opus-4-8", prices: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
  { prefix: "claude-opus-4-7", prices: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
  { prefix: "claude-opus-4-6", prices: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
  { prefix: "claude-opus-4-5", prices: { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 } },
  { prefix: "claude-opus-4", prices: { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 } },
  { prefix: "claude-opus", prices: { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 } },
  { prefix: "claude-sonnet-5-5", prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 } },
  { prefix: "claude-sonnet-5", prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 } },
  { prefix: "claude-sonnet-4", prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } },
  { prefix: "claude-sonnet", prices: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 } },
  { prefix: "claude-haiku-4", prices: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } },
  { prefix: "claude-haiku", prices: { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } },
  // Fable / Mythos: cache read is 0.025x input, except Fable/Mythos 5 (0.1x).
  { prefix: "claude-fable-5-2", prices: { input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 } },
  { prefix: "claude-fable-5-1", prices: { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 } },
  { prefix: "claude-fable-5", prices: { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 } },
  { prefix: "claude-mythos-5-2", prices: { input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 } },
  { prefix: "claude-mythos-5-1", prices: { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 } },
  { prefix: "claude-mythos-5", prices: { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 } },
  // Codex / OpenAI family. Cached input is the cache-read price.
  // GPT-6 variants verified 2026-11-19; the generic gpt-6 / gpt-5 / gpt-4
  // entries below are unchanged from the previous table version.
  { prefix: "gpt-6.2-astra", prices: { input: 8, cacheWrite: 10, cacheRead: 0.4, output: 40 } },
  { prefix: "gpt-6.2-sol", prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 } },
  { prefix: "gpt-6-astra", prices: { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 } },
  { prefix: "gpt-6.1-sol", prices: { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 } },
  { prefix: "gpt-6-cyber", prices: { input: 20, cacheWrite: 25, cacheRead: 2, output: 100 } },
  { prefix: "gpt-6-rosalind", prices: { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 } },
  { prefix: "gpt-6", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  { prefix: "gpt-5-codex", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  { prefix: "gpt-5", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  { prefix: "gpt-4", prices: { input: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 10 } },
  { prefix: "codex", prices: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.125, output: 10 } },
  // Gemini family (Google). Cache write is 0: no per-token charge (see header).
  // Order matters: "gemini-2.5-flash-lite" before "gemini-2.5-flash".
  { prefix: "gemini-3.8-flash", prices: { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 3.75 } },
  { prefix: "gemini-3.6-flash", prices: { input: 0.75, cacheWrite: 0, cacheRead: 0.075, output: 3.75 } },
  { prefix: "gemini-3.5-flash-lite", prices: { input: 0.3, cacheWrite: 0, cacheRead: 0.03, output: 2.5 } },
  { prefix: "gemini-2.5-pro", prices: { input: 1.25, cacheWrite: 0, cacheRead: 0.125, output: 10 } },
  { prefix: "gemini-2.5-flash-lite", prices: { input: 0.1, cacheWrite: 0, cacheRead: 0.01, output: 0.4 } },
  { prefix: "gemini-2.5-flash", prices: { input: 0.3, cacheWrite: 0, cacheRead: 0.03, output: 2.5 } },
];

export function priceFor(model: string | undefined): ModelPrices | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  // Never guess from a family fallback for these: their price depends on
  // something the receipt cannot see (e.g. Haiku 5.5's prompt-length tier).
  for (const prefix of UNPRICED_PREFIXES) {
    if (lower.startsWith(prefix)) return null;
  }
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
