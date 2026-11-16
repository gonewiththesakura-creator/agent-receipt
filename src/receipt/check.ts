import { costOf } from "../pricing/prices.js";
import { totalTokens, type LogEntry, type ModelSwitch } from "../types.js";

/** Find every model switch inside a session and price the segment after it. */
export function findModelSwitches(entries: LogEntry[]): ModelSwitch[] {
  const switches: ModelSwitch[] = [];
  let prevModel: string | undefined;
  let segmentStart = 0;
  const segments: Array<{ from: number; to: number }> = [];
  entries.forEach((e, i) => {
    if (i > 0 && e.model && prevModel && e.model !== prevModel) {
      switches.push({
        index: i,
        timestamp: e.timestamp,
        fromModel: prevModel,
        toModel: e.model,
        segmentCostUsd: null,
        segmentTokens: 0,
      });
      segments.push({ from: segmentStart, to: i });
      segmentStart = i;
    }
    prevModel = e.model ?? prevModel;
  });
  segments.push({ from: segmentStart, to: entries.length });

  switches.forEach((sw, si) => {
    const seg = segments[si + 1];
    if (!seg) return;
    let segCost: number | null = 0;
    let segTokens = 0;
    for (let i = seg.from; i < seg.to; i++) {
      const e = entries[i];
      segTokens += totalTokens(e.usage);
      const c = costOf(e.model, e.usage);
      if (c === null) segCost = null;
      else if (segCost !== null) segCost += c;
    }
    sw.segmentCostUsd = segCost;
    sw.segmentTokens = segTokens;
  });
  return switches;
}
