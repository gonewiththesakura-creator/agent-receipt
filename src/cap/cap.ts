import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { discoverLogs } from "../parsers/index.js";
import { buildReceipt } from "../receipt/receipt.js";
import { renderReceiptMarkdown, renderReceiptText } from "../receipt/render.js";

export interface CapOptions {
  capUsd: number;
  /** Optional 5h-window token budget; when set, --quota-pct is a share of it. */
  quotaTokens?: number;
  quotaPct?: number;
  logDir?: string;
  agent?: "claude" | "codex" | "all";
  outDir?: string;
  pollMs?: number;
}

export interface CapResult {
  stopped: boolean;
  reason: string;
  exitCode: number | null;
  finalCostUsd: number | null;
  fiveHourWindowTokens: number;
  evidencePath: string | undefined;
}

/**
 * Run a child command under a hard cap.
 *
 * How it works: take a baseline cost snapshot from the local logs, spawn
 * the child in its own process group, then poll the logs and re-price
 * them. When the incremental cost since the baseline reaches the cap
 * (or the 5h-window token share reaches --quota-pct of --quota-tokens),
 * kill the whole process group and write an evidence receipt.
 *
 * Honest limits (also in README): this polls log files, so enforcement
 * can be one request late — a request that starts just before the cap
 * is hit may still complete. The cap is a local enforcement aid, not a
 * mathematical guarantee of zero overshoot. It also only sees usage the
 * agent writes to local logs; if the agent's logs are delayed or
 * missing, the cap cannot see that spend.
 */
export async function runWithCap(command: string[], opts: CapOptions): Promise<CapResult> {
  if (command.length === 0) throw new Error("run --cap requires a command after --");
  if (!(opts.capUsd > 0) && opts.quotaPct === undefined) {
    throw new Error("run requires --cap <usd> or --quota-pct <n>");
  }
  const pollMs = opts.pollMs ?? 250;
  const outDir = opts.outDir ?? process.cwd();

  const baseline = discoverLogs({ logDir: opts.logDir, agent: opts.agent });
  const baselineCost = costOfEntries(baseline.entries);
  const baselineTokens = tokensOfEntries(baseline.entries);

  const child: ChildProcess = spawn(command[0], command.slice(1), {
    detached: true,
    stdio: "inherit",
  });

  let stopped = false;
  let reason = "completed";
  let finalCostUsd: number | null = 0;
  let fiveHourWindowTokens = 0;

  const check = (): boolean => {
    const now = discoverLogs({ logDir: opts.logDir, agent: opts.agent });
    const receipt = buildReceipt(now.entries, { skippedLines: now.skippedLines });
    const currentCost = costOfEntries(now.entries);
    const incremental =
      currentCost !== null && baselineCost !== null ? currentCost - baselineCost : null;
    finalCostUsd = incremental;
    fiveHourWindowTokens = receipt.fiveHourWindowTokens;
    if (opts.capUsd > 0 && incremental !== null && incremental >= opts.capUsd) {
      stopped = true;
      reason = `cap_exceeded: incremental cost ${fmt(incremental)} reached cap ${fmt(opts.capUsd)}`;
      return true;
    }
    if (
      opts.quotaPct !== undefined &&
      opts.quotaTokens !== undefined &&
      opts.quotaTokens > 0
    ) {
      const windowTokens = receipt.fiveHourWindowTokens;
      const pct = (windowTokens / opts.quotaTokens) * 100;
      if (pct >= opts.quotaPct) {
        stopped = true;
        reason = `quota_exceeded: 5h-window tokens ${windowTokens.toLocaleString()} reached ${opts.quotaPct}% of quota ${opts.quotaTokens.toLocaleString()}`;
        return true;
      }
    }
    return false;
  };

  const poll = setInterval(() => {
    try {
      if (check()) killChild();
    } catch {
      // A transient log read error must not kill the child; keep polling.
    }
  }, pollMs);

  const killChild = () => {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 1000).unref();
  };

  const exitCode: number | null = await new Promise((resolve) => {
    child.on("exit", (code) => {
      clearInterval(poll);
      resolve(code);
    });
    child.on("error", () => {
      clearInterval(poll);
      resolve(null);
    });
  });
  clearInterval(poll);

  // Final snapshot after exit / kill.
  try {
    check();
  } catch {
    /* keep last values */
  }

  let evidencePath: string | undefined;
  if (stopped) {
    const now = discoverLogs({ logDir: opts.logDir, agent: opts.agent });
    const receipt = buildReceipt(now.entries, { skippedLines: now.skippedLines });
    const evidence = {
      stopped: true,
      reason,
      capUsd: opts.capUsd > 0 ? opts.capUsd : undefined,
      quotaPct: opts.quotaPct,
      quotaTokens: opts.quotaTokens,
      baselineCostUsd: baselineCost,
      baselineTokens,
      finalIncrementalCostUsd: finalCostUsd,
      fiveHourWindowTokens,
      stoppedAt: new Date().toISOString(),
      command,
      receipt,
    };
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    evidencePath = `${outDir}/cap-evidence.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n", "utf8");
    writeFileSync(
      `${outDir}/cap-evidence.md`,
      `# Cap evidence\n\n- **Stopped:** yes\n- **Reason:** ${reason}\n- **Command:** \`${command.join(" ")}\`\n- **Incremental cost at stop:** ${finalCostUsd === null ? "unknown (price not in table)" : fmt(finalCostUsd)}\n- **5h-window tokens:** ${fiveHourWindowTokens.toLocaleString()}\n- **Stopped at:** ${evidence.stoppedAt}\n\n${renderReceiptMarkdown(receipt)}\n`,
      "utf8",
    );
    console.log(renderReceiptText(receipt));
    console.log(`\nStopped: ${reason}`);
    console.log(`Evidence written to ${evidencePath}`);
  }

  return { stopped, reason, exitCode, finalCostUsd, fiveHourWindowTokens, evidencePath };
}

function fmt(n: number): string {
  return `$${n.toFixed(4)}`;
}

import { costOf } from "../pricing/prices.js";
import { totalTokens } from "../types.js";
import type { LogEntry } from "../types.js";

function costOfEntries(entries: LogEntry[]): number | null {
  let total: number | null = 0;
  for (const e of entries) {
    const c = costOf(e.model, e.usage);
    if (c === null) return null;
    total += c;
  }
  return total;
}

function tokensOfEntries(entries: LogEntry[]): number {
  let total = 0;
  for (const e of entries) total += totalTokens(e.usage);
  return total;
}
