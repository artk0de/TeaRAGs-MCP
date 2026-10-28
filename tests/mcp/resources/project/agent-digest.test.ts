import { describe, expect, it } from "vitest";

import { formatAgentDigest, formatFullDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const NOW = new Date("2026-10-28T12:00:00Z");

function data(over: Partial<ProjectDigestData> = {}, statusOver: Record<string, unknown> = {}): ProjectDigestData {
  return {
    path: "/repo",
    projectName: "proj",
    registry: {
      collectionName: "code_abc",
      path: "/repo",
      name: "proj",
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-10-28T11:00:00.000Z",
      teaRagsVersion: "1.0.0",
      chunksCount: 10,
    },
    status: {
      status: "indexed",
      isIndexed: true,
      collectionName: "code_abc",
      filesCount: 3,
      chunksCount: 10,
      embeddingModel: "m",
      lastUpdated: new Date("2026-10-28T11:30:00Z"),
      infraHealth: {
        qdrant: { status: "red", optimizerStatus: "ok", url: "http://localhost:6333" },
        embedding: { provider: "ollama", available: false, url: "http://e:11434" },
      },
      indexHoles: { count: 4 },
      rustcDriver: { outcome: "skipped", reason: "noBulkNoCache" },
      ...statusOver,
    } as ProjectDigestData["status"],
    metrics: null,
    drift: "Language versions:\n  rust.walker: 3 → 11\nRun: tea-rags index-codebase --project proj --force",
    ...over,
  };
}

describe("formatAgentDigest — the agent-facing digest (bd tea-rags-mcp-nknkg.1)", () => {
  it("carries alias + collection addressing and drops drift / infra / capability / rustc blocks", () => {
    const out = formatAgentDigest(data(), NOW);
    expect(out).toContain("`proj`");
    expect(out).toContain("`code_abc`");
    expect(out).toContain('project: "proj"');
    for (const block of ["## Drift", "## Infra", "## Language capability", "rustc driver", "qdrant:", "embedding:"]) {
      expect(out).not.toContain(block);
    }
    expect(out).not.toContain("--force");
    expect(out).not.toContain("metrics?language");
  });

  it("never carries a codegraph line, whatever the registry state (absent graph tools are the off signal)", () => {
    expect(formatAgentDigest(data(), NOW)).not.toMatch(/codegraph/);
    const off = data();
    off.registry = { ...off.registry!, codegraphEnabled: false };
    expect(formatAgentDigest(off, NOW)).not.toMatch(/codegraph/);
    const on = data();
    on.registry = { ...on.registry!, codegraphEnabled: true };
    expect(formatAgentDigest(on, NOW)).not.toMatch(/codegraph/);
  });

  it("prints a freshness line only when it carries an action", () => {
    const fresh = formatAgentDigest(data({ drift: null }, { indexHoles: undefined }), NOW);
    expect(fresh).not.toMatch(/index_codebase|get_index_status|stale|behind/);

    const stale = formatAgentDigest(
      data({ drift: null }, { indexHoles: undefined, lastUpdated: new Date("2026-10-25T12:00:00Z") }),
      NOW,
    );
    expect(stale).toContain('index behind (last indexed 3d ago) → index_codebase(project="proj")');

    const drifted = formatAgentDigest(data(), NOW);
    expect(drifted).toContain('index drift → get_index_status(project="proj") names the remedy');
  });

  it("keeps the not-indexed status line — it is the action", () => {
    const out = formatAgentDigest(data({}, { status: "not_indexed", isIndexed: false }), NOW);
    expect(out).toContain("not indexed");
  });

  it("is a fraction of the full human digest", () => {
    const agent = formatAgentDigest(data(), NOW);
    const full = formatFullDigest(data(), NOW);
    expect(full).toContain("## Drift");
    expect(full).toContain("## Infra");
    expect(agent.length).toBeLessThan(full.length / 2);
  });
});
