/**
 * LLM 解释适配器接口。
 *
 * 用途：把“解释”这件事交给大模型做时，模型只做文字解释，
 * 不做计算。红线与规则版解释层完全相同：
 * 模型收到的唯一输入是收据 JSON（不含日志原文、不含提示词），
 * 模型返回的每一行都要过 verifyExplanation() 校验，
 * 出现收据里没有的数字的行会被丢弃，而不是放行。
 *
 * 本模块不调用任何 LLM API：调用方自己提供 adapter
 * （例如把 prompt 发给 Claude / Codex，再把返回的文本传回来）。
 * 这样本仓库保持零运行时依赖、零网络调用。
 */
import { verifyExplanation } from "./rules.js";
import type { Receipt } from "../receipt/receipt.js";

/** 调用方提供的模型调用函数：输入 prompt，返回模型的原始文本。 */
export type LlmAdapter = (prompt: string) => Promise<string>;

/**
 * 给模型用的 prompt：只放收据 JSON，并用自然语言把红线写死。
 * 注意：prompt 里不放日志原文、不放用户提示词，只放收据数字。
 */
export function buildExplainPrompt(receipt: Receipt): string {
  return [
    "You are explaining an AI coding session cost receipt. The receipt JSON below is the ONLY source of numbers.",
    "",
    "STRICT RULES — follow them exactly:",
    "1. Every dollar amount you write must appear in the receipt JSON (same value, 4 decimal places).",
    "2. Every percentage you write must be a share of the receipt total cost (or the cache-read share of total tokens).",
    "3. Every token count you write must appear in the receipt JSON.",
    "4. Never compute a new amount, never estimate a missing price, never invent a session, model, or cost.",
    "5. If the receipt total cost is null, do not write any dollar amounts at all — talk about token counts only.",
    "6. Reply with at most 3 short lines, one per line, plain language, no markdown headings.",
    "",
    "Receipt JSON:",
    JSON.stringify(receipt),
  ].join("\n");
}

export interface LlmExplainResult {
  /** 通过校验、可以展示的解释行。 */
  lines: string[];
  /** 因含有收据里没有的数字而被丢弃的行（原文保留，供调用方检查）。 */
  dropped: string[];
}

/**
 * 用 LLM 解释一份收据。流程：
 *   1. 用 buildExplainPrompt() 把收据 JSON 交给模型；
 *   2. 把模型返回按行拆开；
 *   3. 每行过 verifyExplanation()，通不过的行丢进 dropped，不展示。
 * adapter 抛错时直接抛出，由调用方处理。
 */
export async function explainWithLlm(
  receipt: Receipt,
  adapter: LlmAdapter,
): Promise<LlmExplainResult> {
  const prompt = buildExplainPrompt(receipt);
  const raw = await adapter(prompt);
  const candidateLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3);
  const violations = verifyExplanation(candidateLines, receipt);
  const bad = new Set(violations.map((v) => v.line));
  return {
    lines: candidateLines.filter((l) => !bad.has(l)),
    dropped: candidateLines.filter((l) => bad.has(l)),
  };
}
