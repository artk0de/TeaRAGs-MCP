import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../src/core/api/index.js";
import { registerProjectTools } from "../../../src/mcp/tools/list-projects.js";

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

function makeHarness(listProjectsImpl?: App["listProjects"]) {
  const captured: CapturedTool[] = [];
  const register = vi.fn((_server, name, config, handler) => {
    captured.push({ name, config, handler });
  });

  const app = {
    listProjects:
      listProjectsImpl ??
      vi.fn().mockResolvedValue({
        projects: [
          {
            collectionName: "code_abc",
            path: "/repo",
            name: "alpha",
            embeddingModel: "m",
            embeddingDimensions: 384,
            qdrantUrl: "http://q",
            indexedAt: "t",
            teaRagsVersion: "v",
            chunksCount: 1,
          },
        ],
      }),
  } as unknown as App;

  const server = {} as Parameters<typeof registerProjectTools>[0];
  registerProjectTools(server, { app, register });

  return { captured, app, register };
}

describe("registerProjectTools — list_projects", () => {
  it("registers the list_projects tool", () => {
    const { captured } = makeHarness();
    expect(captured.map((t) => t.name)).toContain("list_projects");
  });

  it("tool has title, description, readOnly annotation, and empty input schema", () => {
    const { captured } = makeHarness();
    const tool = captured.find((t) => t.name === "list_projects");
    expect(tool).toBeDefined();
    expect(tool!.config.title).toBeTruthy();
    expect(typeof tool!.config.description).toBe("string");
    expect((tool!.config.description as string).length).toBeGreaterThan(20);
    expect(tool!.config.annotations).toMatchObject({ readOnlyHint: true });
  });

  it("handler delegates to app.listProjects and returns JSON-formatted result", async () => {
    const { captured, app } = makeHarness();
    const tool = captured.find((t) => t.name === "list_projects")!;
    const result = (await tool.handler({}, {})) as { content: { type: string; text: string }[] };
    expect(app.listProjects).toHaveBeenCalledTimes(1);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text) as { projects: { name: string }[] };
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].name).toBe("alpha");
  });

  it("returns empty projects list when registry is empty", async () => {
    const listProjects = vi.fn().mockResolvedValue({ projects: [] });
    const { captured } = makeHarness(listProjects as unknown as App["listProjects"]);
    const tool = captured.find((t) => t.name === "list_projects")!;
    const result = (await tool.handler({}, {})) as { content: { type: string; text: string }[] };
    const parsed = JSON.parse(result.content[0].text) as { projects: unknown[] };
    expect(parsed.projects).toEqual([]);
  });
});
