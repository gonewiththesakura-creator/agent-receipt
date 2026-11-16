import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { parseClaudeFile } from "./claude.js";
import { parseCodexFile } from "./codex.js";
import type { ParseResult } from "../types.js";

export function defaultClaudeDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function defaultCodexDir(): string {
  return join(homedir(), ".codex", "sessions");
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkJsonl(p, out);
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

/** Project name is the parent directory of the session file, when present. */
function projectOf(file: string, baseDir: string): string | undefined {
  const rel = file.slice(baseDir.length + 1);
  const parts = rel.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : undefined;
}

export interface DiscoverOptions {
  logDir?: string;
  agent?: "claude" | "codex" | "all";
}

/** Read every session log under the default (or given) directories. Read-only. */
export function discoverLogs(opts: DiscoverOptions = {}): ParseResult {
  const agent = opts.agent ?? "all";
  const entries: ParseResult["entries"] = [];
  let skippedLines = 0;
  const files: string[] = [];

  // A single explicit --log-dir is walked once: each file is tried as
  // Claude first, then Codex, so the same file is never counted twice.
  if (opts.logDir) {
    for (const f of walkJsonl(opts.logDir)) {
      const r = parseClaudeFile(f, projectOf(f, opts.logDir));
      const use = r.entries.length > 0 ? r : parseCodexFile(f, projectOf(f, opts.logDir));
      entries.push(...use.entries);
      skippedLines += use.skippedLines;
      files.push(...use.files);
    }
    entries.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
    return { entries, skippedLines, files };
  }

  if (agent === "claude" || agent === "all") {
    const dir = opts.logDir ?? defaultClaudeDir();
    for (const f of walkJsonl(dir)) {
      const r = parseClaudeFile(f, projectOf(f, dir));
      entries.push(...r.entries);
      skippedLines += r.skippedLines;
      files.push(...r.files);
    }
  }
  if (agent === "codex" || agent === "all") {
    const dir = opts.logDir ?? defaultCodexDir();
    for (const f of walkJsonl(dir)) {
      const r = parseCodexFile(f, projectOf(f, dir));
      entries.push(...r.entries);
      skippedLines += r.skippedLines;
      files.push(...r.files);
    }
  }
  entries.sort((a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0));
  return { entries, skippedLines, files };
}

/** Group entries by session id (falling back to file-derived grouping by project + day). */
export function groupBySession(
  entries: ParseResult["entries"],
): Map<string, ParseResult["entries"]> {
  const map = new Map<string, ParseResult["entries"]>();
  for (const e of entries) {
    const key =
      e.sessionId ??
      `${e.agent}:${e.project ?? "unknown"}:${(e.timestamp ?? "").slice(0, 10)}`;
    const list = map.get(key) ?? [];
    list.push(e);
    map.set(key, list);
  }
  return map;
}

export function sessionFileName(file: string): string {
  return basename(file, ".jsonl");
}
