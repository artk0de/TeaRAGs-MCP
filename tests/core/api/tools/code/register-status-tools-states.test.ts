import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../../../src/core/api/public/index.js";
import { registerStatusTools } from "../../../../../src/core/api/tools/code/register-status-tools.js";

type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{ content: { type: "text"; text: string }[] }>;

function harness(status: Record<string, unknown>, extra: Partial<App> = {}) {
  const captured = new Map<string, ToolHandler>();
  const register = vi.fn((_server: unknown, name: string, _config: unknown, handler: ToolHandler) => {
    captured.set(name, handler);
  });
  const app = {
    getIndexStatus: vi.fn().mockResolvedValue(status),
    getIndexMetrics: vi.fn().mockResolvedValue({ collection: "code_abc", totalChunks: 3 }),
    checkIndexDrift: vi.fn().mockResolvedValue(null),
    ...extra,
  } as unknown as App;
  registerStatusTools({} as Parameters<typeof registerStatusTools>[0], { app, register: register as never });
  return { call: captured.get("get_index_status")!, metrics: captured.get("get_index_metrics")!, app };
}

const unhealthyInfra = {
  qdrant: { available: false, url: "http://127.0.0.1:6333", status: "red" },
  embedding: { available: true, provider: "onnx" },
};

describe("get_index_status — non-indexed lifecycle states", () => {
  it("tells the caller to index first, and appends infra health when it is known", async () => {
    const plain = await harness({ status: "not_indexed" }).call({ path: "/repo" }, {});
    expect(plain.content[0].text).toBe('Codebase at "/repo" is not indexed. Use index_codebase to index it first.');

    const withInfra = await harness({ status: "not_indexed", infraHealth: unhealthyInfra }).call({ path: "/repo" }, {});
    expect(withInfra.content[0].text).toContain("is not indexed");
    expect(withInfra.content[0].text).toContain("Qdrant");
  });

  it("reports a stale indexing marker as a crashed run that needs re-indexing", async () => {
    const plain = await harness({ status: "stale_indexing" }).call({ path: "/repo" }, {});
    expect(plain.content[0].text).toContain("stale indexing marker");
    expect(plain.content[0].text).toContain("Use index_codebase to re-index");

    const withInfra = await harness({ status: "stale_indexing", infraHealth: unhealthyInfra }).call(
      { path: "/repo" },
      {},
    );
    expect(withInfra.content[0].text).toContain("Qdrant");
  });

  it("reports progress of a running index, per-provider enrichment, and infra health", async () => {
    const bare = await harness({ status: "indexing" }).call({ path: "/repo" }, {});
    expect(bare.content[0].text).toContain("0 chunks processed so far");

    const full = await harness({
      status: "indexing",
      chunksCount: 42,
      enrichment: { git: { file: { status: "in_progress" }, chunk: { status: "pending" } } },
      infraHealth: unhealthyInfra,
    }).call({ path: "/repo" }, {});
    const { text } = full.content[0];
    expect(text).toContain("42 chunks processed so far");
    expect(text).toContain("git enrichment: file=in_progress, chunk=pending");
    expect(text).toContain("Qdrant");
  });
});

describe("get_index_status — indexed report", () => {
  it("warns about every provider whose enrichment is still running and omits the rest", async () => {
    const { call } = harness({
      status: "indexed",
      collectionName: "code_abc",
      chunksCount: 10,
      enrichment: {
        git: { file: { status: "completed" }, chunk: { status: "in_progress" } },
        codegraph: { file: { status: "in_progress" }, chunk: { status: "completed" } },
        done: { file: { status: "completed" }, chunk: { status: "completed" } },
      },
    });
    const { text } = (await call({ path: "/repo" }, {})).content[0];
    expect(text).toContain("[git enrichment is still running.");
    expect(text).toContain("[codegraph enrichment is still running.");
    expect(text).not.toContain("[done enrichment");
    expect(text).toContain('"enrichment"');
  });

  it("renders collection details and infra health beneath the status JSON", async () => {
    const { call } = harness({
      status: "indexed",
      collectionName: "code_abc",
      infraHealth: {
        qdrant: { available: true, url: "http://127.0.0.1:6333", status: "green", indexSizeBytes: 2048 },
        embedding: { available: true, provider: "onnx" },
      },
    });
    const { text } = (await call({ path: "/repo" }, {})).content[0];
    expect(text).toContain("2");
    expect(text).toContain("Qdrant");
    expect(text).not.toContain("infraHealth");
  });

  it("reads a drift report at the base index path when the status names one", async () => {
    const checkIndexDrift = vi.fn().mockResolvedValue("Payload keys moved");
    const { call } = harness(
      { status: "indexed", collectionName: "code_abc", indexPath: "/base" },
      {
        checkIndexDrift,
      },
    );
    const { text } = (await call({ path: "/tree" }, {})).content[0];
    expect(checkIndexDrift).toHaveBeenCalledWith({ path: "/base", consume: false });
    expect(text).toContain("Working tree /tree is read against the index of /base.");
    expect(text).toContain("## Drift\nPayload keys moved");
  });
});

describe("get_index_metrics", () => {
  it("returns the app's metrics for the resolved path as a tool response", async () => {
    const { metrics, app } = harness({ status: "indexed" });
    const result = await metrics({ path: "/repo" }, {});
    expect(app.getIndexMetrics).toHaveBeenCalledWith("/repo");
    expect(result.content[0].text).toContain("code_abc");
  });
});
