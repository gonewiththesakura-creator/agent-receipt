import { readFileSync, existsSync } from "node:fs";
import type { LogEntry, ParseResult, Usage } from "../types.js";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

function extractUsage(raw: any): Usage | null {
  const u = raw?.message?.usage ?? raw?.usage ?? null;
  if (!u || typeof u !== "object") return null;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheWrite = num(u.cache_creation_input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  if (input + output + cacheWrite + cacheRead === 0) return null;
  return { input, output, cacheWrite, cacheRead };
}

/**
 * Parse one Claude Code JSONL session file.
 *
 * Expected shape (per line): { type, timestamp, sessionId, message: { model, usage: {
 * input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens } },
 * isSidechain, parentUuid, ... }
 *
 * Unknown fields are ignored. Lines that are not JSON, or have no usable
 * usage record, are counted in skippedLines and skipped — parsing never
 * crashes on a malformed line.
 */
export function parseClaudeFile(filePath: string, project?: string): ParseResult {
  const entries: LogEntry[] = [];
  let skippedLines = 0;
  if (!existsSync(filePath)) return { entries, skippedLines, files: [] };
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: any;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      skippedLines++;
      continue;
    }
    if (!raw || typeof raw !== "object") {
      skippedLines++;
      continue;
    }
    // Summaries and file-level metadata carry no usage.
    if (raw.type === "summary" || raw.type === "file-history-snapshot") {
      continue;
    }
    const usage = extractUsage(raw);
    if (!usage) {
      skippedLines++;
      continue;
    }
    const model: string | undefined =
      typeof raw.message?.model === "string"
        ? raw.message.model
        : typeof raw.model === "string"
          ? raw.model
          : undefined;
    const timestamp: string | undefined =
      typeof raw.timestamp === "string" ? raw.timestamp : undefined;
    const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
    entries.push({
      agent: "claude",
      sessionId:
        typeof raw.sessionId === "string" ? raw.sessionId : undefined,
      project,
      model,
      timestamp,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
      usage,
      subagent: raw.isSidechain === true || typeof raw.parentUuid === "string",
    });
  }
  return { entries, skippedLines, files: [filePath] };
}
