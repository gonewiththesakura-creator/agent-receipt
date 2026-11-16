#!/usr/bin/env node
/**
 * agent-receipt CLI — local-first cost receipts for AI coding agents.
 *
 * Read-only log parsing by default. The only command that stops another
 * process is `run --cap`, which the user explicitly asks for.
 * No network calls, no uploads, no API keys.
 */
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseClaudeFile } from "./parsers/claude.js";
import { parseCodexFile } from "./parsers/codex.js";
import { discoverLogs, groupBySession } from "./parsers/index.js";
import { buildReceipt } from "./receipt/receipt.js";
import { forecastResume } from "./receipt/forecast.js";
import { findModelSwitches } from "./receipt/check.js";
import { renderReceiptText, renderForecastText, writeReceiptFiles } from "./receipt/render.js";
import { runWithCap } from "./cap/cap.js";
import type { LogEntry, ParseResult } from "./types.js";

const VERSION = "0.1.0";

function usage(): string {
  return `agent-receipt ${VERSION} — a cost receipt for AI coding agents (local-first)

Usage:
  agent-receipt daily [--date YYYY-MM-DD] [--agent claude|codex|all] [--log-dir DIR]
  agent-receipt monthly [--month YYYY-MM] [--agent claude|codex|all] [--log-dir DIR]
  agent-receipt session <id> [--log-dir DIR]
  agent-receipt receipt [--file PATH] [--log-dir DIR] [--out DIR]
  agent-receipt check [--file PATH] [--log-dir DIR]        model-switch report
  agent-receipt resume --forecast --file PATH [--ttl-minutes N]
  agent-receipt run --cap <usd> [--quota-pct N --quota-tokens N] [--log-dir DIR] [--out DIR] -- <command...>

Notes:
  - Dollar figures are estimates at published list prices, not your invoice.
  - Subscription quota is shown in tokens / 5h-window share, never as dollars.
  - 'run --cap' polls local logs and can be one request late; see README "Honest limits".
  - With no logs found, commands print that and exit 0 — they never invent data.
`;
}

interface Flags {
  date?: string;
  month?: string;
  agent?: "claude" | "codex" | "all";
  logDir?: string;
  file?: string;
  out?: string;
  cap?: number;
  quotaPct?: number;
  quotaTokens?: number;
  ttlMinutes?: number;
  forecast?: boolean;
}

function parseFlags(args: string[]): { flags: Flags; rest: string[] } {
  const flags: Flags = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--date") flags.date = next();
    else if (a === "--month") flags.month = next();
    else if (a === "--agent") flags.agent = next() as Flags["agent"];
    else if (a === "--log-dir") flags.logDir = next();
    else if (a === "--file") flags.file = next();
    else if (a === "--out") flags.out = next();
    else if (a === "--cap") flags.cap = Number(next());
    else if (a === "--quota-pct") flags.quotaPct = Number(next());
    else if (a === "--quota-tokens") flags.quotaTokens = Number(next());
    else if (a === "--ttl-minutes") flags.ttlMinutes = Number(next());
    else if (a === "--forecast") flags.forecast = true;
    else if (a === "--") rest.push(...args.slice(i + 1));
    else rest.push(a);
  }
  return { flags, rest };
}

function loadEntries(flags: Flags, agentHint?: "claude" | "codex"): ParseResult {
  if (flags.file) {
    const isCodex = agentHint === "codex" || flags.file.includes("codex");
    const r = isCodex
      ? parseCodexFile(flags.file)
      : parseClaudeFile(flags.file);
    // If the first parser found nothing, try the other — Codex and Claude logs are both JSONL.
    if (r.entries.length === 0 && r.skippedLines > 0) {
      const alt = isCodex ? parseClaudeFile(flags.file) : parseCodexFile(flags.file);
      if (alt.entries.length > 0) return alt;
    }
    return r;
  }
  return discoverLogs({ logDir: flags.logDir, agent: flags.agent });
}

function filterByDate(entries: LogEntry[], datePrefix: string): LogEntry[] {
  return entries.filter((e) => (e.timestamp ?? "").startsWith(datePrefix));
}

function printReceipt(entries: LogEntry[], skipped: number, flags: Flags, label: string): number {
  if (entries.length === 0) {
    console.log(`No log entries found for ${label}. Nothing to report — no data was invented.`);
    if (skipped > 0) console.log(`(${skipped} malformed line(s) were skipped.)`);
    return 0;
  }
  const receipt = buildReceipt(entries, { skippedLines: skipped });
  console.log(renderReceiptText(receipt));
  if (flags.out) {
    if (!existsSync(flags.out)) mkdirSync(flags.out, { recursive: true });
    const { mdPath, jsonPath } = writeReceiptFiles(receipt, flags.out);
    console.log(`\nReceipt written to ${mdPath} and ${jsonPath}`);
  }
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...restArgs] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return 0;
  }
  if (cmd === "--version" || cmd === "-V") {
    console.log(`agent-receipt ${VERSION}`);
    return 0;
  }
  const { flags, rest } = parseFlags(restArgs);

  if (cmd === "daily") {
    const date = flags.date ?? new Date().toISOString().slice(0, 10);
    const r = loadEntries(flags);
    return printReceipt(filterByDate(r.entries, date), r.skippedLines, flags, `daily (${date})`);
  }

  if (cmd === "monthly") {
    const month = flags.month ?? new Date().toISOString().slice(0, 7);
    const r = loadEntries(flags);
    return printReceipt(filterByDate(r.entries, month), r.skippedLines, flags, `monthly (${month})`);
  }

  if (cmd === "session") {
    const id = rest[0];
    if (!id) {
      console.error("Usage: agent-receipt session <id> [--log-dir DIR]");
      return 2;
    }
    const r = loadEntries(flags);
    const sessions = groupBySession(r.entries);
    const entries = sessions.get(id);
    if (!entries) {
      console.log(`No session with id "${id}" found. Known sessions:`);
      for (const key of sessions.keys()) console.log(`  ${key}`);
      return 0;
    }
    return printReceipt(entries, r.skippedLines, flags, `session ${id}`);
  }

  if (cmd === "receipt") {
    const r = loadEntries(flags);
    // Latest session only, by timestamp.
    const sessions = groupBySession(r.entries);
    let latest: LogEntry[] | undefined;
    let latestMs = -1;
    for (const entries of sessions.values()) {
      const ms = entries[entries.length - 1]?.timestampMs ?? -1;
      if (ms > latestMs) {
        latestMs = ms;
        latest = entries;
      }
    }
    if (!latest) {
      console.log("No log entries found. Nothing to report — no data was invented.");
      return 0;
    }
    return printReceipt(latest, r.skippedLines, flags, "latest session");
  }

  if (cmd === "check") {
    const r = loadEntries(flags);
    if (r.entries.length === 0) {
      console.log("No log entries found. Nothing to report.");
      return 0;
    }
    const switches = findModelSwitches(r.entries);
    if (switches.length === 0) {
      console.log("No model switches found in these logs.");
      return 0;
    }
    console.log("Model switches found:");
    for (const sw of switches) {
      console.log(
        `  ${sw.fromModel ?? "?"} → ${sw.toModel ?? "?"} at ${sw.timestamp ?? "?"} — ` +
          `segment ${sw.segmentTokens.toLocaleString()} tokens, ` +
          `${sw.segmentCostUsd === null ? "cost unknown (price not in table)" : `$${sw.segmentCostUsd.toFixed(4)} (estimate)`}`,
      );
    }
    console.log("\nNote: this report is retrospective. agent-receipt v0.1 does not block a model switch mid-flight — see README \"Honest limits\".");
    return 0;
  }

  if (cmd === "resume") {
    if (!flags.forecast) {
      console.error("Usage: agent-receipt resume --forecast --file PATH [--ttl-minutes N]");
      return 2;
    }
    if (!flags.file) {
      console.error("resume --forecast requires --file PATH (a session .jsonl log).");
      return 2;
    }
    const r = loadEntries(flags);
    if (r.entries.length === 0) {
      console.log("No log entries found in that file. Nothing to forecast.");
      return 0;
    }
    const forecast = forecastResume(r.entries, {
      cacheTtlMs: flags.ttlMinutes ? flags.ttlMinutes * 60 * 1000 : undefined,
    });
    if (!forecast) {
      console.log("Could not build a forecast from this log.");
      return 0;
    }
    console.log(renderForecastText(forecast));
    return 0;
  }

  if (cmd === "run") {
    if (flags.cap === undefined && flags.quotaPct === undefined) {
      console.error("Usage: agent-receipt run --cap <usd> [--quota-pct N --quota-tokens N] [--log-dir DIR] -- <command...>");
      return 2;
    }
    if (rest.length === 0) {
      console.error("run requires a command after --, e.g. agent-receipt run --cap 5 -- claude");
      return 2;
    }
    const result = await runWithCap(rest, {
      capUsd: flags.cap ?? 0,
      quotaPct: flags.quotaPct,
      quotaTokens: flags.quotaTokens,
      logDir: flags.logDir,
      agent: flags.agent,
      outDir: flags.out,
    });
    if (result.stopped) {
      console.log(`\nagent-receipt stopped the command: ${result.reason}`);
      return 3;
    }
    return result.exitCode ?? 0;
  }

  console.error(`Unknown command: ${cmd}\n`);
  console.log(usage());
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`agent-receipt failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
