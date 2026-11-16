import { cacheWriteCost, priceFor } from "../pricing/prices.js";
import { totalTokens, CACHE_TTL_MS_DEFAULT, type LogEntry } from "../types.js";

export interface ResumeForecast {
  sessionId: string | undefined;
  model: string | undefined;
  lastActivity: string | undefined;
  /** Tokens in the context that would need re-caching on resume. */
  contextTokens: number;
  /** Minutes since the last activity, if timestamps are known. */
  idleMinutes: number | null;
  cacheExpired: boolean | null;
  /** Estimated resume cost in USD, or null if the model price is unknown. */
  estimatedResumeCostUsd: number | null;
  /** Same cost expressed as cache-read cost while the cache is still warm, for contrast. */
  warmCacheCostUsd: number | null;
  warning: string | null;
  recommendation: string;
}

/**
 * Estimate what resuming a session will cost, before the user resumes it.
 *
 * The context that must be re-cached is approximated from the last entry's
 * token totals (input + cache read + cache write). If the cache TTL has
 * expired since the last activity, the whole context is re-written at the
 * cache-write price; if it is still warm, only a cache read is charged.
 * This is an estimate, not a bill — the real cost depends on the vendor's
 * cache behaviour, which we do not control.
 */
export function forecastResume(
  entries: LogEntry[],
  opts: { cacheTtlMs?: number; nowMs?: number } = {},
): ResumeForecast | null {
  if (entries.length === 0) return null;
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS_DEFAULT;
  const nowMs = opts.nowMs ?? Date.now();
  const last = entries[entries.length - 1];
  // Context size: tokens the model must hold to continue this session.
  const contextTokens =
    last.usage.input + last.usage.cacheRead + last.usage.cacheWrite + last.usage.output;
  // A better proxy when the log has many entries: the running context is
  // roughly the last entry's totals, since each message re-sends context.
  // Use the maximum single-entry total across the session as the context.
  let maxEntryTokens = contextTokens;
  for (const e of entries) maxEntryTokens = Math.max(maxEntryTokens, totalTokens(e.usage));
  const context = maxEntryTokens;

  const lastMs = last.timestampMs;
  const idleMinutes = lastMs !== undefined ? Math.max(0, (nowMs - lastMs) / 60000) : null;
  const cacheExpired = idleMinutes === null ? null : idleMinutes * 60000 > ttl;

  const estimatedResumeCostUsd = cacheExpired
    ? cacheWriteCost(last.model, context)
    : cacheWriteCost(last.model, context); // same formula; the difference is warm vs cold below
  const p = priceFor(last.model);
  const warmCacheCostUsd =
    p && cacheExpired === false ? (context * p.cacheRead) / 1_000_000 : null;
  // If the cache has expired, the resume pays the full cache-write price.
  // If it is still warm, the resume pays roughly the cache-read price.
  const resumeCost = cacheExpired === false ? warmCacheCostUsd : estimatedResumeCostUsd;

  let warning: string | null = null;
  if (cacheExpired === true) {
    warning =
      `Cache TTL (${Math.round(ttl / 60000)} min) has expired since the last activity ` +
      `(${idleMinutes !== null ? Math.round(idleMinutes) : "?"} min idle). ` +
      `Resuming will re-write the full context at the cache-write price.`;
  } else if (cacheExpired === false) {
    warning = null;
  } else {
    warning = "No timestamps in this log, so cache expiry cannot be determined.";
  }

  return {
    sessionId: last.sessionId,
    model: last.model,
    lastActivity: last.timestamp,
    contextTokens: context,
    idleMinutes: idleMinutes === null ? null : Math.round(idleMinutes),
    cacheExpired,
    estimatedResumeCostUsd: resumeCost,
    warmCacheCostUsd,
    warning,
    recommendation:
      cacheExpired === true
        ? "Compact or summarise the session before resuming, or resume sooner next time — the rewrite is charged before any new work happens."
        : "Cache is still warm; resuming now should be cheap. If you wait past the TTL, expect a full cache rewrite.",
  };
}
