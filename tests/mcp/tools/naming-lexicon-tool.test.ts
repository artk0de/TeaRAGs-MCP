/**
 * `get_naming_lexicon` MCP tool (bd tea-rags-mcp-4p3sb.12): a compact call
 * contract registered with the codegraph tools. The schema rejects a request
 * that asks for nothing, the handler forwards to `app.getNamingLexicon`, and a
 * budget keeps later edits from bloating the schema every client loads.
 * Absence without codegraph is covered by `codegraph-gating.test.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";

interface RegisteredTool {
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodObject;
    annotations: Record<string, boolean>;
  };
  handler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  app: App;
}

function registered(): RegisteredTool {
  const register = vi.fn();
  const app = {
    hasProvider: vi.fn(() => true),
    getNamingLexicon: vi.fn(),
  } as unknown as App;
  const schemaBuilder = { buildPresetSchema: vi.fn(() => z.enum(["bugHunt"])) } as unknown as SchemaBuilder;
  registerCodegraphTools({} as McpServer, { app, schemaBuilder, register });
  const call = register.mock.calls.find((c) => c[1] === "get_naming_lexicon");
  expect(call).toBeDefined();
  return { config: call?.[2] as RegisteredTool["config"], handler: call?.[3] as RegisteredTool["handler"], app };
}

describe("get_naming_lexicon", () => {
  it("is a read-only, idempotent tool", () => {
    expect(registered().config.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it("rejects a request that asks for none of types / anchors / concept / names", () => {
    const { inputSchema } = registered().config;
    expect(inputSchema.safeParse({ project: "tea-rags" }).success).toBe(false);
    expect(inputSchema.safeParse({ project: "tea-rags", types: [], names: [] }).success).toBe(false);
  });

  it("rejects a concept without a language", () => {
    const { inputSchema } = registered().config;
    expect(inputSchema.safeParse({ project: "p", concept: "vendor envelope sync" }).success).toBe(false);
    expect(inputSchema.safeParse({ project: "p", concept: "vendor envelope sync", language: "ruby" }).success).toBe(
      true,
    );
  });

  it("accepts types, anchors and draft names with kind, type and callee", () => {
    const { inputSchema } = registered().config;
    expect(inputSchema.safeParse({ project: "p", types: ["TaxAutomationDocument"] }).success).toBe(true);
    expect(inputSchema.safeParse({ project: "p", anchors: ["Doc.find_doc!"] }).success).toBe(true);
    expect(
      inputSchema.safeParse({
        project: "p",
        pathPattern: "app/services/**",
        names: [
          { name: "row", kind: "local", type: "TaxAutomationDocument" },
          { name: "row", callee: { member: "find", receiver: "TaxAutomationDocument" } },
        ],
      }).success,
    ).toBe(true);
    expect(inputSchema.safeParse({ project: "p", names: [{ name: "row", kind: "variable" }] }).success).toBe(false);
  });

  it("forwards the request to app.getNamingLexicon and returns its answer as JSON text", async () => {
    const { handler, app } = registered();
    const answer = { scope: "", byType: [], names: [] };
    (app.getNamingLexicon as ReturnType<typeof vi.fn>).mockResolvedValue(answer);
    const args = {
      project: "p",
      language: "ruby",
      types: ["Doc"],
      names: [{ name: "row", kind: "local", callee: { member: "find_doc!" } }],
    };

    const result = await handler(args);

    expect(app.getNamingLexicon).toHaveBeenCalledWith(args);
    expect(JSON.parse(result.content[0].text)).toEqual(answer);
  });

  it("stays within the schema budget: description ≤ 300 chars, input schema ≤ 1.5 KB serialized", () => {
    const { config } = registered();
    expect(config.description.length).toBeLessThanOrEqual(300);
    // Converted the way the SDK lists a tool to clients.
    const inputSchema = toJsonSchemaCompat(config.inputSchema, { strictUnions: true, pipeStrategy: "input" });
    expect(JSON.stringify(inputSchema).length).toBeLessThanOrEqual(1536);
  });

  it("keeps one-line field descriptions and no examples", () => {
    const { properties } = toJsonSchemaCompat(registered().config.inputSchema) as {
      properties: Record<string, { description?: string; examples?: unknown }>;
    };
    for (const [field, spec] of Object.entries(properties)) {
      expect(spec.examples, field).toBeUndefined();
      expect(spec.description ?? "", field).not.toMatch(/\n/);
    }
  });
});
