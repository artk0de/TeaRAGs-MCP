import { describe, expect, it } from "vitest";

import { formatPrime } from "../../src/cli/prime/format.js";
import type { PrimeData } from "../../src/cli/prime/types.js";

const baseStatus = {
  status: "indexed" as const,
  collectionName: "code_abc",
  filesCount: 1,
  chunksCount: 1,
  embeddingModel: "test-model",
};

describe("formatPrime — Project section", () => {
  it("includes a 'Project' section + hint when projectName is set", () => {
    const data: PrimeData = {
      path: "/repo",
      projectName: "myrepo",
      status: baseStatus,
      metrics: null,
      drift: null,
      update: null,
    };
    const out = formatPrime(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).toContain("## Project");
    expect(out).toContain("name: `myrepo`");
    expect(out).toContain('Use `project: "myrepo"`');
    expect(out).toContain("preferred parameter");
  });

  it("omits the 'Project' section when projectName is null", () => {
    const data: PrimeData = {
      path: "/repo",
      projectName: null,
      status: baseStatus,
      metrics: null,
      drift: null,
      update: null,
    };
    const out = formatPrime(data, new Date("2026-05-13T00:00:00Z"));
    expect(out).not.toContain("## Project");
    expect(out).not.toContain("[hint]");
  });
});
