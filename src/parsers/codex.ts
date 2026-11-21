import { readFileSync, existsSync } from "node:fs";
import type { LogEntry, ParseResult, Usage } from "../types.js";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Best-effort usage extraction for Codex CLI session logs.
 *
 * Codex log formats vary between versions, so this searches a small set
 * of known shapes, one level deep, and gives up gracefully:
 *   - { usage: { input_tokens, output_tokens, cached_input_tokens } }
 *   - { usage: { prompt_tokens, completion_tokens, cached_tokens } }
 *   - { tokens: { prompt, completion, cached } }
 *   - nested under payload / data / response / event
 * Unknown fields are skipped; lines with no usable usage are counted
 * as skipped, never fatal.
 */
function extractUsage(raw: any): Usage | null {
  const candidates: any[] = [
    raw?.usage,
    raw?.tokens,
    raw?.payload?.usage,
    raw?.payload?.tokens,
    raw?.data?.usage,
    raw?.response?.usage,
    raw?.event?.usage,
  ];
  for (const u of candidates) {
    if (!u || typeof u !== "object") continue;
    const input = num(u.input_tokens ?? u.prompt_tokens ?? u.prompt);
    const output = num(u.output_tokens ?? u.completion_tokens ?? u.completion);
    // Codex reports cached input tokens; treat them as cache reads.
    const cacheRead = num(
      u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cached_tokens ?? u.cached,
    );
    const cacheWrite = num(u.cache_creation_input_tokens ?? u.cache_write_input_tokens ?? 0);
    if (input + output + cacheRead + cacheWrite === 0) continue;
    // A record with only cache tokens and no fresh input or output is
    // not a billable event — and it is also what a Gemini CLI message
    // looks like to this parser (its `tokens.cached` matches the
    // `cached` candidate below). Requiring input or output keeps the
    // Codex parser from claiming Gemini lines when it runs first.
    if (input + output === 0) continue;
    return { input, output, cacheWrite, cacheRead };
  }
  return null;
}

function pickString(raw: any, keys: string[]): string | undefined {
  for (const k of keys) {
    if (typeof raw?.[k] === "string") return raw[k];
    if (typeof raw?.payload?.[k] === "string") return raw.payload[k];
  }
  return undefined;
}

export function parseCodexFile(filePath: string, project?: string): ParseResult {
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
    const usage = extractUsage(raw);
    if (!usage) {
      skippedLines++;
      continue;
    }
    const model = pickString(raw, ["model", "model_id"]);
    const timestamp =
      pickString(raw, ["timestamp", "time", "created_at"]) ??
      (typeof raw?.ts === "number" ? new Date(raw.ts * 1000).toISOString() : undefined);
    const timestampMs = timestamp ? Date.parse(timestamp) : Number.NaN;
    const subagent =
      raw.subagent === true ||
      raw.agent === "subagent" ||
      typeof raw.subagent_id === "string" ||
      raw?.payload?.subagent === true;
    entries.push({
      agent: "codex",
      sessionId: pickString(raw, ["session_id", "sessionId", "id"]),
      project,
      model,
      timestamp,
      timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
      usage,
      subagent,
    });
  }
  return { entries, skippedLines, files: [filePath] };
}
