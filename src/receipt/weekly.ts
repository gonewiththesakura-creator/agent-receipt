/**
 * Weekly report: the most expensive sessions of a window (default 7 days).
 *
 * This is the report a human actually reads to catch runaway spend: a daily
 * receipt is too noisy to review every morning, a monthly one arrives too
 * late. The weekly report answers one question — "what were the three most
 * expensive things this week, and what drove each of them?" — and nothing
 * else. All numbers come from per-session receipts built by buildReceipt();
 * this module only groups, ranks, and picks the largest cost driver.
 */
import { buildReceipt, type Receipt } from "./receipt.js";
import { groupBySession } from "../parsers/index.js";
import { totalTokens, type LogEntry } from "../types.js";

export interface WeeklySession {
  sessionId: string | undefined;
  project: string | undefined;
  agent: string;
  models: string[];
  /** Estimated cost in USD, or null when any model price is unknown. */
  costUsd: number | null;
  tokens: number;
  entryCount: number;
  /** Plain-language main cost driver, e.g. "cache rewrites $0.19 (26%)". */
  topDriver: string;
  /** The receipt this row was ranked from (kept for --out JSON). */
  receipt: Receipt;
}

export interface WeeklyReport {
  startDate: string; // YYYY-MM-DD, first day of the window (UTC dates, as in the logs)
  endDate: string; // YYYY-MM-DD, last day of the window
  days: number;
  sessionCount: number;
  /** Sum of session costs with a known price; null only when no session has a price. */
  totalCostUsd: number | null;
  /** Sessions whose cost is unknown (a model has no price in the table). */
  unknownCostSessions: number;
  totalTokens: number;
  totalCacheRewriteCostUsd: number | null;
  totalSubagentCostUsd: number | null;
  modelSwitchCount: number;
  /** Top 3 sessions by cost (fewer when the window has fewer sessions). */
  topSessions: WeeklySession[];
  /** Entries inside the window that had no usable timestamp and were excluded. */
  untimestampedEntries: number;
  skippedLines: number;
  priceTableVersion: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window bounds for `days` ending on `endDate` (inclusive, UTC dates). */
export function weeklyWindow(endDate: string, days: number): { startMs: number; endMs: number } {
  const end = new Date(`${endDate}T23:59:59.999Z`).getTime();
  const start = new Date(`${endDate}T00:00:00.000Z`).getTime() - (days - 1) * DAY_MS;
  return { startMs: start, endMs: end };
}

/** The single largest cost driver of a session receipt, in plain language. */
export function topDriverOf(r: Receipt): string {
  const total = r.costUsd;
  const share = (n: number | null): number | null =>
    total !== null && n !== null && total > 0 ? (n / total) * 100 : null;
  const switchCost = r.modelSwitches.reduce<number | null>((acc, sw) => {
    if (acc === null || sw.segmentCostUsd === null) return null;
    return acc + sw.segmentCostUsd;
  }, 0);
  const candidates: { label: string; cost: number | null }[] = [
    { label: "cache rewrites", cost: r.cacheRewriteCostUsd },
    { label: "subagents", cost: r.subagentCostUsd },
    { label: "model-switch segment", cost: switchCost },
  ];
  let best: { label: string; cost: number | null } | null = null;
  for (const c of candidates) {
    if (c.cost !== null && c.cost > 0 && (best === null || (best.cost ?? 0) < c.cost)) best = c;
  }
  if (!best || best.cost === null) return "spread across messages (no single driver)";
  const pct = share(best.cost);
  return `${best.label} $${best.cost.toFixed(4)}${pct !== null ? ` (${Math.round(pct)}%)` : ""}`;
}

export function buildWeeklyReport(
  entries: LogEntry[],
  opts: { endDate: string; days?: number; skippedLines?: number },
): WeeklyReport {
  const days = opts.days ?? 7;
  const { startMs, endMs } = weeklyWindow(opts.endDate, days);
  const inWindow: LogEntry[] = [];
  let untimestamped = 0;
  for (const e of entries) {
    if (e.timestampMs === undefined) {
      untimestamped++;
      continue;
    }
    if (e.timestampMs >= startMs && e.timestampMs <= endMs) inWindow.push(e);
  }

  const sessions = groupBySession(inWindow);
  const rows: WeeklySession[] = [];
  for (const [key, es] of sessions) {
    const receipt = buildReceipt(es, { skippedLines: 0 });
    rows.push({
      sessionId: receipt.sessionId ?? key,
      project: receipt.project,
      agent: receipt.agent,
      models: receipt.models,
      costUsd: receipt.costUsd,
      tokens: totalTokens(receipt.usage),
      entryCount: receipt.entryCount,
      topDriver: topDriverOf(receipt),
      receipt,
    });
  }
  // Rank by cost; sessions with unknown cost rank by tokens so they are
  // still visible instead of silently dropping to the bottom.
  rows.sort((a, b) => {
    if (a.costUsd !== null && b.costUsd !== null) return b.costUsd - a.costUsd;
    if (a.costUsd !== null) return -1;
    if (b.costUsd !== null) return 1;
    return b.tokens - a.tokens;
  });

  let totalCost: number | null = 0;
  let unknownCostSessions = 0;
  let totalTokensCount = 0;
  let totalRewrite: number | null = 0;
  let totalSub: number | null = 0;
  let switchCount = 0;
  for (const row of rows) {
    if (row.costUsd === null) {
      unknownCostSessions++;
    } else if (totalCost !== null) {
      totalCost += row.costUsd;
    }
    totalTokensCount += row.tokens;
    const r = row.receipt;
    if (r.cacheRewriteCostUsd === null) totalRewrite = null;
    else if (totalRewrite !== null) totalRewrite += r.cacheRewriteCostUsd;
    if (r.subagentCostUsd === null) totalSub = null;
    else if (totalSub !== null) totalSub += r.subagentCostUsd;
    switchCount += r.modelSwitches.length;
  }
  if (rows.length > 0 && rows.every((r) => r.costUsd === null)) totalCost = null;

  const startDate = new Date(startMs).toISOString().slice(0, 10);
  return {
    startDate,
    endDate: opts.endDate,
    days,
    sessionCount: rows.length,
    totalCostUsd: totalCost,
    unknownCostSessions,
    totalTokens: totalTokensCount,
    totalCacheRewriteCostUsd: totalRewrite,
    totalSubagentCostUsd: totalSub,
    modelSwitchCount: switchCount,
    topSessions: rows.slice(0, 3),
    untimestampedEntries: untimestamped,
    skippedLines: opts.skippedLines ?? 0,
    priceTableVersion: rows[0]?.receipt.priceTableVersion ?? "unknown",
  };
}
