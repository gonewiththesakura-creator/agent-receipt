import { readFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import type { LogEntry, ParseResult, Usage } from "../types.js";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Best-effort usage extraction for one Gemini CLI assistant message.
 *
 * Verified shapes (2026-11-20, from the ccusage Gemini docs, the
 * dataclaw session schema, and the Gemini CLI session-history guide):
 *   - session files live under ~/.gemini/tmp/<project>/chats/ as
 *     session-*.json (older: one object with a `messages` array) or
 *     session-*.jsonl (current: one message object per line)
 *   - a Gemini message is { type: "gemini", timestamp, model,
 *     tokens: { input, cached, output }, thoughts, toolCalls }
 *
 * Two ccusage rules are applied here, not invented:
 *   - `tokens.input` already includes the cached tokens, so the fresh
 *     input is input - cached and the cached part is a cache read;
 *     without the split the same tokens would be counted twice.
 *   - thinking ("thought") tokens are billed at the output rate, so
 *     they are added to output. The field name for them varies, so a
 *     few candidates are tried; an absent field simply adds nothing.
 *
 * Gemini has no per-token cache-write charge (cache storage is billed
 * per hour, which a receipt cannot attribute per request), so
 * cacheWrite is always 0. User messages carry no usage and are skipped
 * silently; lines with no usable usage are counted as skipped.
 */
function extractUsage(raw: any): Usage | null {
  const t = raw?.tokens;
  if (!t || typeof t !== "object") return null;
  const inputTotal = num(t.input);
  const cached = Math.min(num(t.cached), inputTotal);
  const thought = num(t.thoughts ?? t.thought ?? t.thinking);
  const output = num(t.output) + thought;
  const input = inputTotal - cached;
  if (input + output + cached === 0) return null;
  return { input, output, cacheWrite: 0, cacheRead: cached };
}

function parseTimestamp(raw: any): { timestamp: string | undefined; timestampMs: number | undefined } {
  const v = raw?.timestamp;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    return { timestamp: v, timestampMs: Number.isFinite(ms) ? ms : undefined };
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Epoch seconds (10 digits) or milliseconds (13 digits).
    const ms = v >= 1e12 ? v : v * 1000;
    const d = new Date(ms);
    if (Number.isFinite(d.getTime())) {
      return { timestamp: d.toISOString(), timestampMs: ms };
    }
  }
  return { timestamp: undefined, timestampMs: undefined };
}

function messageToEntry(
  raw: any,
  sessionId: string | undefined,
  project: string | undefined,
): LogEntry | null {
  if (!raw || typeof raw !== "object" || raw.type !== "gemini") return null;
  const usage = extractUsage(raw);
  if (!usage) return null;
  const { timestamp, timestampMs } = parseTimestamp(raw);
  return {
    agent: "gemini",
    sessionId,
    project,
    model: typeof raw.model === "string" ? raw.model : undefined,
    timestamp,
    timestampMs,
    usage,
    subagent: false,
  };
}

/**
 * Parse one Gemini CLI session file (.json or .jsonl).
 *
 * A .json file is one session object ({ sessionId, messages: [...] });
 * a .jsonl file is one message object per line, and a line that is
 * itself a session object with a `messages` array is also accepted.
 * Unknown fields are ignored; malformed lines are counted as skipped,
 * never fatal. Not verified against a real Gemini CLI install yet —
 * the shapes above come from the sources in the header comment, and
 * the fixtures in test/fixtures/session-2026-11-*.jsonl/.json mirror them.
 */
export function parseGeminiFile(filePath: string, project?: string): ParseResult {
  const entries: LogEntry[] = [];
  let skippedLines = 0;
  if (!existsSync(filePath)) return { entries, skippedLines, files: [] };
  const text = readFileSync(filePath, "utf8");
  const fileSessionId = basename(filePath).replace(/\.jsonl?$/, "");

  const handleObject = (raw: any, sessionId: string | undefined): void => {
    if (!raw || typeof raw !== "object") {
      skippedLines++;
      return;
    }
    if (Array.isArray(raw.messages)) {
      const sid =
        typeof raw.sessionId === "string" ? raw.sessionId : sessionId;
      for (const m of raw.messages) {
        const e = messageToEntry(m, sid, project);
        if (e) entries.push(e);
        else if (m && typeof m === "object" && m.type === "gemini") skippedLines++;
        // User messages carry no usage; they are not "skipped" lines.
      }
      return;
    }
    if (raw.type === "user") return; // no usage, expected
    const e = messageToEntry(raw, sessionId, project);
    if (e) entries.push(e);
    else skippedLines++;
  };

  if (filePath.endsWith(".json")) {
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      return { entries, skippedLines: 1, files: [filePath] };
    }
    if (Array.isArray(raw)) {
      for (const m of raw) handleObject(m, fileSessionId);
    } else {
      handleObject(raw, fileSessionId);
    }
    return { entries, skippedLines, files: [filePath] };
  }

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
    handleObject(raw, fileSessionId);
  }
  return { entries, skippedLines, files: [filePath] };
}
