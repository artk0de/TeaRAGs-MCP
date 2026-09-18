/**
 * Go selector resolution through struct embedding (bd tea-rags-mcp-e6xx).
 *
 * `x.f` on a value of struct type `T` selects the `f` at the SHALLOWEST depth
 * where one exists — depth 0 is `T`'s own methods and fields, depth n+1 the
 * members of the types embedded at depth n — and is illegal when that depth
 * holds more than one (Go spec, "Selectors"). That is what makes gin's
 * `engine.GET(...)` a call of `RouterGroup#GET`: `Engine` declares no `GET`, and
 * the `RouterGroup` it embeds does.
 *
 * The walk reads the struct facts the walker's struct-field facet publishes
 * (`../struct-fields.ts`) and is deliberately one-sided about what it cannot
 * see. A type is TRANSPARENT only when exactly one Go declaration of it carries
 * a struct field map; anything else — an interface, an external `pkg.Type`, a
 * namesake declared in two packages — is OPAQUE, because it may declare the
 * member itself or embed something that does. A level that yields no member but
 * holds an opaque type therefore ends the walk with no answer rather than
 * descending past it: selecting a deeper definer the compiler would never pick
 * is a fabricated edge, while stopping is a silence a later pass can still fill.
 *
 * Every lookup goes through `lookupGoSymbols` — the table is one polyglot
 * index, and a Python `Engine` must not answer for a Go one.
 */

import type { CallContext, SymbolResolutionTarget } from "../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../../contracts/types/language.js";
import { goDeclaredFieldType, goEmbeddedFieldTypes, goStructClassKey } from "../struct-fields.js";
import { lookupGoSymbols } from "./go-symbol-lookup.js";

/** What `x.member` selects on a Go struct type. */
export type GoSelectedMember =
  | { kind: "method"; target: SymbolResolutionTarget }
  /** `type` is the field's recorded type — `""` when it names no single nominal type. */
  | { kind: "field"; type: string };

/**
 * Embedding depth the walk gives up at. Real embedding chains are one or two
 * levels deep (gin's deepest is 1); the cap only bounds a pathological corpus.
 */
const GO_EMBEDDING_MAX_DEPTH = 8;

/**
 * The field map of `typeName` when it is TRANSPARENT — exactly one Go
 * declaration, and that declaration a struct the walker described — else
 * `undefined`.
 */
export function goTransparentStructFields(
  typeName: string,
  ctx: CallContext,
): Readonly<Record<string, string>> | undefined {
  const declarations = lookupGoSymbols(ctx, typeName);
  if (declarations.length !== 1) return undefined;
  return ctx.classFieldTypesByClassKey?.[goStructClassKey(declarations[0].relPath, typeName)];
}

/**
 * Select `member` on a value of Go type `typeName` — the shallowest unique
 * method or field, `undefined` when the selection is ambiguous, blocked by an
 * opaque type, or finds nothing.
 */
export function selectGoMember(
  typeName: string,
  member: string,
  ctx: CallContext,
  composer: SymbolIdComposer,
): GoSelectedMember | undefined {
  const visited = new Set<string>([typeName]);
  let level = [typeName];
  for (let depth = 0; depth <= GO_EMBEDDING_MAX_DEPTH && level.length > 0; depth++) {
    const hits: GoSelectedMember[] = [];
    const next: string[] = [];
    let opaque = false;
    for (const type of level) {
      const methodId = composer.compose(type, member, { methodKind: "instance" });
      for (const def of lookupGoSymbols(ctx, methodId)) {
        hits.push({ kind: "method", target: { targetRelPath: def.relPath, targetSymbolId: def.symbolId } });
      }
      const fields = goTransparentStructFields(type, ctx);
      if (fields === undefined) {
        opaque = true;
        continue;
      }
      const fieldType = goDeclaredFieldType(fields, member);
      if (fieldType !== undefined) hits.push({ kind: "field", type: fieldType });
      for (const embedded of goEmbeddedFieldTypes(fields)) {
        if (visited.has(embedded)) continue;
        visited.add(embedded);
        next.push(embedded);
      }
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1 || opaque) return undefined;
    level = next;
  }
  return undefined;
}
