#!/usr/bin/env node
/**
 * agent-receipt skill 脚本：解释“为什么贵”。
 *
 * 只做两件事，不做任何计算：
 *   1. 拿到一份收据 JSON（--receipt 直接给，或 --log 先由 CLI 生成）；
 *   2. 把它交给 CLI 的 explain 命令，由确定性解释层输出解释。
 *
 * 解释文本里的每一个数字都必须能在收据 JSON 里找到对应字段，
 * 这一点由 src/explain/ 的校验保证，本脚本不补充、不改写数字。
 *
 * 用法（在 skill 目录里）：
 *   node scripts/explain.mjs --receipt <receipt.json>
 *   node scripts/explain.mjs --log <会话 .jsonl> [--out DIR]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 本脚本在 <仓库>/skills/agent-receipt/scripts/ 里，仓库根目录是上三级。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cli = join(repoRoot, "dist", "cli.js");

if (!existsSync(cli)) {
  console.error(
    "agent-receipt 还没有构建：请先在仓库根目录执行 npm install && npm run build，"
    + "再用本脚本。",
  );
  process.exit(2);
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const args = process.argv.slice(2);
let receiptPath;
let logPath;
let outDir;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--receipt") receiptPath = args[++i];
  else if (args[i] === "--log") logPath = args[++i];
  else if (args[i] === "--out") outDir = args[++i];
  else fail(`未知参数：${args[i]}。用法：explain.mjs --receipt <receipt.json> 或 --log <会话 .jsonl> [--out DIR]`);
}

if (receiptPath) {
  if (!existsSync(receiptPath)) fail(`收据文件不存在：${receiptPath}`);
  runCli(["explain", "--file", receiptPath]);
} else if (logPath) {
  if (!existsSync(logPath)) fail(`会话日志不存在：${logPath}`);
  // 先由 CLI 生成收据 JSON（写进临时目录或 --out），再解释它。
  const dir = outDir ?? mkdtempSync(join(tmpdir(), "agent-receipt-explain-"));
  const gen = spawnSync(process.execPath, [cli, "receipt", "--file", logPath, "--out", dir], {
    stdio: "inherit",
  });
  if ((gen.status ?? 1) !== 0) process.exit(gen.status ?? 1);
  const jsonPath = join(dir, "receipt.json");
  if (!existsSync(jsonPath)) fail("CLI 没有写出 receipt.json，无法解释。");
  // 校验一下 JSON 能解析，再交给 explain 命令。
  JSON.parse(readFileSync(jsonPath, "utf8"));
  runCli(["explain", "--file", jsonPath]);
} else {
  fail("请给 --receipt <receipt.json> 或 --log <会话 .jsonl>。");
}
