import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";

export interface DocsCodeCountsResult {
  docsCount: number;
  codeCount: number;
}

export class DocsCodeCountsAccumulator implements StatsAccumulator<DocsCodeCountsResult> {
  private docsCount = 0;
  private codeCount = 0;

  accept(point: StatsPoint, _ctx: PointContext): void {
    if (point.payload["isDocumentation"] === true) {
      this.docsCount++;
    } else {
      this.codeCount++;
    }
  }

  result(): DocsCodeCountsResult {
    return { docsCount: this.docsCount, codeCount: this.codeCount };
  }
}

export const docsCodeCountsDescriptor: StatsAccumulatorDescriptor<DocsCodeCountsResult> = {
  key: STATS_ACCUMULATOR_KEYS.DOCS_CODE_COUNTS,
  factory: () => new DocsCodeCountsAccumulator(),
};
