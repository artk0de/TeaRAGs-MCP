/**
 * GraphFacade — thin orchestrator over the per-collection
 * `GraphDbClientPool` for the MCP graph tools (`get_callers`,
 * `get_callees`, `find_cycles`, `get_architecture_report`).
 *
 * Per `.claude/rules/facade-discipline.md` the facade only validates
 * input and delegates. The body is intentionally tiny — when result
 * shaping grows past 20 lines (e.g. attaching `ChunkPreview` payloads
 * from `find_symbol`), extract a `GraphOps` class. Slice 1+2's reads
 * are direct table reads so the facade itself is enough.
 *
 * Collection routing: each MCP request carries the shared
 * `{ collection, project, path }` triad (resolution priority:
 * `collection > project > path`) — same shape every other tea-rags
 * tool accepts (`find_symbol`, `semantic_search`, etc.). The facade
 * resolves it through `resolveCollection` to a Qdrant collection name
 * and pulls the per-collection DuckDB handle from the pool. When the
 * pool can't open the file (lock held by another process, or the
 * collection has never been indexed) the facade surfaces empty results
 * — the graph tool degrades gracefully instead of crashing the whole
 * MCP request. Resolution-level errors (no addressing at all, unknown
 * project alias) are typed `InputValidationError` subclasses and bubble
 * to the MCP error middleware so the caller sees a clear schema-level
 * message rather than a silent empty list.
 */

import { splitMethodSymbol } from "../../../adapters/duckdb/client.js";
import type { CollectionGraphHandle, GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type {
  RelPath,
  SymbolChunkLocation,
  SymbolId,
  SymbolVisibilityRow,
} from "../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
import {
  resolveInheritedMemberDefiner,
  type InheritedMemberGraph,
} from "../../../domains/trajectory/codegraph/inherited-member-definer.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import { InvalidParameterError, MissingArgumentError } from "../../errors.js";
import type { GetArchitectureReportRequest, GetArchitectureReportResponse } from "../../public/dto/architecture.js";
import type {
  FindCyclesRequest,
  FindCyclesResponse,
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
} from "../../public/dto/graph.js";
import { resolveCollection } from "../collection-resolver.js";
import { ArchitectureReportOps } from "../ops/architecture-report-ops.js";
import { decorateCallees, decorateCallers } from "../ops/declared-visibility-lookup.js";
import { FileImportOps, normalizeRelativePath } from "../ops/file-import-ops.js";

export interface GraphFacadeDeps {
  pool: GraphDbClientPool;
  collectionRegistry: CollectionRegistry;
  /**
   * Resolve an addressed collection name to the ACTIVE underlying collection.
   * The codegraph DuckDB files are versioned (`code_x_v4.duckdb`) while the
   * project/registry addresses the stable Qdrant alias (`code_x`); Qdrant
   * resolves the alias transparently server-side, but the codegraph pool opens
   * a DuckDB file by literal name, so the alias must be expanded to the active
   * versioned collection the write path populated — otherwise reads open the
   * empty unversioned file and return nothing. Wired to
   * `qdrant.aliases.resolveActive` in the composition root. Optional: when
   * absent (unit tests), the name is used verbatim.
   */
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  /**
   * The module specifiers the named files declare, read from the ADDRESSED
   * collection's payload (`imports`) — Qdrant resolves an alias itself. Silent
   * coupling needs it to see an import of a file the codegraph does not walk
   * (bd tea-rags-mcp-rbnkp). Optional: absent, the report judges the codegraph
   * alone.
   */
  readImportSpecifiers?: (
    collectionName: string,
    relPaths: readonly RelPath[],
  ) => Promise<ReadonlyMap<RelPath, readonly string[]>>;
}

const DEFAULT_LIMIT = 50;

/** Navigation hides the irreducible untyped-dispatch residual (bd xlnub):
 *  a `dynamic` edge is shown only when uniquely narrowed (confidence 1.0).
 *  Every other edge kind (cone/exact/poly-base/registry) and legacy edges with no
 *  edgeKind are always shown. The SQL WHERE in getCalleeEdges encodes the identical
 *  rule — the two MUST stay in sync. */
export function isNavigationVisibleEdge(e: { edgeKind?: string; confidence?: number }): boolean {
  if (e.edgeKind !== "dynamic") return true;
  return (e.confidence ?? 1) >= 1;
}

interface GraphAddressing {
  collection?: string;
  project?: string;
  path?: string;
}

type GraphTarget = { kind: "symbol"; symbolId: SymbolId } | { kind: "file"; relativePath: RelPath };

/**
 * `get_callers` / `get_callees` take a symbol OR a file (bd tea-rags-mcp-gfvr8)
 * — exactly one. Both or neither is a request error, raised before any
 * collection is resolved.
 */
function graphTarget(req: { symbolId?: SymbolId; relativePath?: string }): GraphTarget {
  const hasSymbol = req.symbolId !== undefined && req.symbolId !== "";
  const hasFile = req.relativePath !== undefined && req.relativePath !== "";
  if (hasSymbol && hasFile) {
    throw new InvalidParameterError("relativePath", "pass either symbolId or relativePath, not both");
  }
  if (hasFile) return { kind: "file", relativePath: normalizeRelativePath(req.relativePath as string) };
  if (hasSymbol) return { kind: "symbol", symbolId: req.symbolId as SymbolId };
  throw new MissingArgumentError(["symbolId or relativePath"]);
}

/** Edges read for a symbol target, and the definer id they were read under when it was aliased. */
interface SymbolEdgeRead<E> {
  edges: E[];
  queriedSymbolId: SymbolId;
  resolvedSymbolId?: SymbolId;
}

/**
 * Read `symbolId`'s edges; when it has none, fall back to the member's definer
 * up the persisted hierarchy (bd tea-rags-mcp-63l69) — a host-class id such as
 * `Account.suspended` for a member a concern defines. An id with edges of its
 * own is answered as-is, and one with its own node is never aliased
 * (`resolveInheritedMemberDefiner` checks that). The alias walk is a fallback
 * over a read that already answered: if it fails, the direct answer stands,
 * which is exactly the pre-aliasing behaviour.
 */
async function readSymbolEdges<E>(
  graphDb: InheritedMemberGraph,
  symbolId: SymbolId,
  read: (id: SymbolId) => Promise<E[]>,
): Promise<SymbolEdgeRead<E>> {
  const direct = await read(symbolId);
  if (direct.length > 0) return { edges: direct, queriedSymbolId: symbolId };
  const definer = await resolveInheritedMemberDefiner(graphDb, symbolId).catch(() => null);
  if (definer === null) return { edges: direct, queriedSymbolId: symbolId };
  return { edges: await read(definer), queriedSymbolId: definer, resolvedSymbolId: definer };
}

/** `{ resolvedSymbolId }` when the answer was aliased, `{}` otherwise — the field is omitted, never null. */
function resolvedField(read: SymbolEdgeRead<unknown>): { resolvedSymbolId?: SymbolId } {
  return read.resolvedSymbolId === undefined ? {} : { resolvedSymbolId: read.resolvedSymbolId };
}

export class GraphFacade {
  private readonly architectureReport = new ArchitectureReportOps();
  private readonly fileImports = new FileImportOps();

  constructor(private readonly deps: GraphFacadeDeps) {}

  /**
   * Resolve the request's address triad ({ collection, project, path }) to a
   * Qdrant collection name via the registry (resolution-level errors propagate
   * as typed `InputValidationError` so the MCP middleware surfaces them), then
   * acquire a per-collection READ handle and run `fn` against it, always closing
   * the handle afterwards. Reads route through `pool.acquireReader` — mode-aware:
   * in production a daemon client that PROXIES the read through the daemon's own
   * RW connection (DuckDB's RW lock is process-exclusive, so a cross-process
   * READ_ONLY attach throws "Conflicting lock is held" while the daemon holds
   * RW); in direct/test mode an in-process READ_ONLY attach. The handle is
   * NON-cached and MUST be closed, so every read opens-queries-closes in one
   * bounded scope. Returns `fallback` only when the collection has no graph
   * database at all; an acquire failure on a database that exists (daemon
   * unreachable, lock held, unreadable or corrupt file) is rethrown.
   */
  private async withReadHandle<T>(
    addr: GraphAddressing,
    fn: (handle: CollectionGraphHandle) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const { collectionName } = resolveCollection(this.deps.collectionRegistry, addr);
    // Expand a Qdrant alias to the active versioned collection so the codegraph
    // pool opens the DuckDB file the write path actually populated (see
    // resolveActiveCollection doc). No resolver, or a failed one, falls back to
    // the addressed name resolved against no aliases, rather than aborting the read.
    const activePhysicalCollectionName = this.deps.resolveActiveCollection
      ? await this.deps
          .resolveActiveCollection(collectionName)
          .catch(() => resolvePhysicalCollection(collectionName, []))
      : resolvePhysicalCollection(collectionName, []);
    let handle: CollectionGraphHandle | undefined;
    try {
      handle = await this.deps.pool.acquireReader(activePhysicalCollectionName);
    } catch (err) {
      // An empty edge list is an assertion about the code, and callers act on
      // it. Returning one for a graph we simply could not open made a read
      // failure indistinguishable from "this symbol has no callers" — which is
      // exactly how a stale graph got mistaken for a modelling limitation.
      // A collection with no graph database was never indexed with codegraph,
      // so empty IS the honest answer there and the "codegraph optional"
      // guarantee still holds; anything else (lock held, daemon unreachable,
      // corrupt file) is a failure the caller must be told about.
      if (this.deps.pool.hasDatabase(activePhysicalCollectionName)) throw err;
      return fallback;
    }
    try {
      return await fn(handle);
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }
  }

  async getCallers(req: GetCallersRequest): Promise<GetCallersResponse> {
    const target = graphTarget(req);
    if (target.kind === "file") {
      if (req.includeAmbiguous) {
        throw new InvalidParameterError("includeAmbiguous", "applies to a symbolId target only, not to relativePath");
      }
      const limit = req.limit ?? DEFAULT_LIMIT;
      return this.withReadHandle(
        req,
        async (handle) => this.fileImports.importers(handle.graphDb, target.relativePath, limit),
        FileImportOps.emptyImporters(target.relativePath),
      );
    }
    const { symbolId } = target;
    return this.withReadHandle(
      req,
      async (handle) => {
        const read = await readSymbolEdges(handle.graphDb, symbolId, async (id) => handle.graphDb.getCallers(id));
        const resolved = resolvedField(read);
        const visible = read.edges.filter(isNavigationVisibleEdge).slice(0, req.limit ?? DEFAULT_LIMIT);
        // Declared visibility of the queried symbol and every caller, one
        // batched read (bd tea-rags-mcp-sqqkz); unknown levels leave the field out.
        const { queried, callers } = await decorateCallers(handle.graphDb, read.queriedSymbolId, visible);
        // Lazy ambiguous expansion (bd f2jsb A4) — opt-in only, and only when
        // the target has a member segment (text after the last `#` or `.`,
        // per symbolid-convention; splitMethodSymbol is the adapter's own
        // parser, so the lookup key matches what cg_ambiguous_fanout.member
        // was persisted under). Bare symbols skip the lookup; the DEFAULT
        // (flag absent) response stays byte-identical to the pre-flag shape.
        const member = req.includeAmbiguous ? splitMethodSymbol(symbolId)?.member : undefined;
        if (member === undefined) return { ...resolved, ...queried, callers };
        const sites = await handle.graphDb.getAmbiguousCallersByMember(member);
        return {
          ...resolved,
          ...queried,
          callers,
          ambiguousCallers: sites.map((s) => ({
            sourceSymbolId: s.sourceSymbolId,
            sourceRelPath: s.sourceRelPath,
            callExpression: s.callExpression,
            candidateCount: s.candidateCount,
          })),
        };
      },
      { callers: [] },
    );
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    const target = graphTarget(req);
    if (target.kind === "file") {
      const limit = req.limit ?? DEFAULT_LIMIT;
      return this.withReadHandle(
        req,
        async (handle) => this.fileImports.imports(handle.graphDb, target.relativePath, limit),
        FileImportOps.emptyImports(target.relativePath),
      );
    }
    const { symbolId } = target;
    return this.withReadHandle(
      req,
      async (handle) => {
        const read = await readSymbolEdges(handle.graphDb, symbolId, async (id) => handle.graphDb.getCallees(id));
        const visible = read.edges.filter(isNavigationVisibleEdge).slice(0, req.limit ?? DEFAULT_LIMIT);
        return { ...resolvedField(read), callees: await decorateCallees(handle.graphDb, visible) };
      },
      { callees: [] },
    );
  }

  async resolveSymbolChunk(addr: GraphAddressing, symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.withReadHandle(addr, async (handle) => handle.graphDb.findSymbolChunk(symbolId), null);
  }

  /**
   * Raw declared-visibility rows for the find_symbol outline (bd
   * tea-rags-mcp-sqqkz). Keeps `withReadHandle`'s contract — throws when a graph
   * exists but cannot be read, `[]` when there is none — and leaves degrading to
   * the caller, which owns whether a missing decoration is acceptable.
   */
  async getSymbolVisibilities(addr: GraphAddressing, symbolIds: readonly SymbolId[]): Promise<SymbolVisibilityRow[]> {
    return this.withReadHandle(addr, async (handle) => handle.graphDb.getSymbolVisibilities(symbolIds), []);
  }

  async getArchitectureReport(req: GetArchitectureReportRequest): Promise<GetArchitectureReportResponse> {
    const { readImportSpecifiers } = this.deps;
    const importSpecifiers = readImportSpecifiers
      ? async (relPaths: readonly RelPath[]) =>
          readImportSpecifiers(resolveCollection(this.deps.collectionRegistry, req).collectionName, relPaths)
      : undefined;
    return this.withReadHandle(
      req,
      async (handle) => this.architectureReport.build(handle.graphDb, req, importSpecifiers),
      ArchitectureReportOps.empty(req),
    );
  }

  async findCycles(req: FindCyclesRequest): Promise<FindCyclesResponse> {
    return this.withReadHandle(
      req,
      async (handle) => {
        const entries = await handle.graphDb.findCycles(req.scope, req.pathPattern);
        return {
          cycles: entries.map((e) => ({
            cycleId: e.cycleId,
            scope: e.scope,
            members: e.members,
            ...(e.memberLocations ? { memberLocations: e.memberLocations } : {}),
            length: e.members.length,
          })),
        };
      },
      { cycles: [] },
    );
  }
}
