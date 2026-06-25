import type { CallContext, CallRef, DispatchEdge } from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { typeOfReceiver } from "../type-propagation.js";
import {
  CONE_MAX_DEFAULT,
  isRubyPath,
  resolveTypeInstanceMethod,
  resolveTypeStaticMethod,
  type ResolverConfig,
} from "./shared.js";

/**
 * Union-receiver cone fan-out (bd tea-rags-mcp Task 1.7). A call `x.m` whose
 * receiver carries a YARD union type `[A, B]` (stored as `typeRef.form ===
 * "union"`) fans out to all in-project members of the union that define `m` as
 * discounted `cone` edges (confidence = 1/N).
 *
 * Placed BEFORE `RubyConeDispatchResolver` in the component list: union
 * evidence is stronger than CHA subtype inference — the YARD annotation names
 * the exact possible types, whereas CHA only knows descendants. When this
 * component returns `[]` (no union receiver, or no in-project targets) the cone
 * proceeds as usual.
 *
 * Behaviour:
 *   - Non-union receiver (`typeRef` absent or not `"union"`) → `[]`.
 *   - union members are processed by valueKind: `"class"` → static method lookup,
 *     `"instance"` → instance method lookup. Non-class/instance forms (container,
 *     nested union) are skipped — they are unresolvable without deeper threading.
 *   - Targets filtered to ruby files + method-level pins only (`targetSymbolId ≠ null`).
 *   - Deduplication by `targetSymbolId` — repeated union members emit one edge.
 *   - `|targets| > coneMax` → `[]`; a union has no single base type so there is no
 *     `poly-base` fallback. The dynamic resolver handles genuinely unresolvable
 *     receivers downstream.
 */
export class RubyUnionDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly cfg: ResolverConfig) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    if (!call.receiver) return [];

    const t = typeOfReceiver(call.receiver, call.startLine, ctx);
    if (t?.form !== "union") return [];

    // Collect in-project method targets across union members.
    const seen = new Set<string>();
    const targets: { targetRelPath: string; targetSymbolId: string }[] = [];

    for (const member of t.members) {
      if (member.form !== "class" && member.form !== "instance") continue;

      const resolved =
        member.form === "class"
          ? resolveTypeStaticMethod(member.name, call.member, ctx, this.cfg.mode)
          : resolveTypeInstanceMethod(member.name, call.member, ctx, this.cfg.mode);

      if (!resolved) continue;
      if (!isRubyPath(resolved.targetRelPath)) continue;
      if (resolved.targetSymbolId === null) continue; // file-only edge — not method-level

      if (seen.has(resolved.targetSymbolId)) continue; // deduplicate
      seen.add(resolved.targetSymbolId);

      targets.push({ targetRelPath: resolved.targetRelPath, targetSymbolId: resolved.targetSymbolId });
    }

    const n = targets.length;
    if (n === 0) return [];

    // No poly-base fallback for unions — there is no single base type.
    if (n > (this.cfg.coneMax ?? CONE_MAX_DEFAULT)) return [];

    const confidence = 1 / n;
    return targets.map((target) => ({
      sourceSymbolId: null,
      targetRelPath: target.targetRelPath,
      targetSymbolId: target.targetSymbolId,
      edgeKind: "cone",
      confidence,
    }));
  }
}
