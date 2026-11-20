import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cli = join(root, "dist", "cli.js");
const fixtures = join(here, "fixtures");

const { parseClaudeFile } = await import("../dist/parsers/claude.js");
const { parseCodexFile } = await import("../dist/parsers/codex.js");
const { buildReceipt } = await import("../dist/receipt/receipt.js");
const { forecastResume } = await import("../dist/receipt/forecast.js");
const { findModelSwitches } = await import("../dist/receipt/check.js");
const { explainReceipt, verifyExplanation, explainWithLlm } = await import("../dist/explain/index.js");
const { renderStatusline, compactTokens } = await import("../dist/receipt/statusline.js");
const { priceFor, costOf, PRICE_TABLE_VERSION } = await import("../dist/pricing/prices.js");
const { buildWeeklyReport, weeklyWindow, topDriverOf } = await import("../dist/receipt/weekly.js");
const { renderWeeklyText } = await import("../dist/receipt/render.js");

const approx = (a, b, eps = 1e-9) =>
  assert.ok(a !== null && Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

// --- 1. Cache-rewrite receipt (synthetic fixture, hand-computed) ---
// Sonnet $3 in / $3.75 cache-write / $0.30 cache-read / $15 out per 1M.
// Opus   $15 in / $18.75 cache-write / $1.50 cache-read / $75 out per 1M.
// msg1: (10000*3 + 50000*3.75 + 2000*15)/1e6 = 0.2475
// msg2: (1000*3 + 50000*0.30 + 500*15)/1e6   = 0.0255
// msg3: (500*3 + 50000*3.75 + 300*15)/1e6    = 0.1935  (resume rewrite)
// msg4: (2000*15 + 50000*1.50 + 1000*75)/1e6 = 0.1800  (opus)
// msg5: (1000*15 + 10000*1.50 + 500*75)/1e6  = 0.0675  (opus subagent)
// total = 0.7140
test("cache-rewrite receipt totals and breakdown", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  assert.equal(r.entries.length, 5);
  assert.equal(r.skippedLines, 1); // one malformed line; the summary line is ignored, not counted
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  approx(receipt.costUsd, 0.714);
  assert.equal(receipt.usage.cacheWrite, 100000);
  assert.equal(receipt.usage.cacheRead, 110000);
  // Only the post-gap rewrite counts (msg3); the first message's cache creation is not a rewrite.
  assert.equal(receipt.cacheRewriteCount, 1);
  assert.equal(receipt.cacheRewriteTokens, 50000);
  approx(receipt.cacheRewriteCostUsd, 0.1875);
  assert.equal(receipt.resumeCount, 1);
  approx(receipt.resumeCostUsd, 0.1875);
  approx(receipt.subagentCostUsd, 0.0675);
  assert.equal(receipt.modelSwitches.length, 1);
  assert.equal(receipt.modelSwitches[0].fromModel, "claude-sonnet-4-5");
  assert.equal(receipt.modelSwitches[0].toModel, "claude-opus-4-1");
  approx(receipt.modelSwitches[0].segmentCostUsd, 0.2475);
  assert.equal(receipt.modelSwitches[0].segmentTokens, 64500);
  // Why-expensive lines: cache rewrite is 26% of the receipt; the switch segment is 35%.
  assert.ok(receipt.whyExpensive.length >= 2);
  assert.match(receipt.whyExpensive.join(" "), /cache rewrite/i);
  assert.match(receipt.whyExpensive.join(" "), /Model switch/i);
});

// --- 2. Codex parser: best-effort shapes, unknown model -> tokens only ---
test("codex parser handles its shapes and unknown prices honestly", () => {
  const r = parseCodexFile(join(fixtures, "codex-session.jsonl"));
  assert.equal(r.entries.length, 4);
  assert.equal(r.skippedLines, 1); // the non-JSON line
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  assert.equal(receipt.costUsd, null); // unknown model makes the dollar total unknown
  assert.deepEqual(receipt.unknownPriceModels, ["some-unknown-model-xyz"]);
  assert.equal(
    receipt.usage.input + receipt.usage.output + receipt.usage.cacheRead + receipt.usage.cacheWrite,
    50950,
  );
});

// --- 3. Resume forecast ---
test("resume forecast warns when the cache TTL has expired", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  // Last activity 12:06; "now" is 14:00 -> 114 min idle, TTL 60 min -> expired.
  const f = forecastResume(r.entries, { nowMs: Date.parse("2026-11-09T14:00:00Z") });
  assert.ok(f);
  assert.equal(f.cacheExpired, true);
  assert.equal(f.idleMinutes, 114);
  // Context = largest single-entry token total (msg1: 62,000). Last model is Opus, cache-write $18.75/1M.
  assert.equal(f.contextTokens, 62000);
  approx(f.estimatedResumeCostUsd, (62000 * 18.75) / 1_000_000);
  assert.match(f.warning ?? "", /TTL/);
});

test("resume forecast is cheap while the cache is still warm", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  // "now" is 12:30 -> 24 min idle, inside the 60 min TTL.
  const f = forecastResume(r.entries, { nowMs: Date.parse("2026-11-09T12:30:00Z") });
  assert.ok(f);
  assert.equal(f.cacheExpired, false);
  // Warm resume pays the cache-read price ($1.50/1M for Opus).
  approx(f.estimatedResumeCostUsd, (62000 * 1.5) / 1_000_000);
});

// --- 4. Model-switch report ---
test("model-switch report finds the switch and prices its segment", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const switches = findModelSwitches(r.entries);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].fromModel, "claude-sonnet-4-5");
  assert.equal(switches[0].toModel, "claude-opus-4-1");
  approx(switches[0].segmentCostUsd, 0.2475);
});

// --- 5. Malformed log lines are skipped, never fatal ---
test("malformed lines are skipped without crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-malformed-"));
  const file = join(dir, "bad.jsonl");
  writeFileSync(
    file,
    [
      "not json",
      "",
      '{"type":"assistant","timestamp":"2026-11-09T10:00:00Z","sessionId":"m","message":{"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":5}}}',
      "[1,2,3]",
      '{"message":{}}',
    ].join("\n"),
    "utf8",
  );
  const r = parseClaudeFile(file);
  assert.equal(r.entries.length, 1);
  assert.equal(r.skippedLines, 3); // non-JSON, array, and usage-less object
});

// --- 6. Cap stop: the wrapper really kills the child and writes evidence ---
test("run --cap stops the child and writes an evidence receipt", { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-cap-"));
  const logFile = join(dir, "session.jsonl");
  writeFileSync(logFile, "", "utf8");
  // Each appended line costs $0.06; cap $0.10 means the 2nd line trips it.
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let code = null;
  try {
    const res = await execFileAsync(
      process.execPath,
      [
        cli,
        "run",
        "--cap",
        "0.10",
        "--log-dir",
        dir,
        "--out",
        dir,
        "--",
        process.execPath,
        join(fixtures, "append-log.mjs"),
        logFile,
      ],
      { timeout: 15000 },
    );
    stdout = res.stdout;
    stderr = res.stderr;
    code = 0;
  } catch (err) {
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    code = err.code ?? null;
  }
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 12000, `cap run took ${elapsed}ms — the child was not stopped promptly`);
  assert.equal(code, 3, `expected exit code 3 (stopped by cap), got ${code}; stdout=${stdout} stderr=${stderr}`);
  assert.match(stdout, /cap_exceeded/);
  const evidencePath = join(dir, "cap-evidence.json");
  assert.ok(existsSync(evidencePath), "cap-evidence.json was not written");
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.stopped, true);
  assert.match(evidence.reason, /cap_exceeded/);
  assert.ok(evidence.finalIncrementalCostUsd >= 0.1);
  assert.ok(existsSync(join(dir, "cap-evidence.md")), "cap-evidence.md was not written");
});

// --- 7. CLI smoke tests on fixtures ---
test("CLI receipt on a fixture file prints a receipt", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "receipt",
    "--file",
    join(fixtures, "claude-session.jsonl"),
  ]);
  assert.match(stdout, /agent-receipt — session cost receipt/);
  assert.match(stdout, /\$0\.7140/);
  assert.match(stdout, /cache rewrite/i);
});

test("CLI resume --forecast on a fixture file", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "resume",
    "--forecast",
    "--file",
    join(fixtures, "claude-session.jsonl"),
  ]);
  assert.match(stdout, /resume forecast/i);
  assert.match(stdout, /Cache TTL/);
});

test("CLI check reports the model switch", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "check",
    "--file",
    join(fixtures, "claude-session.jsonl"),
  ]);
  assert.match(stdout, /claude-sonnet-4-5 → claude-opus-4-1/);
});

test("CLI with no logs found reports that instead of inventing data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-empty-"));
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "daily",
    "--date",
    "2026-11-09",
    "--log-dir",
    dir,
  ]);
  assert.match(stdout, /No log entries found/);
});

// --- 8. 混合架构：确定性层可复现，解释层只读收据 ---
test("deterministic layer: same fixture twice gives byte-identical receipts", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const a = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  const b = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("explain layer: rule-based lines only use numbers from the receipt", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  const lines = explainReceipt(receipt);
  assert.ok(lines.length >= 1 && lines.length <= 3);
  assert.deepEqual(verifyExplanation(lines, receipt), []);
});

test("explain layer: fabricated numbers are flagged, never passed", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  const bad = [
    "Cache rewrites cost $9.9999 (87% of this receipt).", // 数字收据里没有
    "Subagents burned 12,345 tokens for nothing.", // token 数收据里没有
  ];
  const violations = verifyExplanation(bad, receipt);
  assert.ok(violations.some((v) => v.kind === "amount" && v.value === "$9.9999"));
  assert.ok(violations.some((v) => v.kind === "percent" && v.value === "87%"));
  assert.ok(violations.some((v) => v.kind === "tokens" && v.value === "12,345 tokens"));
});

test("explain layer: LLM adapter drops lines with numbers not in the receipt", async () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  // 假 adapter：第一行是收据里真实的解释，第二行编了一个假数字。
  const fakeAdapter = async () =>
    `${receipt.whyExpensive[0]}\nCache rewrites cost $9.9999, a huge waste.`;
  const { lines, dropped } = await explainWithLlm(receipt, fakeAdapter);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], receipt.whyExpensive[0]);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /\$9\.9999/);
});

test("CLI explain reads a receipt JSON and prints only receipt-backed lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-explain-"));
  const { stdout: receiptOut } = await execFileAsync(process.execPath, [
    cli,
    "receipt",
    "--file",
    join(fixtures, "claude-session.jsonl"),
    "--out",
    dir,
  ]);
  assert.match(receiptOut, /receipt\.json/);
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "explain",
    "--file",
    join(dir, "receipt.json"),
  ]);
  assert.match(stdout, /cache rewrite/i);
  assert.match(stdout, /\$0\.1875/);
});

// --- 9. 状态栏 statusline：严格一行，只读收据字段 ---
test("statusline compact token format", () => {
  assert.equal(compactTokens(228800), "228.8k");
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(1000), "1k");
  assert.equal(compactTokens(1500000), "1.5M");
});

test("statusline with dollars: one line, $0.71, rewrite and switch shown", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  const line = renderStatusline(receipt);
  assert.equal(line.split("\n").length, 1);
  // 总成本 $0.714 -> $0.71；重写 $0.1875 占 26%；切换后段 $0.2475 占 35%。
  assert.equal(line, "💰 $0.71 · 228.8k tokens · 26% rewrite · switch +$0.25");
});

test("statusline with unknown prices: no dollars, only tokens plus 'no $ price'", () => {
  const r = parseCodexFile(join(fixtures, "codex-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  assert.equal(receipt.costUsd, null);
  const line = renderStatusline(receipt);
  assert.equal(line.split("\n").length, 1);
  assert.match(line, /51k tokens · no \$ price/);
  assert.doesNotMatch(line, /\$\d/); // 没有任何美元数字
});

test("statusline --no-cost: tokens and rewrite only, no dollar signs at all", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  const line = renderStatusline(receipt, { noCost: true });
  assert.equal(line, "228.8k tokens · 26% rewrite");
  assert.equal(line.includes("$"), false);
});

test("statusline hides rewrite below 20%", () => {
  const r = parseClaudeFile(join(fixtures, "claude-session.jsonl"));
  const receipt = buildReceipt(r.entries, { skippedLines: r.skippedLines });
  // 重写成本改成 $0.01，只占总成本约 1%，不应出现在状态栏。
  const small = { ...receipt, cacheRewriteCostUsd: 0.01 };
  assert.doesNotMatch(renderStatusline(small), /rewrite/);
});

test("CLI statusline on a fixture file prints exactly one line with $0.71", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "statusline",
    "--file",
    join(fixtures, "claude-session.jsonl"),
  ]);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\$0\.71/);
});

test("CLI statusline with no logs prints one line and exits 0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-statusline-empty-"));
  const { stdout } = await execFileAsync(process.execPath, [
    cli,
    "statusline",
    "--log-dir",
    dir,
  ]);
  assert.equal(stdout.trim(), "agent-receipt: no logs found");
});

// --- 10. 周报 weekly：窗口内按会话排最贵的 3 个，带主因 ---
// Sonnet $3 in / $3.75 cache-write / $0.30 cache-read / $15 out per 1M.
// Session A (2026-11-16): msg1 (10000*3 + 50000*3.75 + 2000*15)/1e6 = 0.2475;
//   msg2 after a 2h gap (1000*3 + 50000*3.75 + 500*15)/1e6 = 0.1980 (rewrite 0.1875).
//   Session A total 0.4455, rewrite share 42%.
// Session B (2026-11-17): (1000*3 + 100*15)/1e6 = 0.0045.
// Session C (2026-11-01): outside the 7-day window ending 2026-11-18.
function weeklyEntry(sessionId, iso, usage, subagent = false) {
  return {
    agent: "claude",
    sessionId,
    project: "proj",
    model: "claude-sonnet-4-5",
    timestamp: iso,
    timestampMs: new Date(iso).getTime(),
    usage,
    subagent,
  };
}

test("weeklyWindow: 7 days ending on the end date, inclusive", () => {
  const { startMs, endMs } = weeklyWindow("2026-11-18", 7);
  assert.equal(new Date(startMs).toISOString().slice(0, 10), "2026-11-12");
  assert.equal(new Date(endMs).toISOString().slice(0, 10), "2026-11-18");
});

test("weekly report ranks sessions by cost and names the top driver", () => {
  const entries = [
    weeklyEntry("s-A", "2026-11-16T10:00:00Z", { input: 10000, output: 2000, cacheWrite: 50000, cacheRead: 0 }),
    weeklyEntry("s-A", "2026-11-16T12:00:00Z", { input: 1000, output: 500, cacheWrite: 50000, cacheRead: 0 }),
    weeklyEntry("s-B", "2026-11-17T10:00:00Z", { input: 1000, output: 100, cacheWrite: 0, cacheRead: 0 }),
    weeklyEntry("s-C", "2026-11-01T10:00:00Z", { input: 100000, output: 10000, cacheWrite: 0, cacheRead: 0 }),
    { ...weeklyEntry("s-A", "2026-11-16T13:00:00Z", { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), timestamp: undefined, timestampMs: undefined },
  ];
  const w = buildWeeklyReport(entries, { endDate: "2026-11-18", days: 7 });
  assert.equal(w.startDate, "2026-11-12");
  assert.equal(w.sessionCount, 2); // s-C is outside the window
  assert.equal(w.untimestampedEntries, 1);
  approx(w.totalCostUsd, 0.45);
  assert.equal(w.topSessions.length, 2);
  assert.equal(w.topSessions[0].sessionId, "s-A");
  approx(w.topSessions[0].costUsd, 0.4455);
  assert.match(w.topSessions[0].topDriver, /cache rewrites \$0\.1875 \(42%\)/);
  assert.equal(w.topSessions[1].sessionId, "s-B");
  assert.equal(w.topSessions[1].topDriver, "spread across messages (no single driver)");
  approx(w.totalCacheRewriteCostUsd, 0.1875);
});

test("weekly report with no priced model: total null, sessions still ranked by tokens", () => {
  const entries = [
    { ...weeklyEntry("s-X", "2026-11-17T10:00:00Z", { input: 5000, output: 500, cacheWrite: 0, cacheRead: 0 }), model: "unknown-model-9" },
  ];
  const w = buildWeeklyReport(entries, { endDate: "2026-11-18", days: 7 });
  assert.equal(w.totalCostUsd, null);
  assert.equal(w.unknownCostSessions, 1);
  assert.equal(w.topSessions[0].sessionId, "s-X");
});

test("CLI weekly on fixture logs prints the top session with its driver", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-weekly-"));
  const projDir = join(dir, "proj");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(projDir, { recursive: true });
  const line = (sessionId, iso, input, output, cacheWrite) =>
    JSON.stringify({ type: "assistant", timestamp: iso, sessionId, message: { model: "claude-sonnet-4-5", usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: 0 } } });
  writeFileSync(join(projDir, "s-a.jsonl"), [
    line("s-a", "2026-11-16T10:00:00Z", 10000, 2000, 50000),
    line("s-a", "2026-11-16T12:00:00Z", 1000, 500, 50000),
    "",
  ].join("\n"));
  writeFileSync(join(projDir, "s-b.jsonl"), line("s-b", "2026-11-17T10:00:00Z", 1000, 100, 0) + "\n");
  const { stdout } = await execFileAsync(process.execPath, [
    cli, "weekly", "--date", "2026-11-18", "--log-dir", dir,
  ]);
  assert.match(stdout, /weekly report \(2026-11-12 to 2026-11-18, 7 days\)/);
  assert.match(stdout, /Most expensive sessions/);
  assert.match(stdout, /1\. s-a/);
  assert.match(stdout, /cache rewrites \$0\.1875 \(42%\)/);
  assert.match(stdout, /2\. s-b/);
});

test("CLI weekly with an empty log dir reports nothing invented", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-receipt-weekly-empty-"));
  const { stdout } = await execFileAsync(process.execPath, [
    cli, "weekly", "--date", "2026-11-18", "--log-dir", dir,
  ]);
  assert.match(stdout, /No log entries found for weekly/);
});

test("CLI weekly rejects --days outside 1..90", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cli, "weekly", "--days", "0"]),
    /--days must be an integer between 1 and 90/,
  );
});

// --- 11. 标价表：2026-11-19 对厂商定价页核实后的价格 ---
// 来源：platform.claude.com/docs/en/about-claude/pricing 与
// platform.openai.com/docs/pricing（2026-11-19 查阅）。数字按每 1M token。
test("price table version is the verified 2026-11-19 table", () => {
  assert.equal(PRICE_TABLE_VERSION, "2026-11-19");
});

test("price table: Opus 4.5-4.8 are $5/$25, not the old Opus 4.1 $15/$75", () => {
  // Regression: the old "claude-opus-4" prefix priced Opus 4.5 sessions 3x high.
  for (const model of ["claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]) {
    assert.deepEqual(priceFor(model), { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 });
  }
  // Opus 4 / 4.1 really are $15/$75 — the fix must not change them.
  assert.deepEqual(priceFor("claude-opus-4-1"), { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 });
  assert.deepEqual(priceFor("claude-opus-4"), { input: 15, cacheWrite: 18.75, cacheRead: 1.5, output: 75 });
});

test("price table: Claude 5-family, Fable and Mythos are priced", () => {
  assert.deepEqual(priceFor("claude-opus-5-5"), { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 });
  assert.deepEqual(priceFor("claude-opus-5"), { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 });
  assert.deepEqual(priceFor("claude-sonnet-5-5"), { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 });
  assert.deepEqual(priceFor("claude-sonnet-5"), { input: 2, cacheWrite: 2.5, cacheRead: 0.2, output: 10 });
  assert.deepEqual(priceFor("claude-fable-5-2"), { input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 });
  assert.deepEqual(priceFor("claude-fable-5-1"), { input: 10, cacheWrite: 12.5, cacheRead: 0.25, output: 50 });
  assert.deepEqual(priceFor("claude-fable-5"), { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 });
  assert.deepEqual(priceFor("claude-mythos-5-2"), { input: 8, cacheWrite: 10, cacheRead: 0.2, output: 40 });
  assert.deepEqual(priceFor("claude-mythos-5"), { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 });
  // Dated model ids still match by prefix.
  assert.deepEqual(priceFor("claude-opus-5-20261101"), { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 });
});

test("price table: Haiku 5.5 stays unpriced (prompt-length tiered, never guessed)", () => {
  assert.equal(priceFor("claude-haiku-5-5"), null);
  assert.equal(priceFor("claude-haiku-5-5-20261101"), null);
  assert.equal(costOf("claude-haiku-5-5", { input: 1000, cacheWrite: 0, cacheRead: 0, output: 100 }), null);
  // Haiku 4.5 is still priced.
  assert.deepEqual(priceFor("claude-haiku-4-5"), { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 });
});

test("price table: GPT-6 variants priced, unknown models still null", () => {
  assert.deepEqual(priceFor("gpt-6.2-astra"), { input: 8, cacheWrite: 10, cacheRead: 0.4, output: 40 });
  assert.deepEqual(priceFor("gpt-6.2-sol"), { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 });
  assert.deepEqual(priceFor("gpt-6-astra"), { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 });
  assert.deepEqual(priceFor("gpt-6.1-sol"), { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 });
  assert.deepEqual(priceFor("gpt-6-cyber"), { input: 20, cacheWrite: 25, cacheRead: 2, output: 100 });
  assert.deepEqual(priceFor("gpt-6-rosalind"), { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 });
  // The "-law" variants share their base model's price via the same prefix.
  assert.deepEqual(priceFor("gpt-6.2-astra-law"), { input: 8, cacheWrite: 10, cacheRead: 0.4, output: 40 });
  assert.equal(priceFor("some-unknown-model-xyz"), null);
});

test("price table: an Opus 4.5 session costs a third of the old (wrong) figure", () => {
  const usage = { input: 1_000_000, cacheWrite: 0, cacheRead: 0, output: 1_000_000 };
  approx(costOf("claude-opus-4-5", usage), 30); // $5 in + $25 out
  approx(costOf("claude-opus-4-1", usage), 90); // $15 in + $75 out
});
