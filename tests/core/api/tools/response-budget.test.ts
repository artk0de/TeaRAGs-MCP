import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";

import type { McpToolResult } from "../../../../src/core/api/tools/format.js";
import { createRegisterTool } from "../../../../src/core/api/tools/middleware/error-handler.js";
import {
  enforceResponseBudget,
  offsetContinuation,
  RESPONSE_BUDGET_CHARS,
  RESPONSE_BUDGET_TOKENS,
  RESPONSE_CHARS_PER_TOKEN,
  type ResponseRowsPolicy,
} from "../../../../src/core/api/tools/response-budget.js";

const SEARCH_POLICY: ResponseRowsPolicy = {
  rows: ["results"],
  continuation: offsetContinuation(),
  narrowing: ["limit", "pathPattern", "metaOnly"],
};

const ARCHITECTURE_POLICY: ResponseRowsPolicy = {
  rows: ["violations.*"],
  continuation: offsetContinuation(["reportId"]),
  narrowing: ["limit", "detectors"],
};

const WORKING_TREE = { tree: "/wt/agent", project: "tea-rags", changedFiles: 0 };

function table(count: number, cellChars: number, tag = "r"): { columns: string[]; rows: unknown[][] } {
  return {
    columns: ["id", "content"],
    rows: Array.from({ length: count }, (_, i) => [`${tag}${String(i)}`, "x".repeat(cellChars)]),
  };
}

function searchResult(rowCount: number, cellChars: number): McpToolResult {
  return {
    structuredContent: {
      results: table(rowCount, cellChars),
      driftWarning: "index drifted",
      workingTree: WORKING_TREE,
      next: { columns: ["tool", "why"], rows: [["get_callers", "importers"]] },
      empty: { reason: "none" },
      missing: ["Foo#bar"],
      directory: { files: ["a.ts"] },
    },
    content: [],
  };
}

function sizeOf(result: McpToolResult): number {
  return JSON.stringify(result.structuredContent ?? result.content[0]?.text).length;
}

describe("response budget", () => {
  it("pins the budget at 12k tokens of 3.5 chars each", () => {
    expect(RESPONSE_BUDGET_TOKENS).toBe(12_000);
    expect(RESPONSE_CHARS_PER_TOKEN).toBe(3.5);
    expect(RESPONSE_BUDGET_CHARS).toBe(42_000);
  });

  it("leaves an answer under budget unchanged, with no truncated block", () => {
    const result = searchResult(3, 100);
    const before = JSON.stringify(result);

    const out = enforceResponseBudget(result, "hybrid_search", { query: "q" }, SEARCH_POLICY);

    expect(JSON.stringify(out)).toBe(before);
    expect((out.structuredContent as Record<string, unknown>).truncated).toBeUndefined();
  });

  it("trims whole rows from the tail to fit and points next at the continued offset of the answering tree", () => {
    const result = searchResult(50, 1000);
    const original = (result.structuredContent as { results: { rows: unknown[][] } }).results.rows.map((row) => [
      ...row,
    ]);
    const args = { project: "other", path: "/main", query: "q", limit: 50, offset: 10 };

    const out = enforceResponseBudget(result, "hybrid_search", args, SEARCH_POLICY);
    const answer = out.structuredContent as {
      results: { columns: string[]; rows: unknown[][] };
      truncated: { returned: number; omitted: number; next: { tool: string; args: Record<string, unknown> } };
    };

    expect(sizeOf(out)).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    const kept = answer.results.rows.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(50);
    expect(answer.results.rows).toEqual(original.slice(0, kept));
    expect(answer.results.columns).toEqual(["id", "content"]);
    expect(answer.truncated.returned).toBe(kept);
    expect(answer.truncated.omitted).toBe(50 - kept);
    expect(answer.truncated.next.tool).toBe("hybrid_search");
    expect(answer.truncated.next.args).toEqual({
      project: "tea-rags",
      path: "/wt/agent",
      query: "q",
      limit: 50,
      offset: 10 + kept,
    });
  });

  it("never drops summary, workingTree, empty, next, notices, reportId, directory or missing", () => {
    const out = enforceResponseBudget(searchResult(50, 1000), "hybrid_search", { query: "q" }, SEARCH_POLICY);
    const answer = out.structuredContent as Record<string, unknown>;

    expect(answer.driftWarning).toBe("index drifted");
    expect(answer.workingTree).toEqual(WORKING_TREE);
    expect(answer.next).toEqual({ columns: ["tool", "why"], rows: [["get_callers", "importers"]] });
    expect(answer.empty).toEqual({ reason: "none" });
    expect(answer.missing).toEqual(["Foo#bar"]);
    expect(answer.directory).toEqual({ files: ["a.ts"] });
  });

  it("caps every architecture violation group to one per-detector count and pages the held report by reportId", () => {
    const answer = {
      reportId: "report-1",
      summary: { layering: { total: 40 } },
      violations: {
        layering: table(40, 600, "l"),
        shotgunSurgery: table(40, 600, "s"),
        hubLikeDependency: [{ file: "hub.ts" }],
      },
      workingTree: WORKING_TREE,
    };
    const result: McpToolResult = { content: [{ type: "text", text: JSON.stringify(answer) }] };

    const out = enforceResponseBudget(
      result,
      "get_architecture_report",
      { project: "tea-rags", offset: 5 },
      ARCHITECTURE_POLICY,
    );
    const parsed = JSON.parse(out.content[0].text) as {
      summary: unknown;
      violations: Record<string, { rows: unknown[][] } | unknown[]>;
      truncated: { returned: number; omitted: number; next: { args: Record<string, unknown> } };
    };

    expect(out.content[0].text.length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    expect(parsed.summary).toEqual(answer.summary);
    const layering = (parsed.violations.layering as { rows: unknown[][] }).rows.length;
    const shotgun = (parsed.violations.shotgunSurgery as { rows: unknown[][] }).rows.length;
    expect(layering).toBe(shotgun);
    expect(layering).toBeLessThan(40);
    expect(parsed.violations.hubLikeDependency).toEqual([{ file: "hub.ts" }]);
    expect(parsed.truncated.returned).toBe(2 * layering + 1);
    expect(parsed.truncated.omitted).toBe(2 * (40 - layering));
    expect(parsed.truncated.next.args).toEqual({
      project: "tea-rags",
      path: "/wt/agent",
      offset: 5 + layering,
      reportId: "report-1",
    });
  });

  it("names the narrowing knobs and emits no next for a tool without a paging param", () => {
    const policy: ResponseRowsPolicy = { narrowing: ["limit", "pathPattern"] };
    const answer = {
      callers: Array.from({ length: 80 }, (_, i) => ({ file: `f${String(i)}.ts`, pad: "y".repeat(800) })),
    };
    const result: McpToolResult = { content: [{ type: "text", text: JSON.stringify(answer) }] };

    const out = enforceResponseBudget(result, "get_callers", { symbolId: "X" }, policy);
    const parsed = JSON.parse(out.content[0].text) as {
      callers: unknown[];
      truncated: { returned: number; omitted: number; next?: unknown; message: string };
    };

    expect(out.content[0].text.length).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
    expect(parsed.truncated.next).toBeUndefined();
    expect(parsed.truncated.message).toContain("limit");
    expect(parsed.truncated.message).toContain("pathPattern");
    expect(parsed.truncated.returned + parsed.truncated.omitted).toBe(80);
  });

  it("applies the declared policy at registration and keeps it off the SDK config", async () => {
    const registerTool = vi.fn();
    const server = { registerTool } as unknown as McpServer;
    const register = createRegisterTool();

    register(
      server,
      "hybrid_search",
      { description: "d", responseRows: SEARCH_POLICY } as Parameters<typeof register>[2],
      async () => searchResult(50, 1000),
    );

    const [, config, handler] = registerTool.mock.calls[0] as [
      string,
      Record<string, unknown>,
      (args: unknown, extra: unknown) => Promise<McpToolResult>,
    ];
    expect(config.responseRows).toBeUndefined();
    const out = await handler({ query: "q" }, {});
    expect((out.structuredContent as Record<string, unknown>).truncated).toBeDefined();
    expect(sizeOf(out)).toBeLessThanOrEqual(RESPONSE_BUDGET_CHARS);
  });

  it("keeps one row per collection when even that overflows, pages on, and names the narrowing knobs", () => {
    const answer = {
      reportId: "report-2",
      summary: { pad: "s".repeat(40_000) },
      violations: { layering: table(5, 2000, "l"), shotgunSurgery: table(5, 2000, "s") },
    };
    const result: McpToolResult = { content: [{ type: "text", text: JSON.stringify(answer) }] };

    const out = enforceResponseBudget(result, "get_architecture_report", { offset: 0 }, ARCHITECTURE_POLICY);
    const parsed = JSON.parse(out.content[0].text) as {
      violations: Record<string, { rows: unknown[][] }>;
      truncated: { returned: number; next: { args: Record<string, unknown> }; message: string };
    };

    expect(parsed.violations.layering.rows).toHaveLength(1);
    expect(parsed.violations.shotgunSurgery.rows).toHaveLength(1);
    expect(parsed.truncated.next.args).toEqual({ offset: 1, reportId: "report-2" });
    expect(parsed.truncated.message).toContain("detectors");
  });
});
