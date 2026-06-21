import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/worker-protocol.js";

describe("worker-protocol additive codegraph fields (yl9tv)", () => {
  it("WorkerRequest carries emitExtraction and round-trips via structuredClone", () => {
    const req: WorkerRequest = {
      filePath: "a.rb",
      code: "x",
      language: "ruby",
      emitExtraction: true,
    };
    expect(structuredClone(req).emitExtraction).toBe(true);
  });
  it("WorkerResponse carries an optional FileExtraction", () => {
    const ex: FileExtraction = {
      relPath: "a.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
    };
    const res: WorkerResponse = {
      filePath: "a.rb",
      chunks: [],
      extraction: ex,
    };
    expect(structuredClone(res).extraction?.relPath).toBe("a.rb");
  });
});
