import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../../contracts/types/stats-accumulator.js";
import { readPayloadPath } from "./utils.js";

export interface FileTimeRangeResult {
  fileOldest: number | undefined;
  fileNewest: number | undefined;
}

export class FileTimeRangeAccumulator implements StatsAccumulator<FileTimeRangeResult> {
  private fileOldest: number | undefined;
  private fileNewest: number | undefined;

  accept(point: StatsPoint, _ctx: PointContext): void {
    const firstCreated = readPayloadPath(point.payload, "git.file.firstCreatedAt");
    const lastModified = readPayloadPath(point.payload, "git.file.lastModifiedAt");

    if (typeof firstCreated === "number" && firstCreated > 0) {
      this.fileOldest = this.fileOldest === undefined ? firstCreated : Math.min(this.fileOldest, firstCreated);
    }
    if (typeof lastModified === "number" && lastModified > 0) {
      this.fileNewest = this.fileNewest === undefined ? lastModified : Math.max(this.fileNewest, lastModified);
    }
  }

  result(): FileTimeRangeResult {
    return { fileOldest: this.fileOldest, fileNewest: this.fileNewest };
  }
}

export const fileTimeRangeDescriptor: StatsAccumulatorDescriptor<FileTimeRangeResult> = {
  key: STATS_ACCUMULATOR_KEYS.FILE_TIME_RANGE,
  factory: () => new FileTimeRangeAccumulator(),
};
