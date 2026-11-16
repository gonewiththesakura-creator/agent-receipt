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
