/**
 * 解释层入口：规则版解释 + LLM 适配器接口。
 *
 * 两层分工（见 README“架构：确定性计算 + LLM 解释”）：
 * - 确定性层（src/receipt/）：算出收据里的每一个数字；
 * - 解释层（本目录）：只读收据，输出文字解释，绝不重新算钱。
 */
export { explainReceipt, verifyExplanation } from "./rules.js";
export type { ExplanationViolation } from "./rules.js";
export { buildExplainPrompt, explainWithLlm } from "./llm.js";
export type { LlmAdapter, LlmExplainResult } from "./llm.js";
