# Cost receipt — example (synthetic fixture)

> All numbers below come from `test/fixtures/claude-session.jsonl` — small
> made-up numbers for demonstration. They are **not** a real bill and
> **not** the unverified forum figures from the pain-point research.

- Agent: claude
- Session: s-1
- Models: claude-sonnet-4-5, claude-opus-4-1

## Tokens

| Kind | Tokens |
| --- | ---: |
| Fresh input | 14,500 |
| Cache read | 110,000 |
| Cache write | 100,000 |
| Output | 4,300 |

## Cost (estimate)

- **Total: $0.7140**
- Cache rewrites: 1 rewrite(s), 50,000 tokens, $0.1875
- Subagents: $0.0675
- Resume rewrites: 1 resume(s), $0.1875
- 5h-window tokens: 228,800

## Why it was expensive

1. $0.1875 (26% of this receipt) went to cache rewrites — 1 rewrite(s) of 50,000 tokens. Resuming a large session after the cache TTL expires re-writes the whole context. Compact the session before pausing, or resume sooner.
2. Model switch claude-sonnet-4-5 → claude-opus-4-1: the segment after the switch cost $0.2475 (35%). Confirm before switching to a more expensive model.

> Estimate at published list prices, not your invoice. Price table version: 2026-11-20 (the two models in this example are priced the same under the new table, so the figures are unchanged).
