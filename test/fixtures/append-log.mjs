#!/usr/bin/env node
// Test fixture only: appends one synthetic Claude Code JSONL usage line
// to the given log file every 150 ms, forever (the cap test kills it).
// Each line costs $0.06 at the v0.1 price table (10k input + 2k output Sonnet).
import { appendFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: append-log.mjs <log-file>");
  process.exit(2);
}
let i = 0;
setInterval(() => {
  i++;
  const line = JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    sessionId: "cap-test",
    message: {
      model: "claude-sonnet-4-5",
      usage: {
        input_tokens: 10000,
        output_tokens: 2000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  });
  appendFileSync(file, line + "\n", "utf8");
}, 150);
