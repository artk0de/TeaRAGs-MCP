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
    reviewSectionIds: () => ["naming", "incompleteChange", "cohesion", "architecture", "norms"] as const,
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

  // bd tea-rags-mcp-89k7k.1.19.6: the verified repair reaches the agent, and the contract names it.
  it("an architecture finding's remedy survives the formatter and the description names it", async () => {
    const { handler, app, config } = registered()!;
    const remedy = {
      kind: "retargetImport",
      sourceRelPath: "src/app/a.ts",
      fromRelPath: "src/lib/x.ts",
      toRelPath: "src/lib/index.ts",
      importedNames: ["b"],
    };
    const answer = {
      review: {
        workTree: "/w",
        sections: {
          architecture: {
            built: true,
            findings: [{ detector: "leakingAbstraction", subject: "src/app/a.ts -> src/lib/x.ts", remedy }],
            detectors: [],
          },
        },
      },
    };
    (app.reviewChanges as ReturnType<typeof vi.fn>).mockResolvedValue(answer);

    const result = await handler({ sections: ["architecture"] });

    expect(JSON.parse(result.content[0].text).review.sections.architecture.findings[0].remedy).toEqual(remedy);
    expect(config.description).toContain("remedy");
  });

  it("the architecture change block survives the formatter and the description names its contract (bd tea-rags-mcp-89k7k.1.7)", async () => {
    const { handler, app, config } = registered()!;
    const change = {
      introducedCount: 1,
      nonLocal: [{ family: "stableDependencies", subject: "src/far -> src/away" }],
      resolved: [],
      persisting: [{ family: "silentCoupling.pair", subject: "src/a.ts ~ src/b.ts" }],
      indexLag: { indexedCommit: "abc", treeCommit: "def" },
      maybeAlreadyCommitted: true,
    };
    (app.reviewChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      review: { workTree: "/w", sections: { architecture: { built: true, findings: [], detectors: [], change } } },
    });

    const result = await handler({ sections: ["architecture"] });

    expect(JSON.parse(result.content[0].text).review.sections.architecture.change).toEqual(change);
    for (const term of ["introducedCount", "nonLocal", "resolved", "persisting", "maybeAlreadyCommitted"]) {
      expect(config.description).toContain(term);
    }
  });

  it("the impact tiers survive the formatter and the description names touchedActive (bd tea-rags-mcp-r8hme.53)", async () => {
    const { handler, app, config } = registered()!;
    const change = {
      introducedCount: 0,
      nonLocal: [],
      resolved: [],
      persisting: [{ family: "stableDependencies", subject: "src/m -> src/n", tier: "structural" }],
      touchedActive: [{ family: "stableDependencies", subject: "src/p -> src/q", tier: "critical" }],
    };
    const findings = [{ detector: "stableDependencies", subject: "src/a -> src/b", tier: "active" }];
    (app.reviewChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      review: { workTree: "/w", sections: { architecture: { built: true, findings, detectors: [], change } } },
    });

    const { architecture } = JSON.parse((await handler({ sections: ["architecture"] })).content[0].text).review
      .sections;

    expect(architecture.change).toEqual(change);
    expect(architecture.findings[0].tier).toBe("active");
    for (const term of ["touchedActive", "tier", "critical"]) expect(config.description).toContain(term);
  });
});
