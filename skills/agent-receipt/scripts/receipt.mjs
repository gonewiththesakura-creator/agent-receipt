#!/usr/bin/env node
/**
 * agent-receipt skill 脚本：收据 / 预测 / 检查 / 上限的薄封装。
 *
 * 只做一件事：把参数原样传给仓库 CLI（dist/cli.js），把输出原样打出来。
 * 不复制任何解析或计算逻辑——金额与 token 数只由 CLI 的确定性代码算。
 *
 * 用法（在 skill 目录里）：
 *   node scripts/receipt.mjs daily
 *   node scripts/receipt.mjs weekly [--date YYYY-MM-DD] [--days N] [--out DIR]
 *   node scripts/receipt.mjs monthly [--month YYYY-MM]
 *   node scripts/receipt.mjs resume --forecast --file <会话 .jsonl>
 *   node scripts/receipt.mjs check --file <会话 .jsonl>
 *   node scripts/receipt.mjs run --cap 5 -- claude
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
