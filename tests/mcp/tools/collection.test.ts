import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../src/core/api/index.js";
import { registerCollectionTools } from "../../../src/mcp/tools/collection.js";

type CapturedTool = {
  name: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>;
};

function makeHarness(appOverrides: Partial<App>) {
  const captured: CapturedTool[] = [];
  const register = vi.fn((_server, name, _config, handler) => {
    captured.push({ name, handler });
  });
  const app = appOverrides as unknown as App;
  registerCollectionTools({} as Parameters<typeof registerCollectionTools>[0], { app, register });
  const tool = (name: string) => captured.find((t) => t.name === name)!;
  return { app, tool };
}

const createdInfo = {
  name: "memory",
  vectorSize: 384,
  pointsCount: 0,
  distance: "Cosine" as const,
  hybridEnabled: false,
  status: "green" as const,
  optimizerStatus: "ok",
};

describe("registerCollectionTools — create_collection", () => {
  it("passes the document metadata schema through to App.createCollection", async () => {
    const schema = { type: "object", properties: { domain: { type: "string" } } };
    const createCollection = vi.fn().mockResolvedValue({ ...createdInfo, schema });
    const { tool } = makeHarness({ createCollection });

    const result = await tool("create_collection").handler({ name: "memory", schema }, {});

    expect(createCollection).toHaveBeenCalledWith({
      name: "memory",
      distance: undefined,
      enableHybrid: undefined,
      schema,
    });
    expect(result.content[0].text).toContain("typed");
  });

  it("does not mention typing for a collection created without a schema", async () => {
    const createCollection = vi.fn().mockResolvedValue(createdInfo);
    const { tool } = makeHarness({ createCollection });

    const result = await tool("create_collection").handler({ name: "memory" }, {});

    expect(result.content[0].text).not.toContain("typed");
  });
});
