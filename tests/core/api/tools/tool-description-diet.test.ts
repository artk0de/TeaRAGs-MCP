/**
 * Tool description diet (bd tea-rags-mcp-0y5oj, T8b): the model-visible schema
 * carries the CALL contract only. How to read an answer lives in an on-demand
 * guide the description points at; the `rerank` custom arm names no signal
 * keys (the catalog is `tea-rags://guide/signals`); the shared `project` /
 * `path` hints stay one short string each.
 *
 * Measured over the REAL tools/list (codegraph ON), the surface an MCP client
 * receives.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildToolSurface } from "../../../../scripts/measure-tools-list.js";
import { UnknownRerankSignalError } from "../../../../src/core/api/public/errors.js";
import { sanitizeRerank } from "../../../../src/core/api/tools/format.js";

const MAX_INTERPRETING_TOOL_DESCRIPTION = 600;
const MAX_ADDRESS_HINT = 60;
const MAX_HYBRID_SEARCH_INPUT_SCHEMA_CHARS = 4000;
const MAX_FIND_SYMBOL_INPUT_SCHEMA_CHARS = 2050;
const MAX_FIND_SYMBOL_DESCRIPTION_CHARS = 740;

describe("tool description diet (real tools/list, codegraph ON)", () => {
  let tools: Tool[];
  beforeAll(async () => {
    ({ tools } = await buildToolSurface(true));
  });

  const tool = (name: string): Tool => {
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`${name} not in tools/list`);
    return found;
  };
  const props = (name: string): Record<string, { description?: string; anyOf?: unknown[] }> =>
    (tool(name).inputSchema as { properties: Record<string, { description?: string }> }).properties;

  it.each([
    ["get_architecture_report", "tea-rags://guide/architecture"],
    ["review_changes", "tea-rags://guide/review"],
  ])("%s description ≤ 600 chars and points at its interpretation guide", (name, guide) => {
    const { description = "" } = tool(name);
    expect(description.length).toBeLessThanOrEqual(MAX_INTERPRETING_TOOL_DESCRIPTION);
    expect(description).toContain(guide);
  });

  it("rerank custom arm is an open {signal: number} map pointing at the signals guide, not an enumeration", () => {
    for (const name of ["semantic_search", "hybrid_search", "rank_chunks", "find_similar", "find_symbol"]) {
      const { rerank } = props(name);
      expect(rerank.description, name).toContain("tea-rags://guide/signals");
      const custom = (rerank.anyOf as { properties?: { custom?: Record<string, unknown> } }[])
        .map((arm) => arm.properties?.custom)
        .find((arm) => arm !== undefined);
      expect(custom, name).toMatchObject({ type: "object", additionalProperties: { type: "number" } });
      expect(custom, name).not.toHaveProperty("properties");
    }
  });

  // bd tea-rags-mcp-9f0yn.11: `tea-rags://schema/*` is a deprecated alias (plugin-guidance-layers.md);
  // every pointer the model reads in tools/list names the canonical guide URI.
  it("no tool description or param hint points at the deprecated tea-rags://schema/* alias", () => {
    const offenders = tools
      .filter((t) => JSON.stringify([t.description, t.inputSchema]).includes("tea-rags://schema/"))
      .map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it("project and path hints are ≤ 60 chars and still carry their gotcha", () => {
    const { project, path } = props("semantic_search");
    expect(project.description?.length).toBeLessThanOrEqual(MAX_ADDRESS_HINT);
    expect(project.description).toMatch(/list_projects|prime/);
    expect(path.description?.length).toBeLessThanOrEqual(MAX_ADDRESS_HINT);
    expect(path.description).toMatch(/working tree|cwd/i);
  });

  // bd tea-rags-mcp-d0z7b.5: the alwaysLoad tools ship in every request's
  // prefix, so their param hints are one clause each (reference prose lives in
  // tea-rags://guide/overview). Caps = measured input-schema JSON chars.
  it.each([
    ["hybrid_search", MAX_HYBRID_SEARCH_INPUT_SCHEMA_CHARS],
    ["find_symbol", MAX_FIND_SYMBOL_INPUT_SCHEMA_CHARS],
  ])("alwaysLoad %s input schema stays ≤ its trimmed size", (name, cap) => {
    expect(JSON.stringify(tool(name).inputSchema).length).toBeLessThanOrEqual(cap);
  });

  it("alwaysLoad find_symbol description stays ≤ its trimmed size", () => {
    expect(tool("find_symbol").description?.length).toBeLessThanOrEqual(MAX_FIND_SYMBOL_DESCRIPTION_CHARS);
  });
});

describe("sanitizeRerank custom-key validation", () => {
  const signals = ["similarity", "recency", "churn"];

  it("rejects an unknown custom key with a typed error listing the valid keys", () => {
    let thrown: unknown;
    try {
      sanitizeRerank({ custom: { similarity: 0.5, recencyy: 0.5 } }, signals);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownRerankSignalError);
    const { message, hint } = thrown as UnknownRerankSignalError;
    expect(message).toContain("recencyy");
    for (const signal of signals) expect(hint).toContain(signal);
  });

  it("passes known keys through and drops undefined weights", () => {
    expect(sanitizeRerank({ custom: { similarity: 0.5, churn: undefined } }, signals)).toEqual({
      custom: { similarity: 0.5 },
    });
    expect(sanitizeRerank("techDebt", signals)).toBe("techDebt");
    expect(sanitizeRerank(undefined, signals)).toBeUndefined();
  });
});
