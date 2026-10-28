/**
 * The rustc-driver lower-bound notice on Rust graph answers (bd
 * tea-rags-mcp-nknkg.1). The agent digest no longer carries the driver line, so
 * every graph answer whose Rust edges a missing driver may have left out says so
 * itself: a non-empty `get_callers` / `get_callees` list on a Rust symbol, an
 * empty `trace_path` touching a Rust endpoint, an empty `find_cycles` whose
 * scope can select Rust files. The empty symbol answer carries the same line in
 * `empty.message` (`readSymbolEdgesExplained`).
 *
 * A driver that indexed, a project with no Rust (no status record), or a target
 * outside Rust adds nothing — those answers stay byte-identical. The driver
 * status is read first: it is one row, and null for a project without Rust, so
 * the symbol lookup behind it only runs where the answer can change.
 */

import { formatRustcDriverLine, type RustcDriverStatus } from "../../../contracts/rustc-driver-status.js";
import type { GraphDbClient, SymbolId } from "../../../contracts/types/codegraph.js";
import { detectLanguage } from "../../../domains/ingest/pipeline/chunker/language-config/index.js";
import { compilePathPatternMatcher } from "../../../primitives/paths/index.js";
import type { GraphNoticesField } from "../../public/dto/graph.js";

export type RustcDriverStatusGraph = Partial<Pick<GraphDbClient, "getRustcDriverStatus">>;

/** The one wording of the lower-bound line: the driver line, why the edges are partial, what to do instead. */
export function rustcDriverLowerBoundLine(status: RustcDriverStatus, next: string): string {
  return `${formatRustcDriverLine(status)} — Rust edges static-only, so this is a lower bound; ${next}`;
}

/** The persisted driver status when it did NOT index; null when it indexed, nothing was recorded, or the read failed. */
export async function rustcDriverLowerBoundStatus(graph: RustcDriverStatusGraph): Promise<RustcDriverStatus | null> {
  try {
    const record = graph.getRustcDriverStatus ? await graph.getRustcDriverStatus() : null;
    return record && record.status.outcome !== "indexed" ? record.status : null;
  } catch {
    return null;
  }
}

/** A non-empty caller / callee answer on a Rust symbol: more edges may exist than the list shows. */
export async function rustSymbolEdgeNotices(
  graph: RustcDriverStatusGraph & Pick<GraphDbClient, "getSymbolVisibilities">,
  symbolId: SymbolId,
  edgeNoun: "callers" | "callees",
): Promise<GraphNoticesField> {
  const status = await rustcDriverLowerBoundStatus(graph);
  if (status === null) return {};
  const definitions = await graph.getSymbolVisibilities([symbolId]).catch(() => []);
  if (!definitions.some((d) => detectLanguage(d.relPath) === "rust")) return {};
  return {
    notices: [rustcDriverLowerBoundLine(status, `more ${edgeNoun} may exist; confirm with a literal text search.`)],
  };
}

/** An empty trace with a Rust endpoint: no path found is not proof the endpoints are unconnected. */
export async function rustTracePathNotices(
  graph: RustcDriverStatusGraph,
  endpointRelPaths: readonly string[],
): Promise<GraphNoticesField> {
  if (!endpointRelPaths.some((relPath) => detectLanguage(relPath) === "rust")) return {};
  const status = await rustcDriverLowerBoundStatus(graph);
  if (status === null) return {};
  return {
    notices: [rustcDriverLowerBoundLine(status, "a Rust path may exist through calls the static pass missed.")],
  };
}

/** An empty cycle list whose scope can select Rust files: not proof the Rust graph is acyclic. */
export async function rustCycleScopeNotices(
  graph: RustcDriverStatusGraph,
  pathPattern: string | undefined,
): Promise<GraphNoticesField> {
  if (!pathPatternMaySelectRust(pathPattern)) return {};
  const status = await rustcDriverLowerBoundStatus(graph);
  if (status === null) return {};
  return { notices: [rustcDriverLowerBoundLine(status, "an empty cycle list does not prove the Rust graph acyclic.")] };
}

/**
 * Whether a `pathPattern` can select a `.rs` file, judged on its last segment
 * (a directory glob like `crates/**` can, `src/**\/*.ts` cannot). No pattern or
 * a negated one constrains nothing Rust-specific → true.
 */
export function pathPatternMaySelectRust(pathPattern: string | undefined): boolean {
  if (!pathPattern || pathPattern.startsWith("!")) return true;
  const lastSegment = pathPattern.slice(pathPattern.lastIndexOf("/") + 1);
  if (lastSegment.endsWith(".rs")) return true;
  const matcher = compilePathPatternMatcher(lastSegment);
  return matcher === undefined || matcher("lib.rs");
}
