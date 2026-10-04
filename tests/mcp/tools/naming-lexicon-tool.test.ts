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

  // bd tea-rags-mcp-433d2: CONFORMS is read as "the name is right" unless the contract says otherwise.
  it("says CONFORMS judges vocabulary, not whether the name fits the behaviour", () => {
    expect(registered().config.description).toMatch(/CONFORMS[^;]*vocabulary[^;]*not behaviou?r/i);
  });

  it("tells an agent which kind an attribute and a method name are, and how a collection draft is written", () => {
    const { config } = registered();
    const draft = (
      toJsonSchemaCompat(config.inputSchema) as {
        properties: { names: { items: { properties: Record<string, { description?: string; enum?: string[] }> } } };
      }
    ).properties.names.items.properties;
    expect(draft.kind.description).toMatch(/ivar.*attribute.*property.*field/i);
    expect(draft.kind.description).toMatch(/method.*return.*result type/i);
    expect(draft.typeMultiplicity.enum).toEqual(["one", "many"]);
    expect(draft.typeMultiplicity.description).toMatch(/element/i);
    expect(config.description).toMatch(/field/);
    expect(config.description).toMatch(/return/);
  });

  it("forwards a collection draft's typeMultiplicity", async () => {
    const { handler, app } = registered();
    vi.mocked(app.getNamingLexicon).mockResolvedValue({ scope: "", byType: [], names: [] });
    await handler({ collection: "c", names: [{ name: "items", type: "Item", typeMultiplicity: "many" }] });
    expect(vi.mocked(app.getNamingLexicon).mock.calls[0][0].names).toEqual([
      { name: "items", type: "Item", typeMultiplicity: "many" },
    ]);
  });

  // bd tea-rags-mcp-vi0wx: type and constant names are drafts of kind `type`, judged by the file they live in.
  it("accepts a type draft with path and extends, and rejects one without a path", () => {
    const { inputSchema } = registered().config;
    expect(
      inputSchema.safeParse({
        project: "p",
        names: [
          {
            name: "ResolutionOutcome",
            kind: "type",
            path: "src/x/strategies/new.ts",
            extends: "SymbolResolutionStrategy",
          },
          { name: "MAX_RETRIES", kind: "type", path: "src/x/limits.ts" },
        ],
      }).success,
    ).toBe(true);
    expect(inputSchema.safeParse({ project: "p", names: [{ name: "Commit", kind: "type" }] }).success).toBe(false);
  });

  it("tells an agent the type-draft verdicts and fields", () => {
    const { config } = registered();
    const draft = (
      toJsonSchemaCompat(config.inputSchema) as {
        properties: { names: { items: { properties: Record<string, { description?: string; enum?: string[] }> } } };
      }
    ).properties.names.items.properties;
    expect(draft.kind.enum).toContain("type");
    expect(draft.path).toBeDefined();
    expect(draft.extends).toBeDefined();
    expect(config.description).toMatch(/COLLISION/);
    expect(config.description).toMatch(/alternatives/);
  });

  it("forwards a type draft unchanged", async () => {
    const { handler, app } = registered();
    vi.mocked(app.getNamingLexicon).mockResolvedValue({ scope: "", byType: [], names: [] });
    const names = [{ name: "Commit", kind: "type", path: "src/vcs/commit.ts", extends: "Base" }];
    await handler({ collection: "c", names });
    expect(vi.mocked(app.getNamingLexicon).mock.calls[0][0].names).toEqual(names);
  });

  // bd tea-rags-mcp-89k7k.18: the diff mode is part of the ops contract
  // (`NamingLexiconRequest.changes`/`files`, answered with `review`) — the MCP
  // boundary exposes the same shape review_changes sends for its naming
  // section. Until the schema listed the fields, the SDK's zod parse stripped
  // them and the at-least-one refine bounced a changes-only request.
  it("exposes the diff mode: `changes`/`files` validate and satisfy the at-least-one refine", () => {
    const { inputSchema } = registered().config;
    expect(inputSchema.safeParse({ project: "p", changes: { base: "main" } }).success).toBe(true);
    expect(inputSchema.safeParse({ project: "p", files: ["src/a.ts"] }).success).toBe(true);
    // An empty `files` array is not a diff request — the ops reject it, so does the shape.
    expect(inputSchema.safeParse({ project: "p", files: [] }).success).toBe(false);
    // A request that asks for nothing still fails.
    expect(inputSchema.safeParse({ project: "p" }).success).toBe(false);
  });

  it("forwards the diff request verbatim to the ops layer", async () => {
    const { config, handler, app } = registered();
    vi.mocked(app.getNamingLexicon).mockResolvedValue({ scope: "", byType: [], names: [] });
    // Parsed the way the SDK parses a tool call: through the boundary schema.
    await handler(config.inputSchema.parse({ collection: "c", changes: { base: "main" }, files: ["src/a.ts"] }));
    expect(vi.mocked(app.getNamingLexicon).mock.calls[0][0]).toEqual({
      collection: "c",
      changes: { base: "main" },
      files: ["src/a.ts"],
    });
  });

  it("documents the diff mode and routes a full diff review to review_changes", () => {
    const { description } = registered().config;
    expect(description).toMatch(/`changes`\/`files`/);
    expect(description).toMatch(/review_changes/);
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
