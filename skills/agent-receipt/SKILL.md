---
name: agent-receipt
description: "当用户问 AI 编程会话花了多少钱、为什么这么贵、怎么控成本时使用：为 Claude Code 或 Codex 会话生成成本收据、解释贵的原因、预测 resume 成本、报告模型切换、或给会话加硬性上限。触发场景包括“这次会话花了多少钱”“为什么这么贵”“缓存重写花了多少”“resume 一下要多少钱”“帮我把这次会话成本控在 5 美元内”“有没有偷偷换模型”。不要在用户只问通用计费规则、只想看厂商账单、或讨论与成本无关的编码问题时触发；也不要在没有本地会话日志时编造收据。"
license: MIT
compatibility: 需要 Node.js >= 20 与本地 Claude Code（~/.claude/projects）或 Codex（~/.codex/sessions）会话日志；只读解析，不联网、不上传。
---

# agent-receipt —— AI 编程会话的成本收据

给 Claude Code / Codex 会话算一笔明白账：这笔钱花在哪、为什么贵、下一步怎么省。
所有金额与 token 数都由本地 CLI 确定性算出，skill 本身绝不自己算钱。

## 红线（必须遵守）

- **数字只读 CLI 的输出。** 所有金额、token 数、百分比都必须来自
  `node dist/cli.js` 的输出或它写出的 `receipt.json`，不许自己估算、
  心算或编造。收据里没有的数字，解释里也不许出现。
- **金额是估算，不是账单。** 一律说“按公开标价估算”，不要说成发票金额。
- **没有日志就不编收据。** 找不到日志时直接告诉用户没有数据，不要
  编造会话、模型或金额。
- **订阅与 API 别混着算。** 订阅用户只讲 token 数与 5 小时窗口占比，
  不折算成美元；美元上限只用于 API 计费。

## 工作流

| 用户想做的事 | 怎么做（脚本路径以本 skill 目录为准） |
|---|---|
| 看今天 / 本月 / 某会话的收据 | `node scripts/receipt.mjs daily`、`monthly`、`session <id>` 或 `receipt --file <会话 .jsonl>`，见 `scripts/receipt.mjs` |
| 问“为什么这么贵” | 先出收据（同上），再 `node scripts/explain.mjs --receipt <receipt.json>`，只解释收据里的数字 |
| 问“resume 一下要多少钱” | `node scripts/receipt.mjs resume --forecast --file <会话 .jsonl>` |
| 问“有没有偷偷换模型” | `node scripts/receipt.mjs check --file <会话 .jsonl>` |
| 给一次运行加硬上限 | `node scripts/receipt.mjs run --cap 5 -- claude`（API 计费）；订阅用 `--quota-pct 80 --quota-tokens 200000`，见下文“上限” |

脚本只是对仓库 CLI 的薄封装：真正的解析与计算都在 `src/` 里，
脚本不复制任何计算逻辑。CLI 没构建时会提示先跑 `npm run build`。

## 解释“为什么贵”时只许讲这几类原因

按收据字段讲，不要自由发挥：

1. **缓存重写**：`cacheRewriteCostUsd` 占总成本 20% 以上时讲，引用
   `cacheRewriteCount` 与 `cacheRewriteTokens`，建议“先 compact 再暂停，
   或尽快 resume”。
2. **Resume 重写**：`resumeCount > 0` 且 `resumeCostUsd > 0` 时讲，说明
   这笔钱在新工作开始前就已经花了。
3. **子代理（subagent）**：`subagentCostUsd` 占 20% 以上时讲，建议检查
   子代理是否重复干活或陷入循环。
4. **模型切换**：`modelSwitches` 里某段 `segmentCostUsd` 占 15% 以上时讲，
   建议切换到贵模型前先确认。
5. 都不占主导时：讲缓存命中率（cache read 占 token 总数的比例）或
   “最大头是 fresh input 与 output，缩短提示词与上下文最省钱”。

解释文本里的每一个数字都必须能在 `receipt.json` 里找到对应字段，
详见 `references/receipt-format.md`。找不到对应字段的数字一律省略。

## 上限（`run --cap`）

- 只在用户明确要求“控成本 / 别超多少钱”时用；不要主动给用户的
  正常会话加 cap。
- cap 触发时会杀掉子进程并写出 `cap-evidence.json` / `cap-evidence.md`，
  把这两份证据原样告诉用户，不要只说“停了”。
- 如实说明限制：按日志轮询实现，可能晚一个请求才停；只看得到写进
  本地日志的消费。

## 定价与估算口径

- 金额按 `src/pricing/prices.ts` 的版本化标价表算（当前版本见收据
  上的 `priceTableVersion`），详见 `references/pricing.md`。
- 表里没有的模型只报 token 数，不猜价格；收据上会写
  `unknownPriceModels`，转述时不要略过这一点。

## 例子

- 用户：“这次会话花了多少钱？”
  → `node scripts/receipt.mjs receipt --out ./receipts`，读收据后回答：
  总计、缓存重写、子代理各占多少，并附一句最贵的原因。
- 用户：“为什么这么贵？”
  → 先出收据，再用 `scripts/explain.mjs` 解释；只讲收据里有的原因。
- 用户：“resume 一下要多少钱？”
  → `resume --forecast`，讲清缓存是否已过期、resume 重写多少钱、
  以及“先 compact 再 resume 更便宜”的建议。
- 用户：“帮我把这次任务控在 5 美元内。”
  → `run --cap 5 -- <用户要跑的命令>`，并说明 cap 可能晚一个请求。

## 边界情况

- 没有任何日志：直接说没找到日志、没有数据可报，不要编。
- 收据总成本为 null（有模型不在标价表里）：只讲 token 数，不讲美元。
- 用户问的是厂商账单（Anthropic / OpenAI 控制台）：告诉用户以厂商
  控制台为准，本工具只解释“为什么贵”，不替代账单。
