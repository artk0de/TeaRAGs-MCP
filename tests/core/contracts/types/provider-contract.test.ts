import { describe, expect, it } from "vitest";

import type { EnrichmentProvider } from "../../../../src/core/contracts/types/provider.js";

describe("EnrichmentProvider stream/finalize contract", () => {
  it("accepts a provider implementing streamFileBatch + file-only finalizeSignals", async () => {
    const p: Pick<EnrichmentProvider, "streamFileBatch" | "finalizeSignals" | "defersChunkEnrichment"> = {
      streamFileBatch: async () => new Map(),
      // finalize returns FILE overlays only — chunk deferral is handled by the
      // coordinator's post-finalize buildChunkSignals pass, not here.
      finalizeSignals: async () => new Map(),
      defersChunkEnrichment: true,
    };
    expect((await p.streamFileBatch!("/r", ["a.ts"])).size).toBe(0);
    const file = await p.finalizeSignals!("/r");
    expect(file).toBeInstanceOf(Map);
    expect(file.size).toBe(0);
    expect(p.defersChunkEnrichment).toBe(true);
  });
});
