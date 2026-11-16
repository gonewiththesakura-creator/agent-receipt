/**
 * 确定性解释层（规则版）。
 *
 * 本模块是 agent-receipt 的“解释层”：它只接受确定性层算好的收据
 * （Receipt）作为输入，输出自然语言解释，绝不重新计算任何金额。
 *
 * 红线：
 * - 解释里的每一个美元数字，都必须是收据里已有的美元字段
 *   （总成本、缓存重写、子代理、resume、某模型、某切换段）；
 * - 每一个百分比，都必须是某部分占总成本的份额
 *   （或 cache read 占 token 总数的份额）；
 * - token 数也只能引用收据里的字段。
 * - 解释层不读日志、不读定价表、不调任何模型 API。
 *
 * 校验见 verifyExplanation()：任何对不上收据字段的数字都会被
 * 列为违规，由调用方丢弃或报错，而不是悄悄放行。
 */
import { totalTokens } from "../types.js";
import type { Receipt } from "../receipt/receipt.js";

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/**
 * 按收据字段生成解释行，最多 3 行，按成本占比排序。
 * 纯函数：同一份收据永远得到同一组解释行。
 */
export function explainReceipt(r: Receipt): string[] {
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

/** 收据里出现过的所有美元字段（null 除外）。 */
export function knownDollarValues(r: Receipt): number[] {
  const values: number[] = [];
  const push = (v: number | null) => {
    if (v !== null) values.push(v);
  };
  push(r.costUsd);
  push(r.cacheRewriteCostUsd);
  push(r.subagentCostUsd);
  push(r.resumeCostUsd);
  for (const sw of r.modelSwitches) push(sw.segmentCostUsd);
  for (const v of Object.values(r.costByModel)) push(v.costUsd);
  return values;
}

/** 收据里能推导出的所有百分比（取整后）：各部分占总成本的份额，以及 cache read 占 token 总数的份额。 */
export function knownPercentValues(r: Receipt): number[] {
  const values: number[] = [];
  const total = r.costUsd;
  if (total !== null && total > 0) {
    for (const v of knownDollarValues(r)) {
      values.push(Math.round((v / total) * 100));
    }
  }
  const tokens = totalTokens(r.usage);
  if (tokens > 0) values.push(Math.round((r.usage.cacheRead / tokens) * 100));
  return values;
}

/** 收据里出现过的所有 token 数字段。 */
export function knownTokenValues(r: Receipt): number[] {
  const values: number[] = [
    r.usage.input,
    r.usage.output,
    r.usage.cacheWrite,
    r.usage.cacheRead,
    totalTokens(r.usage),
    r.cacheRewriteTokens,
    r.fiveHourWindowTokens,
  ];
  for (const sw of r.modelSwitches) values.push(sw.segmentTokens);
  for (const v of Object.values(r.costByModel)) values.push(v.tokens);
  return values;
}

export interface ExplanationViolation {
  /** 出现违规数字的那一行解释文本。 */
  line: string;
  /** 违规的数字原文（如 "$0.9999"、"87%"、"12,345 tokens"）。 */
  value: string;
  /** 违规种类：金额 / 百分比 / token 数。 */
  kind: "amount" | "percent" | "tokens";
}

/**
 * 校验解释行：其中的每一个美元金额、百分比、“N tokens”数字，
 * 都必须能在收据字段里找到对应值，否则列为违规。
 * 返回空数组表示全部通过。容差：金额 1e-9，百分比取整后相等。
 */
export function verifyExplanation(lines: string[], r: Receipt): ExplanationViolation[] {
  const violations: ExplanationViolation[] = [];
  const dollars = knownDollarValues(r);
  const percents = knownPercentValues(r);
  const tokens = knownTokenValues(r);

  for (const line of lines) {
    for (const m of line.matchAll(/\$(\d+(?:\.\d+)?)/g)) {
      const v = Number(m[1]);
      if (!dollars.some((d) => Math.abs(d - v) < 1e-9)) {
        violations.push({ line, value: m[0], kind: "amount" });
      }
    }
    for (const m of line.matchAll(/(\d+(?:\.\d+)?)%/g)) {
      const v = Math.round(Number(m[1]));
      if (!percents.includes(v)) {
        violations.push({ line, value: m[0], kind: "percent" });
      }
    }
    for (const m of line.matchAll(/([\d,]+) tokens/g)) {
      const v = Number(m[1].replace(/,/g, ""));
      if (!tokens.includes(v)) {
        violations.push({ line, value: m[0], kind: "tokens" });
      }
    }
  }
  return violations;
}
