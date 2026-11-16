# agent-receipt

A cost receipt for AI coding agents. Local-first, no cloud, no uploads.

## Sponsors

> 欢迎赞助本项目。赞助是自愿的，不解锁任何功能——核心功能永远
> 开源免费（MIT），现在没有任何付费墙。赞助只用于支持维护。
>
> 联系与赞助请走 GitHub：[gonewiththesakura-creator/agent-receipt](https://github.com/gonewiththesakura-creator/agent-receipt)
> 的 Issues / Discussions。
>
> （目前暂无赞助商。变现方向见 [docs/monetization.md](docs/monetization.md)。）

## The problem

Your AI coding bill is rarely dominated by code written. It is dominated
by context cache rewrites, silent model switches, and subscription quota
burned by session resumes — and budget alerts are not hard caps.

`agent-receipt` parses the session logs already on your machine
(Claude Code and Codex CLI), and gives you three things:

1. **A receipt** — per-session cost, split into fresh input / cache
   read / cache write / output, with cache rewrites and subagent work
   listed separately.
2. **An explanation** — plain-language lines saying *why* it was
   expensive (cache rewrite after a long gap, a model switch, a
   subagent loop).
3. **A cap** — a hard stop when a session's incremental cost reaches
   the limit you set, with an evidence receipt explaining why it stopped.

## Quick start

```bash
npm install -g agent-receipt   # once published; for now, see "Development"
# or, from this directory:
npm install
npm run build

# Receipt for today (reads ~/.claude/projects and ~/.codex/sessions)
node dist/cli.js daily
# Receipt for a whole month (defaults to the current month)
node dist/cli.js monthly [--month YYYY-MM]
# Receipt for one session by id
node dist/cli.js session <id>
# Receipt for the latest session, and write receipt.md / receipt.json
node dist/cli.js receipt --out ./receipts
# Receipt for one session file
node dist/cli.js receipt --file ~/.claude/projects/my-proj/<session>.jsonl
# What will resuming this session cost?
node dist/cli.js resume --forecast --file <session>.jsonl
# Where did model switches burn money?
node dist/cli.js check --file <session>.jsonl
# Run an agent under a $5 cap (API billing)
node dist/cli.js run --cap 5 -- claude
# ...or under a 5-hour-window quota share (subscription billing)
node dist/cli.js run --cap 0 --quota-pct 80 --quota-tokens 200000 -- codex exec "fix the tests"
```

## Example receipt

```
agent-receipt — session cost receipt
====================================================
Agent:                claude
Session:              s-1
Models:               claude-sonnet-4-5, claude-opus-4-1
Messages:             5

Tokens
----------------------------------------------------
  Fresh input:        14,500
  Cache read:         110,000
  Cache write:        100,000
  Output:             4,300
  Total:              228,800

Cost (estimate)
----------------------------------------------------
  Total:              $0.7140
  Cache rewrites:     1 rewrite(s), 50,000 tokens, $0.1875
  Subagents:          $0.0675
  Resume rewrites:    1 resume(s), $0.1875
  5h-window tokens:   228,800

Why it was expensive
----------------------------------------------------
  1. $0.1875 (26% of this receipt) went to cache rewrites — 1 rewrite(s)
     of 50,000 tokens. Resuming a large session after the cache TTL expires
     re-writes the whole context. Compact the session before pausing, or
     resume sooner.
  2. Model switch claude-sonnet-4-5 → claude-opus-4-1: the segment after
     the switch cost $0.2475 (35%). Confirm before switching to a more
     expensive model.
```

The numbers above are from the synthetic fixture in
`test/fixtures/claude-session.jsonl` — small made-up numbers, not a real
bill. See `docs/receipt-example.md` for the same receipt in Markdown.

## As a Claude Code skill

`agent-receipt` ships as a Claude Code skill (see `skills/agent-receipt/`,
built after the [Agent Skills spec](https://agentskills.io/specification)
and Anthropic's [anthropics/skills](https://github.com/anthropics/skills)
repo): ask Claude Code about session cost and it loads the skill.

Install as a plugin marketplace (in Claude Code):

```
/plugin marketplace add gonewiththesakura-creator/agent-receipt
/plugin install agent-receipt@agent-receipt-marketplace
```

Or copy the skill by hand:

```bash
cp -r skills/agent-receipt ~/.claude/skills/agent-receipt
```

Then just ask, for example: “这次会话花了多少钱？” / “为什么这么贵？”
/ “resume 一下要多少钱？” / “帮我把这次任务控在 5 美元内。”
The skill routes each question to the CLI (`receipt`, `explain`,
`resume --forecast`, `check`, `run --cap`) — every number it reports
comes from the CLI's deterministic output, never from the model's own
arithmetic. Details: `skills/agent-receipt/SKILL.md`.

## How it works

- **Sources.** Claude Code: `~/.claude/projects/<project>/<session>.jsonl`
  (messages with `usage: {input_tokens, output_tokens,
  cache_creation_input_tokens, cache_read_input_tokens}`). Codex CLI:
  `~/.codex/sessions/**/*.jsonl`, parsed best-effort — Codex log
  formats vary, so unknown fields are skipped and unknown lines are
  counted, never fatal.
- **Pricing.** `src/pricing/prices.ts` is a versioned table
  (current version `2026-11-09`) of published list prices. Dollar
  figures are **estimates at published list prices, not your invoice**.
  A model with no price in the table reports token counts only and says
  so on the receipt — it never guesses a price.
- **Subscription vs API.** Subscription users have no dollar bill, so
  their cost is shown in tokens and 5-hour-window share. Dollar caps
  apply to API billing; subscription enforcement uses `--quota-pct`
  against a `--quota-tokens` budget you supply. The two are never mixed.
- **Cache rewrites.** A cache-write on any message after the first, or
  after a gap longer than the cache TTL (default 60 minutes), is counted
  as a rewrite and priced separately. A resume after a >TTL gap is
  counted as a resume rewrite.
- **The cap.** `run --cap` snapshots the cost in your local logs, spawns
  the child in its own process group, and polls the logs. When the
  incremental cost since the snapshot reaches the cap, it kills the
  process group and writes `cap-evidence.json` / `cap-evidence.md`
  explaining why it stopped.

## Architecture: deterministic calculation + LLM explanation

There are two layers, and they never mix (the split follows
alibaba/open-code-review's "deterministic engineering × agent" pattern:
deterministic code guarantees the result, the model only decides
the wording):

- **Deterministic layer (`src/receipt/`, `src/parsers/`, `src/pricing/`).**
  Every amount, token count, cache rewrite, resume cost and model-switch
  segment cost is computed here, from local logs and a versioned price
  table. It is reproducible: the same log file run twice produces a
  byte-identical receipt (covered by a test). It never calls a model.
- **Explanation layer (`src/explain/`).** It only reads a finished
  receipt and writes plain-language lines about *why* it was expensive.
  It never recomputes a number: every dollar amount, percentage and
  token count in its output must already exist as a field in the
  receipt, enforced by `verifyExplanation()`. The rule-based
  explainer (`explainReceipt()`) needs no model at all.
- **LLM adapter (`src/explain/llm.ts`, optional).** If you want a model
  to write the explanation, it receives only the receipt JSON — never
  log text or prompts — and every line it returns is verified the same
  way; lines with numbers that are not in the receipt are dropped, not
  fixed up. See `docs/explain-llm-adapter.md`.

**The red line: the LLM explains, it never calculates.** Numbers come
from the deterministic layer; the model only turns them into sentences.

## Privacy

All parsing happens on your machine. No logs, prompts, or API keys leave
the machine. Receipts store token counts, model names, tool names and
cost numbers — never prompt text. There are no network calls at runtime.

## Honest limits

Read this before relying on the tool:

- **Estimates, not bills.** Dollar figures use a versioned list-price
  table. Your invoice may differ (discounts, different TTLs, plan
  changes). The table version is printed on every receipt.
- **The cap can be one request late.** `run --cap` polls log files, so
  a request that starts just before the cap is hit may still complete.
  It is a local enforcement aid, not a mathematical guarantee of zero
  overshoot. It also only sees spend the agent writes to local logs;
  delayed or missing logs are invisible to it.
- **Model switches are reported, not blocked.** v0.1's `check` command
  finds switches in a session log and prices the segment after them.
  The hook in `hooks/` only *logs* the model seen at session start —
  Claude Code hooks run around tool calls, not around the model's choice
  of model, so a switch cannot be vetoed mid-flight by a hook. Do not
  configure the hook expecting confirmation prompts.
- **Log formats change.** Vendors change local log shapes and prices
  without notice. Unknown lines are skipped and counted; unknown models
  report tokens only. If a vendor changes its format, receipts may go
  quiet rather than wrong — check the "skipped lines" count.
- **The motivating numbers are unverified.** The pain-point research
  behind this project cites forum reports (for example, a cache rewrite
  costing a large share of a session, or a resume burning much of a
  5-hour window). Those figures are **unverified secondary claims** and
  appear nowhere in this code, README, or tests as facts. Tests use
  small synthetic fixtures only.
- **Not a substitute for the vendor console.** For API billing, the
  Anthropic / OpenAI console is the authoritative bill. This tool tells
  you *why* a session was expensive; the console tells you what you owe.

## Development

```bash
npm install
npm run build     # tsc -> dist/
npm test          # build + node --test test/ (synthetic fixtures only)
node dist/cli.js --help
```

Node >= 20. No runtime dependencies; TypeScript is a dev dependency only.

## Roadmap

- **v0.1**: Claude Code + Codex receipts, API hard cap,
  model-switch report + logging hook, resume forecast.
- **v0.2** (in development): Claude Code skill + plugin marketplace, deterministic /
  explanation layer split, Cursor / Gemini CLI parsers, idle
  auto-compact suggestions, weekly report (the three most expensive
  things this week).
- **v1.0**: team roll-up from exported receipts, price-table freshness
  checks, export compatible with ccusage-style reports.

## Support & consulting

- **Sponsors.** See the Sponsors section at the top — voluntary, no
  paywall, no unlocked features. The open-core plan is in
  [docs/monetization.md](docs/monetization.md).
- **Consulting.** Deployment support (wiring receipts into your team's
  agent workflow) and feature work (custom receipt formats and reports)
  are welcome. Reach out via GitHub Issues / Discussions on
  [gonewiththesakura-creator/agent-receipt](https://github.com/gonewiththesakura-creator/agent-receipt)
  — no email is published for this project.

## License

MIT — see `LICENSE`. Copyright 2026 gonewiththesakura-creator.
