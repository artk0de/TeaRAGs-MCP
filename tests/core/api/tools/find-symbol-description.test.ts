/**
 * find_symbol tool description (read economy, bd tea-rags-mcp-9f0yn.1): outline
 * member lines carry their line range, a pasted suffix is tolerated, and a
 * "lines N–M" / `grep -n` hit maps to the ids whose ranges cover it — never a
 * Read offset/limit. Measured over the REAL tools/list.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildToolSurface } from "../../../../scripts/measure-tools-list.js";

describe("find_symbol description (real tools/list)", () => {
  let description: string;
  beforeAll(async () => {
    const { tools } = await buildToolSurface(true);
    description = tools.find((t: Tool) => t.name === "find_symbol")?.description ?? "";
  });

  it("shows a member line ending in visibility then its line range", () => {
    expect(description).toContain("'Class#helper (private) L40-58'");
  });

  it("says a pasted suffix is tolerated", () => {
    expect(description).toContain("a pasted suffix is tolerated");
    expect(description).not.toContain("before drilling");
  });

  it("maps lines N–M and grep -n hits to the covering outline ids, never Read offset/limit", () => {
    expect(description).toContain("Lines N–M / a grep -n hit → the ids whose ranges cover them");
    expect(description).toContain("never Read offset/limit");
  });

  it("keeps full text for a small file in symbols mode (the batch-outline lever is rejected)", () => {
    expect(description).toMatch(/symbols: 1-20 ids \/ paths in one call \(full text until \d+ chars, then outline\)/);
  });
});
