# 收据格式说明（references/receipt-format.md）

> 按需加载：只有当 skill 需要读 `receipt.json` 里的具体字段、
> 或向用户解释某个数字的来源时，才读本文件。
> 本文件提炼自 `docs/receipt-example.md` 与 `src/receipt/receipt.ts`
> 的 `Receipt` 接口。所有数字都是确定性层算出的，解释时只许引用，
> 不许重新计算。

## receipt.json 顶层字段

| 字段 | 含义 | 解释时怎么用 |
|---|---|---|
| `agent` | `claude` 或 `codex` | 说明收据是哪个 agent 的 |
| `sessionId` / `project` | 会话与项目 | 定位是哪一次会话 |
| `models` | 会话里出现过的模型 | 说明涉及哪些模型 |
| `entryCount` / `skippedLines` | 消息条数 / 跳过的坏行数 | 跳过的行数要如实提，不要略过 |
| `usage` | `{input, output, cacheWrite, cacheRead}` 四类 token 数 | token 层面的事实 |
| `costUsd` | 预估总成本（美元），可能为 `null` | 为 `null` 时只讲 token，不讲美元 |
| `costByModel` | 每个模型的 `{usage, costUsd, tokens}` | 讲“哪个模型最贵”时用 |
| `cacheRewriteTokens` / `cacheRewriteCount` / `cacheRewriteCostUsd` | 缓存重写 token 数、次数、成本 | 讲“缓存重写贵”时用 |
| `resumeCount` / `resumeCostUsd` | resume 次数与成本 | 讲“resume 贵”时用 |
| `subagentUsage` / `subagentCostUsd` | 子代理的用量与成本 | 讲“子代理贵”时用 |
| `modelSwitches` | 每次切换的 `{fromModel, toModel, segmentCostUsd, segmentTokens}` | 讲“模型切换贵”时用 |
| `fiveHourWindowTokens` | 5 小时窗口内的 token 数 | 订阅用户讲额度占用时用 |
| `whyExpensive` | 确定性解释层生成的解释行（最多 3 行） | 直接引用，不要改写其中的数字 |
| `unknownPriceModels` | 标价表里没有的模型 | 有内容时必须告诉用户“这些模型只报了 token 数” |
| `priceTableVersion` | 标价表版本 | 报数字时一并提 |
| `estimateNote` | “按公开标价估算，不是发票” | 报金额时必须带上这句口径 |

## 例子（合成数据，见 docs/receipt-example.md）

- 总计 `$0.7140`，其中缓存重写 `$0.1875`（26%）、子代理 `$0.0675`、
  resume 重写 `$0.1875`、模型切换后一段 `$0.2475`（35%）。
- 这些数字全部来自 `test/fixtures/claude-session.jsonl` 这个合成小样例，
  不是真实账单，不要当作真实案例引用。

## 校验规则

解释文本里出现的每一个 `$金额`，必须等于上表某一行的美元字段
（允许四舍五入到 4 位小数）；每一个 `N%`，必须是某部分占
`costUsd` 的份额（或 cache read 占 token 总数的份额）。
对不上的数字一律省略，不要猜一个“差不多”的数顶上。
