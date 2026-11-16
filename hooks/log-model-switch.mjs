#!/usr/bin/env node
/**
 * Claude Code hook: log model changes.
 *
 * Wire it up in ~/.claude/settings.json under hooks, e.g. as a
 * PostToolUse / SessionStart hook — see hooks/settings.example.json.
 *
 * What it actually does: reads the hook JSON payload from stdin and
 * appends a line to ~/.agent-receipt/model-switches.log with the
 * timestamp and the model, if the payload carries one.
 *
 * What it does NOT do: it cannot block a model switch mid-flight.
 * Claude Code hooks run around tool calls, not around the model's
 * choice of model. A switch is only visible after the fact, in the
 * session log. `agent-receipt check` reports those switches and
 * their cost impact retrospectively. Do not configure this hook
 * expecting it to confirm or veto a switch.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let payload: any = {};
  try {
    payload = JSON.parse(input || "{}");
  } catch {
    // Not JSON — nothing to log, exit quietly.
    process.exit(0);
  }
  const model =
    payload?.model ?? payload?.message?.model ?? payload?.payload?.model;
  if (typeof model !== "string") process.exit(0);
  const dir = join(homedir(), ".agent-receipt");
  mkdirSync(dir, { recursive: true });
  appendFileSync(
    join(dir, "model-switches.log"),
    JSON.stringify({
      ts: new Date().toISOString(),
      model,
      session_id: payload?.session_id ?? payload?.sessionId ?? null,
      hook_event: payload?.hook_event_name ?? null,
    }) + "\n",
    "utf8",
  );
  process.exit(0);
});
