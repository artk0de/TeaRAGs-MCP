import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../src/core/api/index.js";
import { registerRegisterProjectTool } from "../../../src/mcp/tools/register-project.js";

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

function makeHarness() {
  const captured: CapturedTool[] = [];
  const register = vi.fn((_server, name, config, handler) => {
    captured.push({ name, config, handler });
  });

  const app = {
    registerProject: vi.fn().mockResolvedValue({
      collectionName: "code_abc",
      alreadyIndexed: false,
    }),
  } as unknown as App;

  const server = {} as Parameters<typeof registerRegisterProjectTool>[0];

  registerRegisterProjectTool(server, { app, register });

  return { captured, app };
}

describe("registerRegisterProjectTool", () => {
  it("registers the register_project tool", () => {
    const { captured } = makeHarness();
    expect(captured.map((t) => t.name)).toContain("register_project");
  });

  it("register_project has a non-empty title, description and inputSchema", () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "register_project");
    expect(tool).toBeDefined();
    expect(tool!.config.title).toBeTruthy();
    expect(typeof tool!.config.description).toBe("string");
    expect((tool!.config.description as string).length).toBeGreaterThan(20);
    expect(tool!.config.inputSchema).toBeTruthy();
  });

  it("invokes app.registerProject with {path, name} and returns its result", async () => {
    const { captured, app } = makeHarness();
    const tool = captured.find((t) => t.name === "register_project");
    expect(tool).toBeDefined();

    const result = (await tool!.handler({ path: "/abs/proj", name: "alpha" }, {})) as { structuredContent?: unknown };

    const appMock = app.registerProject as unknown as ReturnType<typeof vi.fn>;
    expect(appMock).toHaveBeenCalledTimes(1);
    expect(appMock).toHaveBeenCalledWith({ path: "/abs/proj", name: "alpha" });

    // Tool must surface collectionName + alreadyIndexed from the App result.
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("code_abc");
    expect(serialized).toContain("alreadyIndexed");
  });

  it("name field rejects invalid project aliases", () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "register_project");
    expect(tool).toBeDefined();

    const schema = tool!.config.inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(schema.name.safeParse("Bad Name").success).toBe(false);
    expect(schema.name.safeParse("UPPER").success).toBe(false);
    expect(schema.name.safeParse("ok-1_alias").success).toBe(true);
  });

  it("path field rejects empty strings", () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "register_project");
    const schema = tool!.config.inputSchema as Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
    expect(schema.path.safeParse("").success).toBe(false);
    expect(schema.path.safeParse("/abs/path").success).toBe(true);
  });
});
