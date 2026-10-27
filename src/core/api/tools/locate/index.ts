/**
 * EXPERIMENTAL, hidden. Measured ineffective in the 2026-10-27 spike (Codex
 * TD-93238). Not listed in tools/list; registered only when
 * `EXPERIMENTAL_LOCATE_ENABLE` is truthy (bootstrap config, passed down as
 * `ToolDependencies#experimentalLocate`). Not covered by plugin guidance.
 *
 * `locate` spike tool — breadth-first localization for "which files implement /
 * must change for <behaviour>": seeds (semantic + hybrid) → identifiers from
 * seed bodies → sibling definitions / usages → callers, merged per file.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { CODEGRAPH_SYMBOLS_PROVIDER_KEY, type App, type ExploreResponse } from "../../public/index.js";
import { collectionPathFields } from "../codegraph.js";
import type { McpToolResult } from "../format.js";
import type { RegisterToolFn } from "../middleware/error-handler.js";
import {
  classifySiblingRows,
  edgeSelectivity,
  isTestPath,
  mergeLocateFiles,
  nonSelectiveIdentifiers,
  normalizeSymbolId,
  rankSeeds,
  selectHop2Sources,
  selectIdentifiers,
  topFilesPerDirectory,
  type LocateCallerHit,
  type LocateFile,
  type LocateRow,
  type LocateSiblingHit,
  type LocateStructuralHit,
} from "./locate-ranking.js";

const HOP1_SOURCES = 6;
const HOP2_SOURCES = 8;
const FILE_EDGE_LIMIT = 8;

const SEED_LIMIT = 15;
const SIBLING_LIMIT = 10;
const CALLER_SEEDS = 4;
const CALLER_LIMIT = 10;
const PIVOT_LIMIT = 25;
const PIVOT_DEFINITIONS_CAP = 8;
const PIVOT_CALLER_LIMIT = 3;
const ROW_FIELDS = ["relativePath", "symbolId", "content", "startLine"];

export const LOCATE_DESCRIPTION =
  "FIRST call for 'which files implement / must change for <behaviour or ticket>'. Returns a ranked file list " +
  "built server-side from semantic+hybrid seeds, identifiers in their bodies, parallel implementations " +
  "(definesSame) and callers. Confirm candidates with ONE batched find_symbol(symbols:[...]) before answering.";

const LocateInputShape = {
  ...collectionPathFields(),
  task: z.string().min(1).describe("Behaviour or ticket text to localize."),
  maxFiles: z.number().int().positive().max(30).optional().describe("Files returned (default 15, max 30)."),
};

interface LocateRequest {
  project?: string;
  path?: string;
  collection?: string;
  task: string;
  maxFiles?: number;
}

export interface LocateAnswer {
  files: LocateFile[];
  identifiers: string[];
  coverage: { seeds: number; siblingQueries: number; callerQueries: number; truncated: boolean };
}

function toRows(response: ExploreResponse): LocateRow[] {
  return response.results.flatMap((result) => {
    const payload = result.payload ?? {};
    const { relativePath } = payload;
    if (typeof relativePath !== "string") return [];
    return [
      {
        relativePath,
        ...(typeof payload.symbolId === "string" && { symbolId: payload.symbolId }),
        ...(typeof payload.content === "string" && { content: payload.content }),
        ...(typeof payload.startLine === "number" && { startLine: payload.startLine }),
      },
    ];
  });
}

export async function runLocate(app: App, request: LocateRequest): Promise<LocateAnswer> {
  const address = {
    ...(request.project !== undefined && { project: request.project }),
    ...(request.path !== undefined && { path: request.path }),
    ...(request.collection !== undefined && { collection: request.collection }),
  };
  const maxFiles = Math.min(request.maxFiles ?? 15, 30);

  const [semantic, hybrid] = await Promise.all([
    app.semanticSearch({
      ...address,
      query: request.task,
      limit: SEED_LIMIT,
      fields: ROW_FIELDS,
      testFile: "exclude",
      documentation: "exclude",
    }),
    app.hybridSearch({
      ...address,
      query: request.task,
      limit: SEED_LIMIT,
      fields: ROW_FIELDS,
      testFile: "exclude",
      documentation: "exclude",
    }),
  ]);
  const seeds = rankSeeds([toRows(semantic), toRows(hybrid)]);
  const { identifiers, pivots } = selectIdentifiers(seeds, { topSeeds: 6, keep: 8 });
  const searchRows = async (query: string, limit: number): Promise<LocateRow[]> =>
    toRows(
      await app.hybridSearch({
        ...address,
        query,
        limit,
        fields: ROW_FIELDS,
        testFile: "exclude",
        documentation: "exclude",
      }),
    );
  // Exact last-segment definition lookup: find_symbol's short-name post-filter.
  const definitionRows = async (name: string): Promise<LocateRow[]> => {
    try {
      return toRows(
        await app.findSymbol({ ...address, symbol: name, metaOnly: true, limit: PIVOT_LIMIT, fields: ROW_FIELDS }),
      );
    } catch {
      return [];
    }
  };

  const siblingLists = await Promise.all(
    identifiers.map(async (identifier) => {
      const isPivot = pivots.has(identifier);
      const [searched, defined] = await Promise.all([
        searchRows(identifier, isPivot ? PIVOT_LIMIT : SIBLING_LIMIT),
        isPivot ? definitionRows(identifier) : Promise.resolve([]),
      ]);
      return classifySiblingRows(identifier, [...searched, ...defined]);
    }),
  );
  const siblings: LocateSiblingHit[] = siblingLists.flat();
  const nonSelective = nonSelectiveIdentifiers(siblings);

  const graphAvailable = app.hasProvider(CODEGRAPH_SYMBOLS_PROVIDER_KEY);
  const seedTargets = new Set<string>();
  const pivotTargets = new Set<string>();
  if (graphAvailable) {
    for (const seed of seeds.filter((s) => s.symbolId && !s.symbolId.startsWith("doc:")).slice(0, CALLER_SEEDS)) {
      seedTargets.add(normalizeSymbolId(seed.symbolId ?? ""));
    }
    const perPivot = new Map<string, number>();
    for (const hit of siblings) {
      if (hit.relation !== "definesSame" || !hit.row.symbolId || !pivots.has(hit.identifier)) continue;
      const id = normalizeSymbolId(hit.row.symbolId);
      if (seedTargets.has(id) || pivotTargets.has(id) || isTestPath(hit.row.relativePath)) continue;
      const count = perPivot.get(hit.identifier) ?? 0;
      if (count >= PIVOT_DEFINITIONS_CAP) continue;
      perPivot.set(hit.identifier, count + 1);
      pivotTargets.add(id);
    }
  }
  const callersOf = async (symbolId: string, limit: number): Promise<LocateCallerHit[]> => {
    try {
      const response = await app.getCallers({ ...address, symbolId, limit });
      if (!("callers" in response)) return [];
      return response.callers.map((caller) => ({
        seedSymbol: symbolId,
        relativePath: caller.sourceRelPath,
        symbolId: caller.sourceSymbolId,
        callExpression: caller.callExpression,
      }));
    } catch {
      return [];
    }
  };
  const callerLists = await Promise.all([
    ...[...seedTargets].map(async (id) => callersOf(id, CALLER_LIMIT)),
    ...[...pivotTargets].map(async (id) => callersOf(id, PIVOT_CALLER_LIMIT)),
  ]);

  const callers = callerLists.flat();
  const structural: LocateStructuralHit[] = [];
  let structuralQueries = 0;
  if (graphAvailable) {
    const preliminary = mergeLocateFiles({ seeds, siblings, callers, identifiers, maxFiles: 1000, nonSelective });
    const scored = new Set(preliminary.files.map((file) => file.relativePath));
    const hop1Sources = topFilesPerDirectory(
      preliminary.files.map((file) => file.relativePath),
      HOP1_SOURCES,
      2,
    );
    const fileEdges = async (fromFile: string, hop: 1 | 2): Promise<LocateStructuralHit[]> => {
      structuralQueries += hop === 1 ? 2 : 1;
      const [importers, imports] = await Promise.all([
        app.getCallers({ ...address, relativePath: fromFile, limit: FILE_EDGE_LIMIT }).catch(() => undefined),
        hop === 1
          ? app.getCallees({ ...address, relativePath: fromFile, limit: FILE_EDGE_LIMIT }).catch(() => undefined)
          : undefined,
      ]);
      const out: LocateStructuralHit[] = [];
      if (importers && "importers" in importers) {
        const selectivity = edgeSelectivity(importers.total);
        for (const edge of importers.importers) {
          out.push({ relativePath: edge.relativePath, fromFile, hop, direction: "importedBy", selectivity });
        }
      }
      if (imports && "imports" in imports) {
        const selectivity = edgeSelectivity(imports.total);
        for (const edge of imports.imports) {
          out.push({ relativePath: edge.relativePath, fromFile, hop, direction: "imports", selectivity });
        }
      }
      return out;
    };
    const hop1 = (await Promise.all(hop1Sources.map(async (file) => fileEdges(file, 1)))).flat();
    const hop2Sources = selectHop2Sources(hop1, { scored, exclude: new Set(hop1Sources), max: HOP2_SOURCES });
    const hop2 = (await Promise.all(hop2Sources.map(async (file) => fileEdges(file, 2)))).flat();
    structural.push(...hop1, ...hop2);
  }

  const { files, truncated } = mergeLocateFiles({
    seeds,
    siblings,
    callers,
    structural,
    identifiers,
    maxFiles,
    nonSelective,
  });
  return {
    files,
    identifiers,
    coverage: {
      seeds: seeds.length,
      siblingQueries: identifiers.length,
      callerQueries: seedTargets.size + pivotTargets.size + structuralQueries,
      truncated,
    },
  };
}

export function registerLocateTool(server: McpServer, deps: { app: App; register: RegisterToolFn }): void {
  deps.register(
    server,
    "locate",
    {
      title: "Locate",
      description: LOCATE_DESCRIPTION,
      inputSchema: LocateInputShape,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (request: unknown): Promise<McpToolResult> => {
      const answer = await runLocate(deps.app, request as LocateRequest);
      return {
        content: [{ type: "text", text: JSON.stringify(answer) }],
        structuredContent: answer as unknown as Record<string, unknown>,
      };
    },
  );
}
