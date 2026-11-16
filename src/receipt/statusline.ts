/**
 * 状态栏一行输出（ccusage 的 `statusline` 模式的同类能力）。
 *
 * 只读 buildReceipt() 算好的收据字段，不自己算钱、不读日志。
 * 输出严格一行，供 Claude Code 的 statusLine hook 直接显示。
 */
import { totalTokens } from "../types.js";
import type { Receipt } from "./receipt.js";

export interface StatuslineOptions {
  /** 不显示任何美元数字（订阅用户适用：只看 token 数与占比）。 */
  noCost?: boolean;
}

/** token 紧凑格式：228800 -> "228.8k"，999 -> "999"，1500000 -> "1.5M"。 */
export function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimOneDecimal(n / 1000)}k`;
  return `${trimOneDecimal(n / 1_000_000)}M`;
}

function trimOneDecimal(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** 缓存重写占比：有美元成本时按成本占比算，否则按 token 占比算。 */
function rewriteShare(r: Receipt): number {
  if (r.costUsd !== null && r.costUsd > 0 && r.cacheRewriteCostUsd !== null) {
    return r.cacheRewriteCostUsd / r.costUsd;
  }
  const total = totalTokens(r.usage);
  if (total <= 0) return 0;
  return r.cacheRewriteTokens / total;
}

/** 最近一次模型切换后段的成本占比；没有可用的美元成本时返回 null。 */
function lastSwitchShare(r: Receipt): number | null {
  const sw = r.modelSwitches[r.modelSwitches.length - 1];
  if (!sw) return null;
  if (r.costUsd === null || r.costUsd <= 0) return null;
  if (sw.segmentCostUsd === null) return null;
  return sw.segmentCostUsd / r.costUsd;
}

/**
 * 渲染状态栏一行，格式示例：
 *   💰 $0.71 · 228.8k tokens · 26% rewrite · switch +$0.25
 *
 * 规则（只读收据字段）：
 * - 有美元估算时显示 `$X.XX`（两位小数）；costUsd 为 null 时不显示美元，
 *   只显示 token 数并加 `no $ price` 提示。
 * - 只在缓存重写占比 >= 20% 时追加 `N% rewrite`。
 * - 有模型切换且切换后段成本占比 >= 15% 时追加 `switch +$X.XX`。
 * - opts.noCost 时不显示任何美元数字，只显示 token 数与 rewrite 占比。
 */
export function renderStatusline(r: Receipt, opts: StatuslineOptions = {}): string {
  const parts: string[] = [];

  // 美元：有估算才显示；null 表示有模型不在标价表里，不编价格。
  if (!opts.noCost && r.costUsd !== null) {
    parts.push(`💰 $${r.costUsd.toFixed(2)}`);
  }
  parts.push(`${compactTokens(totalTokens(r.usage))} tokens`);
  if (!opts.noCost && r.costUsd === null) {
    parts.push("no $ price");
  }

  // 缓存重写占比 >= 20% 才值得在状态栏占位置。
  const rewritePct = Math.round(rewriteShare(r) * 100);
  if (rewritePct >= 20) {
    parts.push(`${rewritePct}% rewrite`);
  }

  // 最近一次模型切换：后段成本占比 >= 15% 才提示。
  if (!opts.noCost) {
    const share = lastSwitchShare(r);
    const sw = r.modelSwitches[r.modelSwitches.length - 1];
    // share 非 null 时，lastSwitchShare 已保证 segmentCostUsd 非 null。
    if (share !== null && share >= 0.15 && sw?.segmentCostUsd !== null) {
      parts.push(`switch +$${sw.segmentCostUsd.toFixed(2)}`);
    }
  }

  return parts.join(" · ");
}
