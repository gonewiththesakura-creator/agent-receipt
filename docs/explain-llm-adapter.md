# LLM 解释适配器：怎么接 Claude / Codex（只解释，不算钱）

> 本文件只讲“怎么接”，不调用任何模型 API。本仓库在运行时
> 不联网、不调模型、不上传任何内容。接模型是调用方（人或上层
> 工具）在自己的环境里做的事。

## 红线

1. **模型收到的唯一输入是收据 JSON。** 不要发日志原文、不要发
   用户提示词、不要发会话内容。收据里只有 token 数、模型名、
   工具名和金额，没有提示词原文。
2. **模型只做文字解释，不做计算。** 模型返回的每一行都要过
   `verifyExplanation()` 校验：行里出现的每一个美元金额、百分比、
   token 数，都必须能在收据 JSON 里找到对应字段，否则整行丢弃。
3. **校验失败不是“修一修数字”，是丢弃。** 不要让模型“改个数字
   再试”，也不要人工把数字改成“差不多”的值顶上。对不上的行
   直接不要，宁可少一行解释，也不要一行假数字。

## 接口

`src/explain/llm.ts`：

```ts
import { explainWithLlm, buildExplainPrompt } from "./explain/index.js";
import type { LlmAdapter } from "./explain/index.js";

// adapter 由调用方提供：把 prompt 发给模型，返回原始文本。
const claudeAdapter: LlmAdapter = async (prompt) => {
  // 例如：调本地 Claude Code / Codex CLI，或调你自己的模型客户端。
  // 这里只示意形状，本仓库不提供任何模型调用实现。
  return await callYourModel(prompt);
};

const { lines, dropped } = await explainWithLlm(receipt, claudeAdapter);
// lines：通过校验、可以展示的解释行（最多 3 行）。
// dropped：因含有收据里没有的数字而被丢弃的行，原文保留供检查。
```

`buildExplainPrompt(receipt)` 生成的 prompt 已经把红线写死：
只放收据 JSON，并明确要求“每一个数字都必须出自收据；
总成本为 null 时一个美元数字也不许写；最多 3 行”。

## 为什么这样设计（照着 open-code-review 的混合架构）

- open-code-review 的做法是：确定性工程（文件选择、规则匹配、
  评论定位）保证结果可复现，LLM 只做动态决策。agent-receipt
  照搬这条分工：`src/receipt/` 是确定性工程（金额、token 数、
  缓存重写、模型切换分段成本），`src/explain/` 是解释层。
- LLM 的幻觉主要出在数字上。把数字的来源锁死在收据 JSON 里，
  再用 `verifyExplanation()` 做一道机械校验，幻觉就进不了收据。
- 规则版解释（`explainReceipt()`）永远可用，不依赖任何模型；
  LLM 版只是“说得更好听”的可选增强，不是必需品。
