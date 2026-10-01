/**
 * `review_changes` MCP tool (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): the
 * sections enum is DERIVED from the live provider registry (an id with no
 * provider — `architecture`, slice 2 — is rejected at the boundary, so an
 * agent asking for a section never has to guess whether it ran), the default
 * is all registered sections, and the handler forwards to
 * `app.reviewChanges`. Absence without codegraph is the registrar's gate.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { App } from "../../../src/core/api/index.js";
import { registerReviewChangesTool } from "../../../src/mcp/tools/review-changes.js";

interface RegisteredTool {
  config: {
    title: string;
    description: string;
    inputSchema: { safeParse: (input: unknown) => { success: boolean } };
    annotations: Record<string, boolean>;
  };
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  app: App;
}

function registered(hasCodegraph = true): RegisteredTool | undefined {
  const register = vi.fn();
  const app = {
    hasProvider: vi.fn(() => hasCodegraph),
    reviewChanges: vi.fn(),
  } as unknown as App;
  registerReviewChangesTool({} as McpServer, { app, register });
  const call = register.mock.calls.find((c) => c[1] === "review_changes");
  if (call === undefined) return undefined;
  return { config: call[2] as RegisteredTool["config"], handler: call[3] as RegisteredTool["handler"], app };
}

describe("review_changes registration", () => {
  it("registers when the codegraph provider is loaded, and does not when it is not", () => {
    expect(registered(true)).toBeDefined();
    expect(registered(false)).toBeUndefined();
  });

  it("is a read-only, idempotent tool", () => {
    expect(registered()?.config.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });
});

describe("review_changes schema", () => {
  it("rejects an unknown section id — including one whose provider has not shipped yet", () => {
    const { inputSchema } = registered()!.config;
    expect(inputSchema.safeParse({ project: "p", sections: ["nope"] }).success).toBe(false);
    // `architecture` is in the TYPE union but no provider ships this slice — the
    // enum is derived from the live registry, so asking for it fails loud.
    expect(inputSchema.safeParse({ project: "p", sections: ["architecture"] }).success).toBe(false);
    expect(inputSchema.safeParse({ project: "p", sections: ["naming", "cohesion"] }).success).toBe(true);
    expect(inputSchema.safeParse({ project: "p", sections: [] }).success).toBe(false);
  });

  it("defaults to every registered section: sections omitted is a valid full review", () => {
    const { inputSchema } = registered()!.config;
    expect(inputSchema.safeParse({ project: "p" }).success).toBe(true);
    expect(inputSchema.safeParse({ project: "p", changes: { base: "main" }, files: ["src/a.ts"] }).success).toBe(true);
    expect(inputSchema.safeParse({ project: "p", files: [] }).success).toBe(false);
  });
});

describe("review_changes handler", () => {
  it("forwards the parsed request to app.reviewChanges and returns its answer as JSON text", async () => {
    const { handler, app } = registered()!;
    const answer = { review: { workTree: "/w", sections: {} } };
    (app.reviewChanges as ReturnType<typeof vi.fn>).mockResolvedValue(answer);
    const args = { project: "p", changes: { base: "main" }, sections: ["cohesion"] };

    const result = await handler(args);

    expect(app.reviewChanges).toHaveBeenCalledWith(args);
    expect(JSON.parse(result.content[0].text)).toEqual(answer);
  });
});
