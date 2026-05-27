import { describe, expect, it } from "vitest";

import type { EnrichmentProvider, FinalizeResult } from "../../../../src/core/contracts/types/provider.js";

describe("EnrichmentProvider stream/finalize contract", () => {
  it("accepts a provider implementing streamFileBatch + finalizeSignals", async () => {
    const finalize: FinalizeResult = { file: new Map(), chunk: new Map() };
    const p: Pick<EnrichmentProvider, "streamFileBatch" | "finalizeSignals"> = {
      streamFileBatch: async () => new Map(),
      finalizeSignals: async () => finalize,
    };
    expect((await p.streamFileBatch!("/r", ["a.ts"])).size).toBe(0);
    const f = await p.finalizeSignals!("/r");
    expect(f.file).toBeInstanceOf(Map);
    expect(f.chunk).toBeInstanceOf(Map);
  });
});
