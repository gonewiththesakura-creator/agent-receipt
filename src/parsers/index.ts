import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { parseClaudeFile } from "./claude.js";
import { parseCodexFile } from "./codex.js";
import { parseGeminiFile } from "./gemini.js";
import type { ParseResult } from "../types.js";

export function defaultClaudeDir(): string {
  return join(homedir(), ".claude", "projects");
}

export function defaultCodexDir(): string {
  return join(homedir(), ".codex", "sessions");
}

export function defaultGeminiDir(): string {
  return join(homedir(), ".gemini", "tmp");
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

/**
 * Gemini session files only: ~/.gemini/tmp/<project>/chats/session-*.
 * The parent-directory and name checks keep unrelated files out —
 * settings.json, oauth_creds.json, checkpoints, and anything else
 * under ~/.gemini/tmp is not a session log.
 */
function walkGemini(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkGemini(p, out);
    } else if (
      (name.endsWith(".jsonl") || name.endsWith(".json")) &&
      name.startsWith("session-") &&
      basename(dir) === "chats"
    ) {
      out.push(p);
    }
  }
  return out;
}

/** For a --log-dir, collect .jsonl and .json session files alike. */
function walkSessionFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkSessionFiles(p, out);
    else if (name.endsWith(".jsonl") || name.endsWith(".json")) out.push(p);
  }
  return out;
}

/**
 * Parser order for one file, by filename. Gemini session files are
 * tried as Gemini first: a Codex-shaped parser would otherwise
 * misread a Gemini message's `tokens.cached` as a cache-only Codex
 * entry. Everything else is tried Claude, then Codex, then Gemini.
 */
export function parsersForFile(file: string): Array<"claude" | "codex" | "gemini"> {
  const name = basename(file);
  if (name.startsWith("session-") || file.endsWith(".json")) {
    return ["gemini", "claude", "codex"];
  }
  return ["claude", "codex", "gemini"];
}

export function parseWithOrder(
  file: string,
  project: string | undefined,
  order: Array<"claude" | "codex" | "gemini">,
): ParseResult {
  for (const kind of order) {
    const r =
      kind === "claude"
        ? parseClaudeFile(file, project)
        : kind === "codex"
          ? parseCodexFile(file, project)
          : parseGeminiFile(file, project);
    if (r.entries.length > 0) return r;
  }
  // No parser found entries: report the first parser's skipped count
  // so the user still hears that the file was unreadable.
  const first =
    order[0] === "claude"
      ? parseClaudeFile(file, project)
      : order[0] === "codex"
        ? parseCodexFile(file, project)
        : parseGeminiFile(file, project);
  return first;
}

/** Project name is the parent directory of the session file, when present. */
function projectOf(file: string, baseDir: string): string | undefined {
  const rel = file.slice(baseDir.length + 1);
  const parts = rel.split("/");
  return parts.length > 1 ? parts[parts.length - 2] : undefined;
}

/** Project name for a Gemini session file: the folder above `chats/`. */
function projectOfGemini(file: string): string | undefined {
  const parts = file.split("/");
  const chatsIdx = parts.lastIndexOf("chats");
  return chatsIdx > 0 ? parts[chatsIdx - 1] : undefined;
}

export interface DiscoverOptions {
  logDir?: string;
  agent?: "claude" | "codex" | "gemini" | "all";
}

/** Read every session log under the default (or given) directories. Read-only. */
export function discoverLogs(opts: DiscoverOptions = {}): ParseResult {
  const agent = opts.agent ?? "all";
  const entries: ParseResult["entries"] = [];
  let skippedLines = 0;
  const files: string[] = [];

  // A single explicit --log-dir is walked once: each file is tried in
  // filename order (Gemini first for session-* / .json files), so the
  // same file is never counted twice.
  if (opts.logDir) {
    for (const f of walkSessionFiles(opts.logDir)) {
      const r = parseWithOrder(f, projectOf(f, opts.logDir), parsersForFile(f));
      entries.push(...r.entries);
      skippedLines += r.skippedLines;
      files.push(...r.files);
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
  if (agent === "gemini" || agent === "all") {
    const dir = opts.logDir ?? defaultGeminiDir();
    for (const f of walkGemini(dir)) {
      const r = parseGeminiFile(f, projectOfGemini(f));
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
