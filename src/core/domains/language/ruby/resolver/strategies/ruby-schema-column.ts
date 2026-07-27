import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { collectResolvedAncestorChain, lastConstantSegment } from "./shared.js";

/**
 * Receiverless read of the enclosing model's OWN persisted column
 * (bd tea-rags-mcp-8l5fo): `def label; name; end` inside `class Firm`, where
 * `name` is a `db/schema.rb` column and therefore has no `def` anywhere.
 *
 * Runs LAST, after `bareCall`. That ordering IS the precedence rule: a real
 * definition reachable from the caller's MRO — its own, an ancestor's, a
 * concern's — is found by `bareCall` first and wins, exactly as Ruby resolves it
 * (an explicit `def name` shadows the ActiveRecord-generated attribute method).
 * Only when nothing declared answers does a synthesized column get to.
 *
 * The candidate set is SCHEMA COLUMNS ONLY, matched against the caller's own MRO
 * chain — never the global short-name pool. Two consequences, both deliberate:
 * a column call from an unrelated class stays unresolved (no fan-out over the
 * 300 models that carry a `name` column), and this pass emits METHOD-LEVEL edges
 * only — it never falls back to a file-only edge, which would fabricate an edge
 * into the model file for any unresolved bare call inside it.
 */
export class RubySchemaColumnSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "schemaColumn";

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return CONTINUE;
    const columns = ctx.symbolTable
      .lookupByShortName(call.member, { includeSchemaColumns: true })
      .filter((def) => def.isSchemaColumn === true);
    if (columns.length === 0) return CONTINUE;

    // Anchor on the enclosing class the same way `bareCall` does: a class-body
    // chunk's `callerScope` omits its own name, so `callerSymbolId` (which has no
    // `#`/`.` for a class/module chunk) is the only thing that pins it.
    const classBodyEnclosing =
      ctx.callerSymbolId !== undefined && !ctx.callerSymbolId.includes("#") && !ctx.callerSymbolId.includes(".")
        ? ctx.callerSymbolId
        : null;
    const enclosing = classBodyEnclosing ?? (ctx.callerScope.length > 0 ? ctx.callerScope.join("::") : null);
    if (enclosing === null) return CONTINUE;

    for (const klass of [enclosing, ...collectResolvedAncestorChain(enclosing, ctx)]) {
      // Both stored scope forms, mirroring `bareCall`'s two tiers: the compact FQ
      // (`["Admin::Firm"]`) and the nested form (`["Admin","Firm"]`) both join to
      // the class FQ, while a namespace-less walker record joins to its last
      // segment.
      const short = lastConstantSegment(klass);
      const hits = columns.filter((def) => {
        const joined = def.scope.join("::");
        return joined === klass || joined === short;
      });
      const first = hits[0];
      // A single class cannot declare one column twice, so >1 here means two
      // classes collapsed onto the same scope form — ambiguous, so nothing.
      if (hits.length === 1 && first !== undefined) {
        return resolved({ targetRelPath: first.relPath, targetSymbolId: first.symbolId });
      }
      if (hits.length > 1) return CONTINUE;
    }
    return CONTINUE;
  }
}
