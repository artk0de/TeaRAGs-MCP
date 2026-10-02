/**
 * Param × tool applicability over the REAL `tools/list` surface
 * (bd tea-rags-mcp-86wsz, tea-rags-mcp-ewg2s).
 *
 * Every set here is DERIVED from code, never hand-listed: the tool surface is
 * built from the real composition (registry → Reranker → SchemaBuilder →
 * registerAllTools) and read back through an MCP client, and the "applied"
 * filter params are the `FilterDescriptor#param`s the composition's trajectory
 * registry turns into Qdrant conditions (`TrajectoryRegistry#buildFilter`).
 *
 * A typed filter param the registry does not know is stripped of meaning: the
 * search runs unfiltered and says nothing. So a param named like ANY trajectory
 * filter must be applied by the registry of the composition that exposes it.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { beforeAll, describe, expect, it } from "vitest";

import { buildToolSurface, type ToolSurface } from "../../../scripts/measure-tools-list.js";
import { TYPED_FILTER_PARAM_NAMES, WORKING_TREE_PATH_HINT } from "../../../src/mcp/tools/schemas.js";

/** Longest inline param hint; reference prose belongs to tea-rags://schema/overview. */
const MAX_PARAM_HINT_WORDS = 20;

function paramNames(tool: Tool): string[] {
  return Object.keys(tool.inputSchema.properties ?? {});
}

function paramDescriptions(tool: Tool): [string, string][] {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  return Object.entries(props).map(([name, schema]) => [name, schema.description ?? ""]);
}

describe("MCP param × tool applicability", () => {
  let on: ToolSurface;
  let off: ToolSurface;

  beforeAll(async () => {
    [on, off] = await Promise.all([buildToolSurface(true), buildToolSurface(false)]);
  }, 60_000);

  /** Every param name any trajectory can apply — the full composition's registry. */
  const allFilterParams = () => on.appliedFilterParams;

  it("the full composition registers filters from every trajectory, codegraph included", () => {
    const codegraphOnly = [...on.appliedFilterParams].filter((p) => !off.appliedFilterParams.has(p));
    expect(codegraphOnly.length).toBeGreaterThan(0);
  });

  it("every typed filter the MCP catalog declares is applied by some trajectory (no dead param)", () => {
    const dead = TYPED_FILTER_PARAM_NAMES.filter((p) => !allFilterParams().has(p));
    expect(dead).toEqual([]);
  });

  for (const composition of ["codegraph ON", "codegraph OFF"] as const) {
    it(`${composition}: no tool exposes a filter param its registry does not apply`, () => {
      const surface = composition === "codegraph ON" ? on : off;
      const unapplied = surface.tools.flatMap((tool) =>
        paramNames(tool)
          .filter((p) => allFilterParams().has(p) && !surface.appliedFilterParams.has(p))
          .map((p) => `${tool.name}.${p}`),
      );
      expect(unapplied).toEqual([]);
    });
  }

  it("codegraph ON: every typed-filter tool exposes the same codegraph filter set", () => {
    const codegraphParams = new Set([...on.appliedFilterParams].filter((p) => !off.appliedFilterParams.has(p)));
    const exposure = new Map(
      on.tools
        .map(
          (tool) =>
            [
              tool.name,
              paramNames(tool)
                .filter((p) => codegraphParams.has(p))
                .sort(),
            ] as const,
        )
        .filter(([, params]) => params.length > 0),
    );
    expect(exposure.size).toBeGreaterThan(0);
    const distinct = new Set([...exposure.values()].map((params) => params.join(",")));
    expect(distinct.size).toBe(1);
  });

  // bd tea-rags-mcp-xi2r9: every read tool addressed by the { collection, project, path }
  // triad resolves `path` through resolveWorkingTree, so all of them state ONE hint.
  it("every triad-addressed tool states the working-tree path hint", () => {
    const triadTools = on.tools.filter((tool) =>
      ["collection", "project", "path"].every((p) => paramNames(tool).includes(p)),
    );
    expect(triadTools.length).toBeGreaterThan(0);
    const drifted = triadTools
      .filter((tool) => Object.fromEntries(paramDescriptions(tool)).path !== WORKING_TREE_PATH_HINT)
      .map((tool) => tool.name);
    expect(drifted).toEqual([]);
  });

  it("every param hint stays within the inline word budget", () => {
    // Filter-preset NAMES in the `filter` hint are an enumeration, not prose.
    const presetNames = new Set(on.filterPresetNames);
    const tooLong = on.tools.flatMap((tool) =>
      paramDescriptions(tool)
        .map(([name, text]) => {
          const words = text.split(/\s+/).filter((w) => w.length > 0 && !presetNames.has(w.replace(/[,.]$/, "")));
          return [name, words.length] as const;
        })
        .filter(([, count]) => count > MAX_PARAM_HINT_WORDS)
        .map(([name, count]) => `${tool.name}.${name} (${count} words)`),
    );
    expect(tooLong).toEqual([]);
  });
});
