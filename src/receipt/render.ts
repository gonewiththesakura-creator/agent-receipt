import { writeFileSync } from "node:fs";
import type { Receipt } from "./receipt.js";
import type { ResumeForecast } from "./forecast.js";

function usd(n: number | null): string {
  return n === null ? "unknown (price not in table)" : `$${n.toFixed(4)}`;
}

function row(label: string, value: string, width = 22): string {
  return `${label.padEnd(width)} ${value}`;
}

export function renderReceiptText(r: Receipt): string {
  const lines: string[] = [];
  lines.push("agent-receipt — session cost receipt");
  lines.push("=".repeat(52));
  lines.push(row("Agent:", r.agent));
  if (r.sessionId) lines.push(row("Session:", r.sessionId));
  if (r.project) lines.push(row("Project:", r.project));
  if (r.models.length) lines.push(row("Models:", r.models.join(", ")));
  if (r.startTime) lines.push(row("Start:", r.startTime));
  if (r.endTime) lines.push(row("End:", r.endTime));
  lines.push(row("Messages:", String(r.entryCount)));
  if (r.skippedLines > 0) lines.push(row("Skipped lines:", String(r.skippedLines)));
  lines.push("");
  lines.push("Tokens");
  lines.push("-".repeat(52));
  lines.push(row("  Fresh input:", r.usage.input.toLocaleString()));
  lines.push(row("  Cache read:", r.usage.cacheRead.toLocaleString()));
  lines.push(row("  Cache write:", r.usage.cacheWrite.toLocaleString()));
  lines.push(row("  Output:", r.usage.output.toLocaleString()));
  lines.push(row("  Total:", (r.usage.input + r.usage.output + r.usage.cacheWrite + r.usage.cacheRead).toLocaleString()));
  lines.push("");
  lines.push("Cost (estimate)");
  lines.push("-".repeat(52));
  lines.push(row("  Total:", usd(r.costUsd)));
  lines.push(row("  Cache rewrites:", `${r.cacheRewriteCount} rewrite(s), ${r.cacheRewriteTokens.toLocaleString()} tokens, ${usd(r.cacheRewriteCostUsd)}`));
  lines.push(row("  Subagents:", usd(r.subagentCostUsd)));
  if (r.resumeCount > 0) lines.push(row("  Resume rewrites:", `${r.resumeCount} resume(s), ${usd(r.resumeCostUsd)}`));
  lines.push(row("  5h-window tokens:", r.fiveHourWindowTokens.toLocaleString()));
  lines.push("");
  if (Object.keys(r.costByModel).length > 1 || Object.keys(r.costByModel).length === 1) {
    lines.push("Cost by model");
    lines.push("-".repeat(52));
    for (const [model, v] of Object.entries(r.costByModel)) {
      lines.push(row(`  ${model}:`, `${v.tokens.toLocaleString()} tokens, ${usd(v.costUsd)}`));
    }
    lines.push("");
  }
  if (r.modelSwitches.length > 0) {
    lines.push("Model switches");
    lines.push("-".repeat(52));
    for (const sw of r.modelSwitches) {
      lines.push(`  ${sw.fromModel ?? "?"} → ${sw.toModel ?? "?"} at ${sw.timestamp ?? "?"} — segment ${sw.segmentTokens.toLocaleString()} tokens, ${usd(sw.segmentCostUsd)}`);
    }
    lines.push("");
  }
  lines.push("Why it was expensive");
  lines.push("-".repeat(52));
  r.whyExpensive.forEach((w, i) => lines.push(`  ${i + 1}. ${w}`));
  lines.push("");
  if (r.unknownPriceModels.length > 0) {
    lines.push(`Note: no price in the table for: ${r.unknownPriceModels.join(", ")} — token counts only for those models.`);
  }
  lines.push(r.estimateNote);
  lines.push(`Price table version: ${r.priceTableVersion}`);
  return lines.join("\n");
}

export function renderReceiptMarkdown(r: Receipt): string {
  const md: string[] = [];
  md.push("# Cost receipt");
  md.push("");
  md.push(`- Agent: ${r.agent}`);
  if (r.sessionId) md.push(`- Session: ${r.sessionId}`);
  if (r.project) md.push(`- Project: ${r.project}`);
  if (r.models.length) md.push(`- Models: ${r.models.join(", ")}`);
  if (r.startTime) md.push(`- Start: ${r.startTime}`);
  if (r.endTime) md.push(`- End: ${r.endTime}`);
  md.push("");
  md.push("## Tokens");
  md.push("");
  md.push("| Kind | Tokens |");
  md.push("| --- | ---: |");
  md.push(`| Fresh input | ${r.usage.input.toLocaleString()} |`);
  md.push(`| Cache read | ${r.usage.cacheRead.toLocaleString()} |`);
  md.push(`| Cache write | ${r.usage.cacheWrite.toLocaleString()} |`);
  md.push(`| Output | ${r.usage.output.toLocaleString()} |`);
  md.push("");
  md.push("## Cost (estimate)");
  md.push("");
  md.push(`- **Total: ${usd(r.costUsd)}**`);
  md.push(`- Cache rewrites: ${r.cacheRewriteCount} rewrite(s), ${r.cacheRewriteTokens.toLocaleString()} tokens, ${usd(r.cacheRewriteCostUsd)}`);
  md.push(`- Subagents: ${usd(r.subagentCostUsd)}`);
  if (r.resumeCount > 0) md.push(`- Resume rewrites: ${r.resumeCount} resume(s), ${usd(r.resumeCostUsd)}`);
  md.push(`- 5h-window tokens: ${r.fiveHourWindowTokens.toLocaleString()}`);
  md.push("");
  md.push("## Why it was expensive");
  md.push("");
  r.whyExpensive.forEach((w, i) => md.push(`${i + 1}. ${w}`));
  md.push("");
  md.push(`> ${r.estimateNote} Price table version: ${r.priceTableVersion}.`);
  if (r.unknownPriceModels.length > 0) {
    md.push(`> No price in the table for: ${r.unknownPriceModels.join(", ")} — token counts only for those models.`);
  }
  return md.join("\n");
}

export function renderForecastText(f: ResumeForecast): string {
  const lines: string[] = [];
  lines.push("agent-receipt — resume forecast");
  lines.push("=".repeat(52));
  if (f.sessionId) lines.push(row("Session:", f.sessionId));
  if (f.model) lines.push(row("Model:", f.model));
  if (f.lastActivity) lines.push(row("Last activity:", f.lastActivity));
  lines.push(row("Context tokens:", f.contextTokens.toLocaleString()));
  lines.push(row("Idle:", f.idleMinutes === null ? "unknown (no timestamps)" : `${f.idleMinutes} min`));
  lines.push(row("Cache expired:", f.cacheExpired === null ? "unknown" : f.cacheExpired ? "YES" : "no (still warm)"));
  lines.push(row("Estimated resume cost:", usd(f.estimatedResumeCostUsd)));
  lines.push("");
  if (f.warning) lines.push(`Warning: ${f.warning}`);
  lines.push(`Recommendation: ${f.recommendation}`);
  lines.push("");
  lines.push("Estimate at published list prices, not your invoice.");
  return lines.join("\n");
}

export function writeReceiptFiles(r: Receipt, outDir: string): { mdPath: string; jsonPath: string } {
  const mdPath = `${outDir}/receipt.md`;
  const jsonPath = `${outDir}/receipt.json`;
  writeFileSync(mdPath, renderReceiptMarkdown(r) + "\n", "utf8");
  writeFileSync(jsonPath, JSON.stringify(r, null, 2) + "\n", "utf8");
  return { mdPath, jsonPath };
}
