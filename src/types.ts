/** Normalised usage record — the single shape every parser produces. */
export interface Usage {
  /** Fresh (uncached) input tokens. */
  input: number;
  /** Output tokens. */
  output: number;
  /** Tokens written into prompt cache. */
  cacheWrite: number;
  /** Tokens read from prompt cache (cache hits). */
  cacheRead: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

export function totalTokens(u: Usage): number {
  return u.input + u.output + u.cacheWrite + u.cacheRead;
}

/** One parsed message / API call from a session log. */
export interface LogEntry {
  /** Agent that produced the log: "claude" or "codex". */
  agent: "claude" | "codex";
  /** Session id (file name or explicit id), if known. */
  sessionId: string | undefined;
  /** Project name, if the log path carries one. */
  project: string | undefined;
  /** Model id as written in the log, if present. */
  model: string | undefined;
  /** ISO timestamp, if present. */
  timestamp: string | undefined;
  /** Epoch ms, if the timestamp parsed. */
  timestampMs: number | undefined;
  usage: Usage;
  /** True when this entry came from a subagent / sidechain. */
  subagent: boolean;
  /** True when this entry looks like a session resume (gap + cache rewrite). Set by receipt analysis, not the parser. */
  isResume?: boolean;
}

export interface ParseResult {
  entries: LogEntry[];
  /** Lines that could not be parsed as JSON or had no usable shape. Skipped, never fatal. */
  skippedLines: number;
  /** Files read. */
  files: string[];
}

export const CACHE_TTL_MS_DEFAULT = 60 * 60 * 1000; // 1 hour, Claude prompt-cache TTL

/** A model switch inside a session, with the cost of the segment after it. */
export interface ModelSwitch {
  index: number;
  timestamp: string | undefined;
  fromModel: string | undefined;
  toModel: string | undefined;
  /** Estimated cost of entries from this switch until the next switch / end. Null if any model price unknown. */
  segmentCostUsd: number | null;
  segmentTokens: number;
}
