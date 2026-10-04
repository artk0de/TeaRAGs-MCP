/**
 * `review_changes` MCP tool (bd tea-rags-mcp-89k7k.1.4, F3): the sections enum
 * is DERIVED from the live provider registry (an id with no provider is
 * rejected at the boundary, so an agent asking for a section never has to
 * guess whether it ran; `architecture` joined the accepted set when its
 * provider shipped, slice 2), the default is all registered sections, and the
 * handler forwards to `app.reviewChanges`. Absence without codegraph is the
 * registrar's gate.
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
    reviewSectionIds: () => ["naming", "incompleteChange", "cohesion", "architecture"] as const,
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
  it("rejects an unknown section id; every registered id — architecture included — is accepted", () => {
    const { inputSchema } = registered()!.config;
    expect(inputSchema.safeParse({ project: "p", sections: ["nope"] }).success).toBe(false);
    // INVARIANT CHANGE (F3 slice 2, bd tea-rags-mcp-89k7k.1.4): `architecture`
    // shipped its provider, so the derived enum now ACCEPTS it — previously it
    // was the rejected id-with-no-provider.
    expect(inputSchema.safeParse({ project: "p", sections: ["architecture"] }).success).toBe(true);
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
