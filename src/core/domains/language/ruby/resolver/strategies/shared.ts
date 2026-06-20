/**
 * Shared inputs and helpers for the Ruby symbol-resolution strategies.
 *
 * `ResolverConfig` is the per-resolver config every strategy receives by
 * constructor injection (the old `RubyCallResolver(mode)` single field).
 *
 * `resolveConstant` and `collectKnownPaths` are the helpers more than one
 * strategy shares — constant resolution drives the local-type, Zeitwerk-constant
 * and super passes, and the known-paths set feeds both Zeitwerk convention
 * lookup and the explicit-require path resolution. Factored here so they live
 * once.
 */

import type { AmbiguousResolveMode, CallContext } from "../../../../../contracts/types/codegraph.js";
import { ZEITWERK_PREFIX } from "../../walker/walker.js";
import { resolveZeitwerkConstant } from "../zeitwerk.js";

export interface ResolverConfig {
  mode: AmbiguousResolveMode;
  /**
   * Max cone size before CHA devirtualization collapses to a single
   * `poly-base` edge (bd tea-rags-mcp-2jet). `|cone| ≤ coneMax` persists N
   * `cone` edges (confidence `1/N`); `> coneMax` persists one base-decl edge
   * expanded at query time. Defaults to `CONE_MAX_DEFAULT` (8) when omitted.
   */
  coneMax?: number;
  /**
   * Confidence weight applied to a dynamic-receiver short-name fan-out edge
   * (bd tea-rags-mcp-wbj3) BEFORE the per-candidate `1/N` split. A dynamic
   * receiver (`arr.map`, `obj[k].call`) carries no static type, so its
   * short-name match is materially weaker than a CHA `cone` candidate (which at
   * least has a static base type) — this discount marks that. Defaults to
   * `DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT` (0.5) when omitted; env
   * `CODEGRAPH_RB_DYNAMIC_CONFIDENCE` overrides at composition.
   */
  dynamicReceiverConfidence?: number;
}

/** Default cone-size threshold; env `CODEGRAPH_RB_CONE_MAX` overrides at composition. */
export const CONE_MAX_DEFAULT = 8;

/**
 * Default confidence discount for a dynamic-receiver short-name fan-out edge
 * (bd tea-rags-mcp-wbj3). A name-only match with no type evidence — discounted
 * to half so ranking treats it as a weak, speculative edge that still beats
 * dropping the call entirely. The per-edge confidence is this value divided by
 * the candidate count `N`. Env `CODEGRAPH_RB_DYNAMIC_CONFIDENCE` overrides.
 */
export const DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT = 0.5;

/**
 * Whether a symbol-table relPath is a Ruby file the resolver may attribute a
 * call edge to. The symbol table is language-agnostic (no `language` field on
 * `SymbolDefinition`), so a Ruby resolver gates on the file extension to avoid
 * attributing an edge to a vendored JS / Java / etc. definition (bug pl7k:
 * `agents.map(&:id)` → `d3.js#map`). Shared by the bare-call fallback and the
 * dynamic-receiver fan-out (both do cross-language short-name lookups).
 */
export function isRubyPath(relPath: string): boolean {
  return relPath.endsWith(".rb") || relPath.endsWith(".rake") || relPath.endsWith(".gemspec");
}

/** Last `::`-segment of a (possibly qualified) Ruby constant — `A::B::C` → `C`. */
export function lastConstantSegment(qualified: string): string {
  const parts = qualified.split("::");
  return parts[parts.length - 1] ?? qualified;
}

/**
 * Resolve a (possibly qualified) Ruby constant to the file that DECLARES it.
 *
 *   - Pass 1: direct qualified-name lookup in the symbol table — every file's
 *     fileScope[] carries its declared constants via the walker, so this works
 *     without conventions.
 *   - Pass 2: enclosing-scope walk (Ruby's `Module.nesting`). When a bare
 *     constant is referenced from inside a (possibly nested) class/module, Ruby
 *     walks the enclosing scopes outward looking for `<scope>::<receiver>`
 *     before falling back to the top level (bug ohz5). Only applies when the
 *     receiver itself is unqualified.
 *   - Pass 3: Zeitwerk convention against known file paths.
 *
 * Shared by the local-type, Zeitwerk-constant and super passes.
 */
export function resolveConstant(qualified: string, ctx: CallContext): string | null {
  const direct = ctx.symbolTable.lookup(qualified);
  if (direct.length === 1) return direct[0].relPath;
  if (!qualified.includes("::") && ctx.callerScope.length > 0) {
    for (let i = ctx.callerScope.length; i > 0; i--) {
      const prefix = ctx.callerScope.slice(0, i).join("::");
      const candidate = `${prefix}::${qualified}`;
      const matches = ctx.symbolTable.lookup(candidate);
      if (matches.length === 1) return matches[0].relPath;
    }
  }
  return resolveZeitwerkConstant(qualified, collectKnownPaths(ctx));
}

/**
 * The set of distinct file paths the resolver can range over for basename /
 * Zeitwerk convention matching: every non-Zeitwerk import's text plus the
 * caller file (so basename match has at least the local set). Shared by
 * `resolveConstant` (Zeitwerk convention) and the explicit-require path
 * resolution.
 */
export function collectKnownPaths(ctx: CallContext): Iterable<string> {
  const paths = new Set<string>();
  for (const imp of ctx.imports) {
    if (!imp.importText.startsWith(ZEITWERK_PREFIX)) paths.add(imp.importText);
  }
  paths.add(ctx.callerFile);
  return paths;
}
