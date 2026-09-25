/**
 * `get_ontology_report` (bd tea-rags-mcp-4p3sb.20) — the MCP surface of the
 * naming ontology audit. The schema is a call contract only and is held to the
 * compact budget the naming lexicon's tool set: description ≤ 300 chars, one
 * line per field description, no examples, whole schema ≤ 1.5 KB serialized.
 * Registration gating (absent without codegraph) is covered by
 * codegraph-gating.test.ts.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { App, SchemaBuilder } from "../../../src/core/api/index.js";
import { registerCodegraphTools } from "../../../src/mcp/tools/codegraph.js";

function registered() {
  const register = vi.fn();
  const app = {
    hasProvider: vi.fn().mockReturnValue(true),
    getOntologyReport: vi.fn(),
  } as unknown as App;
  const schemaBuilder = { buildPresetSchema: vi.fn(() => z.enum(["bugHunt"])) } as unknown as SchemaBuilder;
  registerCodegraphTools({} as McpServer, { app, schemaBuilder, register });
  const call = register.mock.calls.find((c) => c[1] === "get_ontology_report");
  const config = call?.[2] as {
    description: string;
    inputSchema: Record<string, z.ZodTypeAny>;
    annotations: Record<string, boolean>;
  };
  const handler = call?.[3] as (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
  return { app, config, handler };
}

describe("get_ontology_report — schema", () => {
  it("is registered read-only and idempotent", () => {
    const { config } = registered();
    expect(config).toBeDefined();
    expect(config.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
  });

  it("keeps the compact budget: description ≤ 300 chars, one-line field docs, schema ≤ 1.5 KB", () => {
    const { config } = registered();
    expect(config.description.length).toBeLessThanOrEqual(300);
    const json = z.toJSONSchema(z.object(config.inputSchema));
    const serialized = JSON.stringify(json);
    expect(serialized.length).toBeLessThanOrEqual(1536);
    for (const [field, schema] of Object.entries(config.inputSchema)) {
      const description = schema.description ?? "";
      expect(description, field).not.toMatch(/\n/);
      expect(description, field).not.toMatch(/e\.g\.|example/i);
    }
  });

  it("accepts the address, scope, language, sections and limit; rejects unknown sections and bad limits", () => {
    const schema = z.object(registered().config.inputSchema);
    expect(schema.safeParse({ project: "tea-rags" }).success).toBe(true);
    expect(
      schema.safeParse({
        project: "tea-rags",
        pathPattern: "src/core/**",
        language: "typescript",
        sections: ["synonyms", "collisions"],
        limit: 50,
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ project: "tea-rags", sections: ["conceptSynonyms"] }).success).toBe(false);
    expect(schema.safeParse({ project: "tea-rags", limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ project: "tea-rags", limit: 101 }).success).toBe(false);
  });
});

describe("get_ontology_report — handler", () => {
  it("forwards every field into app.getOntologyReport and returns its report as JSON text", async () => {
    const { app, handler } = registered();
    const report = {
      scope: { pathPrefix: "src/" },
      summary: { evidenceRows: 0, genericNameCount: 0, genericNames: [] },
      homonyms: [],
    };
    (app.getOntologyReport as ReturnType<typeof vi.fn>).mockResolvedValue(report);

    const result = await handler({
      project: "tea-rags",
      pathPattern: "src/**",
      language: "ruby",
      sections: ["homonyms"],
      limit: 5,
    });

    expect(app.getOntologyReport).toHaveBeenCalledWith({
      project: "tea-rags",
      collection: undefined,
      path: undefined,
      pathPattern: "src/**",
      language: "ruby",
      sections: ["homonyms"],
      limit: 5,
    });
    expect(JSON.parse(result.content[0].text)).toEqual(report);
  });

  it("returns a zero-row project's empty report unchanged, driftWarning included", async () => {
    const { app, handler } = registered();
    const report = {
      scope: { pathPrefix: "" },
      summary: { evidenceRows: 0, genericNameCount: 0, genericNames: [] },
      synonyms: [],
      driftWarning: "cg_identifiers is empty while the codegraph holds 12 symbols: reindex",
    };
    (app.getOntologyReport as ReturnType<typeof vi.fn>).mockResolvedValue(report);

    const result = await handler({ project: "tea-rags", sections: ["synonyms"] });

    expect(JSON.parse(result.content[0].text)).toEqual(report);
  });
});
