import { costOf, PRICE_TABLE_VERSION } from "../pricing/prices.js";
import {
  addUsage,
  emptyUsage,
  totalTokens,
  CACHE_TTL_MS_DEFAULT,
  type LogEntry,
  type ModelSwitch,
  type Usage,
} from "../types.js";

export interface Receipt {
  agent: string;
  sessionId: string | undefined;
  project: string | undefined;
  models: string[];
  startTime: string | undefined;
  endTime: string | undefined;
  entryCount: number;
  skippedLines: number;
  usage: Usage;
  /** Estimated cost in USD, or null when any model price is unknown. */
  costUsd: number | null;
  costByModel: Record<string, { usage: Usage; costUsd: number | null; tokens: number }>;
  /** Cache-rewrite cost: cache-write tokens on entries after the first, or after a >TTL gap. */
  cacheRewriteTokens: number;
  cacheRewriteCostUsd: number | null;
  cacheRewriteCount: number;
  /** Cost attributable to subagent / sidechain entries. */
  subagentUsage: Usage;
  subagentCostUsd: number | null;
  /** Cost of entries that look like a session resume (first entry after a >TTL gap with cache write). */
  resumeCostUsd: number | null;
  resumeCount: number;
  modelSwitches: ModelSwitch[];
  /** Tokens used inside the current 5-hour window (from the last entry backwards). */
  fiveHourWindowTokens: number;
  /** Plain-language explanations, at most 3. */
  whyExpensive: string[];
  unknownPriceModels: string[];
  priceTableVersion: string;
  estimateNote: string;
}

const ESTIMATE_NOTE =
  "Estimate at published list prices, not your invoice. " +
  "Subscription quota is shown in tokens / 5h-window share, never as dollars.";

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

export function buildReceipt(
  entries: LogEntry[],
  opts: { skippedLines?: number; cacheTtlMs?: number } = {},
): Receipt {
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS_DEFAULT;
  const usage = emptyUsage();
  const subagentUsage = emptyUsage();
  const costByModel: Receipt["costByModel"] = {};
  const unknownPriceModels = new Set<string>();
  let costUsd: number | null = 0;
  let subagentCostUsd: number | null = 0;
  let cacheRewriteTokens = 0;
  let cacheRewriteCostUsd: number | null = 0;
  let cacheRewriteCount = 0;
  let resumeCostUsd: number | null = 0;
  let resumeCount = 0;
  const models = new Set<string>();
  const switches: ModelSwitch[] = [];

  // Model switches + per-model aggregation.
  let prevModel: string | undefined;
  let segmentStart = 0;
  const segments: Array<{ from: number; to: number; model: string | undefined }> = [];
  entries.forEach((e, i) => {
    if (e.model) models.add(e.model);
    if (i > 0 && e.model && prevModel && e.model !== prevModel) {
      switches.push({
        index: i,
        timestamp: e.timestamp,
        fromModel: prevModel,
        toModel: e.model,
        segmentCostUsd: null, // filled below
        segmentTokens: 0,
      });
      segments.push({ from: segmentStart, to: i, model: prevModel });
      segmentStart = i;
    }
    prevModel = e.model ?? prevModel;
  });
  segments.push({ from: segmentStart, to: entries.length, model: prevModel });

  entries.forEach((e, i) => {
    // Totals.
    const u = e.usage;
    usage.input += u.input;
    usage.output += u.output;
    usage.cacheWrite += u.cacheWrite;
    usage.cacheRead += u.cacheRead;

    const c = costOf(e.model, u);
    if (c === null) {
      costUsd = null;
      if (e.model) unknownPriceModels.add(e.model);
    } else if (costUsd !== null) {
      costUsd += c;
    }

    const key = e.model ?? "(unknown model)";
    const byModel = costByModel[key] ?? {
      usage: emptyUsage(),
      costUsd: 0 as number | null,
      tokens: 0,
    };
    byModel.usage = addUsage(byModel.usage, u);
    byModel.tokens += totalTokens(u);
    if (c === null) byModel.costUsd = null;
    else if (byModel.costUsd !== null) byModel.costUsd += c;
    costByModel[key] = byModel;

    if (e.subagent) {
      subagentUsage.input += u.input;
      subagentUsage.output += u.output;
      subagentUsage.cacheWrite += u.cacheWrite;
      subagentUsage.cacheRead += u.cacheRead;
      if (c === null) subagentCostUsd = null;
      else if (subagentCostUsd !== null) subagentCostUsd += c;
    }

    // Cache rewrites: cache-write tokens on any entry after the first,
    // or on an entry after a gap longer than the cache TTL.
    const prev = entries[i - 1];
    const gap = prev?.timestampMs !== undefined && e.timestampMs !== undefined
      ? e.timestampMs - prev.timestampMs
      : 0;
    const isRewrite = u.cacheWrite > 0 && (i > 0 || gap > ttl);
    if (isRewrite) {
      cacheRewriteTokens += u.cacheWrite;
      cacheRewriteCount++;
      const rc = costOf(e.model, { input: 0, output: 0, cacheWrite: u.cacheWrite, cacheRead: 0 });
      if (rc === null) cacheRewriteCostUsd = null;
      else if (cacheRewriteCostUsd !== null) cacheRewriteCostUsd += rc;
    }
    // Resume: first entry after a >TTL gap that rewrites cache.
    if (gap > ttl && u.cacheWrite > 0) {
      resumeCount++;
      const rc = costOf(e.model, { input: 0, output: 0, cacheWrite: u.cacheWrite, cacheRead: 0 });
      if (rc === null) resumeCostUsd = null;
      else if (resumeCostUsd !== null) resumeCostUsd += rc;
    }
  });

  // Segment cost for each model switch.
  switches.forEach((sw, si) => {
    const seg = segments[si + 1]; // segment starting at the switch
    if (!seg) return;
    let segCost: number | null = 0;
    let segTokens = 0;
    for (let i = seg.from; i < seg.to; i++) {
      const e = entries[i];
      segTokens += totalTokens(e.usage);
      const c = costOf(e.model, e.usage);
      if (c === null) segCost = null;
      else if (segCost !== null) segCost += c;
    }
    sw.segmentCostUsd = segCost;
    sw.segmentTokens = segTokens;
  });

  // 5-hour window tokens: entries within 5h of the last entry.
  const lastMs = entries.length ? entries[entries.length - 1].timestampMs : undefined;
  let fiveHourWindowTokens = 0;
  if (lastMs !== undefined) {
    for (const e of entries) {
      if (e.timestampMs !== undefined && lastMs - e.timestampMs <= 5 * 60 * 60 * 1000) {
        fiveHourWindowTokens += totalTokens(e.usage);
      }
    }
  } else {
    fiveHourWindowTokens = totalTokens(usage);
  }

  const receipt: Receipt = {
    agent: entries[0]?.agent ?? "unknown",
    sessionId: entries[0]?.sessionId,
    project: entries[0]?.project,
    models: [...models],
    startTime: entries[0]?.timestamp,
    endTime: entries.length ? entries[entries.length - 1].timestamp : undefined,
    entryCount: entries.length,
    skippedLines: opts.skippedLines ?? 0,
    usage,
    costUsd,
    costByModel,
    cacheRewriteTokens,
    cacheRewriteCostUsd,
    cacheRewriteCount,
    subagentUsage,
    subagentCostUsd,
    resumeCostUsd,
    resumeCount,
    modelSwitches: switches,
    fiveHourWindowTokens,
    whyExpensive: [],
    unknownPriceModels: [...unknownPriceModels],
    priceTableVersion: PRICE_TABLE_VERSION,
    estimateNote: ESTIMATE_NOTE,
  };
  receipt.whyExpensive = explainWhy(receipt);
  return receipt;
}

/** Plain-language reasons, at most 3, ordered by cost share. */
export function explainWhy(r: Receipt): string[] {
  const lines: string[] = [];
  const total = r.costUsd;
  const pct = (part: number | null): number | null =>
    total !== null && total > 0 && part !== null ? (part / total) * 100 : null;

  const rewritePct = pct(r.cacheRewriteCostUsd);
  if (rewritePct !== null && rewritePct >= 20 && r.cacheRewriteCostUsd !== null) {
    lines.push(
      `${fmtUsd(r.cacheRewriteCostUsd)} (${rewritePct.toFixed(0)}% of this receipt) went to cache rewrites ` +
        `— ${r.cacheRewriteCount} rewrite(s) of ${r.cacheRewriteTokens.toLocaleString()} tokens. ` +
        `Resuming a large session after the cache TTL expires re-writes the whole context. ` +
        `Compact the session before pausing, or resume sooner.`,
    );
  } else if (r.resumeCount > 0 && r.resumeCostUsd !== null && r.resumeCostUsd > 0) {
    lines.push(
      `This session was resumed ${r.resumeCount} time(s) after a long gap; ` +
        `resume cache rewrites cost ${fmtUsd(r.resumeCostUsd)}. ` +
        `That cost is charged before any new work happens.`,
    );
  }

  const subPct = pct(r.subagentCostUsd);
  if (subPct !== null && subPct >= 20 && r.subagentCostUsd !== null) {
    lines.push(
      `Subagents / sidechain work cost ${fmtUsd(r.subagentCostUsd)} (${subPct.toFixed(0)}%). ` +
        `Check whether a subagent repeated work or ran in a loop.`,
    );
  }

  for (const sw of r.modelSwitches) {
    const segPct = pct(sw.segmentCostUsd);
    if (segPct !== null && segPct >= 15 && sw.segmentCostUsd !== null) {
      lines.push(
        `Model switch ${sw.fromModel ?? "?"} → ${sw.toModel ?? "?"}: ` +
          `the segment after the switch cost ${fmtUsd(sw.segmentCostUsd)} (${segPct.toFixed(0)}%). ` +
          `Confirm before switching to a more expensive model.`,
      );
      break;
    }
  }

  if (lines.length === 0 && total !== null && total > 0) {
    const cacheReadShare = r.usage.cacheRead / Math.max(1, totalTokens(r.usage));
    if (cacheReadShare >= 0.5) {
      lines.push(
        `Cache is working well here: ${(cacheReadShare * 100).toFixed(0)}% of tokens were cache reads, ` +
          `the cheapest kind. The main cost is fresh input and output.`,
      );
    } else {
      lines.push(
        `No single cause dominates this receipt. The largest share is fresh input and output tokens — ` +
          `shorter prompts and smaller context windows are the cheapest lever.`,
      );
    }
  }
  if (lines.length === 0) {
    lines.push("No cost drivers identified — token counts are low or prices are unknown for these models.");
  }
  return lines.slice(0, 3);
}
