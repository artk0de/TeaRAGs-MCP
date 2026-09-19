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

import type { CallContext, SymbolDefinition, SymbolResolutionTarget } from "../../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../../contracts/types/language.js";
import { goDeclaredFieldType, goEmbeddedFieldTypes, goStructClassKey } from "../struct-fields.js";
import { goPackageDirOf, type GoProjectType } from "./go-project-type.js";
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
 * The Go declarations of `type`: every one of its name, or — for a type placed
 * in its package (`go-project-type.ts`) — only that package's.
 */
function goTypeDeclarations(type: GoProjectType, symbolId: string, ctx: CallContext): SymbolDefinition[] {
  const declarations = lookupGoSymbols(ctx, symbolId);
  const { packageDir } = type;
  return packageDir === undefined
    ? declarations
    : declarations.filter((def) => goPackageDirOf(def.relPath) === packageDir);
}

/**
 * The field map of `type` when it is TRANSPARENT — exactly one Go declaration
 * (in its package, when placed), and that declaration a struct the walker
 * described — else `undefined`. A type alias is never one: the walker
 * describes only `type T struct {…}`.
 */
export function goTransparentStructFields(
  type: GoProjectType,
  ctx: CallContext,
): Readonly<Record<string, string>> | undefined {
  const declarations = goTypeDeclarations(type, type.typeName, ctx);
  if (declarations.length !== 1) return undefined;
  return ctx.classFieldTypesByClassKey?.[goStructClassKey(declarations[0].relPath, type.typeName)];
}

/**
 * Select `member` on a value of Go type `type` — the shallowest unique method
 * or field, `undefined` when the selection is ambiguous, blocked by an opaque
 * type, or finds nothing.
 *
 * A method hit is only as good as the type NAME it was composed from: symbol
 * ids carry no package, so when two Go declarations share that name (`app.Base`
 * embedded here, `other.Base` elsewhere) `Base#Reset` may be the other
 * package's method. Such a hit makes its level AMBIGUOUS — no edge — rather
 * than a winner (bd tea-rags-mcp-e6xx). A type PLACED in its package (G2-4)
 * is the exception at depth 0: its methods and struct are read from that
 * package alone, so a namesake elsewhere is neither a hit nor an ambiguity.
 * Embedded types stay package-blind behind the guard.
 */
export function selectGoMember(
  type: GoProjectType,
  member: string,
  ctx: CallContext,
  composer: SymbolIdComposer,
): GoSelectedMember | undefined {
  const visited = new Set<string>([type.typeName]);
  let level: GoProjectType[] = [type];
  for (let depth = 0; depth <= GO_EMBEDDING_MAX_DEPTH && level.length > 0; depth++) {
    const hits: GoSelectedMember[] = [];
    const next: GoProjectType[] = [];
    let opaque = false;
    let namesakeMethodHit = false;
    for (const levelType of level) {
      const methodId = composer.compose(levelType.typeName, member, { methodKind: "instance" });
      const methodDefs = goTypeDeclarations(levelType, methodId, ctx);
      for (const def of methodDefs) {
        hits.push({ kind: "method", target: { targetRelPath: def.relPath, targetSymbolId: def.symbolId } });
      }
      if (methodDefs.length > 0 && goTypeDeclarations(levelType, levelType.typeName, ctx).length > 1) {
        namesakeMethodHit = true;
      }
      const fields = goTransparentStructFields(levelType, ctx);
      if (fields === undefined) {
        opaque = true;
        continue;
      }
      const fieldType = goDeclaredFieldType(fields, member);
      if (fieldType !== undefined) hits.push({ kind: "field", type: fieldType });
      for (const embedded of goEmbeddedFieldTypes(fields)) {
        if (visited.has(embedded)) continue;
        visited.add(embedded);
        next.push({ typeName: embedded });
      }
    }
    if (namesakeMethodHit) return undefined;
    if (hits.length === 1) return hits[0];
    if (hits.length > 1 || opaque) return undefined;
    level = next;
  }
  return undefined;
}
