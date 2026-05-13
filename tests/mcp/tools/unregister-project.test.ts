import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../src/core/api/index.js";
import { registerUnregisterProjectTool } from "../../../src/mcp/tools/unregister-project.js";

type CapturedTool = {
  name: string;
  config: {
    title?: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

function makeHarness(unregisterImpl?: App["unregisterProject"]) {
  const captured: CapturedTool[] = [];
  const register = vi.fn((_server, name, config, handler) => {
    captured.push({ name, config, handler });
  });

  const app = {
    unregisterProject: unregisterImpl ?? vi.fn().mockResolvedValue({ removed: true }),
  } as unknown as App;

  const server = {} as Parameters<typeof registerUnregisterProjectTool>[0];
  registerUnregisterProjectTool(server, { app, register });

  return { captured, app, register };
}

describe("registerUnregisterProjectTool — unregister_project", () => {
  it("registers the unregister_project tool", () => {
    const { captured } = makeHarness();
    expect(captured.map((t) => t.name)).toContain("unregister_project");
  });

  it("tool has title, description, inputSchema, and destructive annotation", () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "unregister_project");
    expect(tool).toBeDefined();
    expect(tool!.config.title).toBeTruthy();
    expect(typeof tool!.config.description).toBe("string");
    expect((tool!.config.description as string).length).toBeGreaterThan(20);
    expect(tool!.config.inputSchema).toBeTruthy();
    expect(tool!.config.annotations).toMatchObject({ destructiveHint: true });
  });

  it("handler delegates to app.unregisterProject with name and returns JSON result", async () => {
    const { captured, app } = makeHarness();
    const tool = captured.find((t) => t.name === "unregister_project")!;
    const result = (await tool.handler({ name: "alpha" }, {})) as {
      content: { type: string; text: string }[];
    };
    expect(app.unregisterProject).toHaveBeenCalledTimes(1);
    expect(app.unregisterProject).toHaveBeenCalledWith({ name: "alpha" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as { removed: boolean };
    expect(parsed.removed).toBe(true);
  });

  it("returns removed:false when project was not registered (idempotent)", async () => {
    const unregister = vi.fn().mockResolvedValue({ removed: false });
    const { captured } = makeHarness(unregister as unknown as App["unregisterProject"]);
    const tool = captured.find((t) => t.name === "unregister_project")!;
    const result = (await tool.handler({ name: "missing" }, {})) as {
      content: { type: string; text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text) as { removed: boolean };
    expect(parsed.removed).toBe(false);
  });
});
