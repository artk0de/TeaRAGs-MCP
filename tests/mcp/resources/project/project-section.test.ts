import { describe, expect, it } from "vitest";

import { formatSlimDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const baseStatus = {
  status: "indexed" as const,
  isIndexed: true,
  collectionName: "code_abc",
  filesCount: 1,
  chunksCount: 1,
  embeddingModel: "test-model",
};

describe("formatSlimDigest — Project section", () => {
  it("names the project without prescribing how to address it when projectName is set", () => {
    const data: ProjectDigestData = {
      path: "/repo",
      projectName: "myrepo",
      status: baseStatus,
      metrics: null,
      drift: null,
    };
    const out = formatSlimDigest(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).toContain("name: `myrepo`");
    expect(out).not.toContain("[hint]");
    expect(out).not.toContain("preferred parameter");
  });

  it("omits the 'Project' section when projectName is null", () => {
    const data: ProjectDigestData = {
      path: "/repo",
      projectName: null,
      status: baseStatus,
      metrics: null,
      drift: null,
    };
    const out = formatSlimDigest(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).not.toContain("## Project");
    expect(out).not.toContain("[hint]");
  });
});
