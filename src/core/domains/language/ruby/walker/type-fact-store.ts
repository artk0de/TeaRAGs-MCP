import type { LocalBinding } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import type { RubyTypeFact } from "./type-sources/types.js";

/** Default source precedence: first = strongest. */
const DEFAULT_SOURCE_ORDER: readonly string[] = ["sorbet", "rbs", "yard", "ast"];

/** Flatten a RubyTypeRef to the bare class name today's LocalBinding.type holds (Incr 0 parity). */
function refToName(ref: RubyTypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return refToName(ref.element); // element wins (today's Array<Post> -> Post)
  return undefined; // union: deferred to Incr 1 (no single name)
}

/**
 * Best-effort string name for union: the first member's refToName.
 * Used to populate LocalBinding.type when typeRef carries the full union
 * (INFRA-A: union params were previously dropped; now emitted with a
 * best-effort string + the full typeRef for the engine).
 */
function firstMemberName(ref: RubyTypeRef): string | undefined {
  if (ref.form !== "union") return undefined;
  const first = ref.members[0];
  return first !== undefined ? refToName(first) : undefined;
}

/**
 * Resolve source precedence rank: lower index = higher precedence.
 * Undefined or unknown source → Infinity (lowest precedence).
 */
function sourceRank(source: string | undefined, order: readonly string[]): number {
  if (source === undefined) return Infinity;
  const i = order.indexOf(source);
  return i === -1 ? Infinity : i;
}

/**
 * Coordinate key for precedence deduplication of same-position facts.
 * Only collides when kind + scope + methodName + name + line are all identical
 * (the same binding site from two different sources). Different positions
 * (different `line`) are different coordinates and are both retained.
 */
function coordinateKey(f: RubyTypeFact): string {
  return `${f.kind}|${f.symbolScope.join(",")}|${f.methodName ?? ""}|${f.name ?? ""}|${f.line ?? ""}`;
}

/**
 * Coordinate key for return-type facts keyed by scope + methodName.
 * Line is intentionally excluded — sidecar/name-keyed return facts lack a line.
 */
function returnCoordKey(scope: string[], methodName: string): string {
  return `${scope.join(",")}|${methodName}`;
}

/**
 * Coordinate key for ivar facts keyed by scope + ivar name.
 */
function ivarCoordKey(scope: string[], ivar: string): string {
  return `${scope.join(",")}|${ivar}`;
}

export class RubyTypeFactStore {
  private readonly resolvedFacts: readonly RubyTypeFact[];

  private constructor(resolvedFacts: readonly RubyTypeFact[]) {
    this.resolvedFacts = resolvedFacts;
  }

  static fromFacts(facts: RubyTypeFact[], sourceOrder: readonly string[] = DEFAULT_SOURCE_ORDER): RubyTypeFactStore {
    // Group by coordinate key; keep the fact with the highest-precedence source.
    const byCoord = new Map<string, RubyTypeFact>();
    for (const f of facts) {
      const key = coordinateKey(f);
      const existing = byCoord.get(key);
      if (!existing || sourceRank(f.source, sourceOrder) < sourceRank(existing.source, sourceOrder)) {
        byCoord.set(key, f);
      }
    }
    return new RubyTypeFactStore(Array.from(byCoord.values()));
  }

  localBindingsForChunk(startLine: number, endLine: number): Record<string, LocalBinding[]> {
    const out: Record<string, LocalBinding[]> = {};
    for (const f of this.resolvedFacts) {
      if (f.kind !== "param" && f.kind !== "local") continue;
      if (f.line === undefined || f.line < startLine || f.line > endLine) {
        continue;
      }
      const { name } = f;
      // For union/container: typeRef carries the full ref; type = best-effort string.
      // For class/instance: typeRef not needed (string suffices, parity preserved).
      const isUnionOrContainer = f.type.form === "union" || f.type.form === "container";
      const type = isUnionOrContainer ? (refToName(f.type) ?? firstMemberName(f.type) ?? "") : refToName(f.type);
      if (!name || type === undefined) continue;
      const binding: LocalBinding = { line: f.line, type };
      if (f.type.form === "class") binding.valueKind = "class";
      if (isUnionOrContainer) binding.typeRef = f.type;
      (out[name] ??= []).push(binding);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.line - b.line);
    return out;
  }

  returnTypeByMethod(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const type = refToName(f.type);
      if (type !== undefined) out[f.methodName] = type;
    }
    return out;
  }

  /**
   * Full RubyTypeRef for a method's return type (union/container preserved).
   * Scope is matched as a joined string; method name is exact.
   */
  structuredReturnType(scope: string[], method: string): RubyTypeRef | undefined {
    const targetCoord = returnCoordKey(scope, method);
    // Among return facts for this coord, pick by source precedence.
    // (Position-keyed facts are already deduplicated in resolvedFacts;
    // return facts are name-keyed so we do a secondary pass here.)
    let best: RubyTypeFact | undefined;
    let bestRank = Infinity;
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      if (returnCoordKey(f.symbolScope, f.methodName) !== targetCoord) continue;
      const rank = sourceRank(f.source, DEFAULT_SOURCE_ORDER);
      if (!best || rank < bestRank) {
        best = f;
        bestRank = rank;
      }
    }
    return best?.type;
  }

  /**
   * Full RubyTypeRef for an instance variable (union/container preserved).
   * Scope is matched as a joined string; ivar name is exact.
   */
  ivarType(scope: string[], ivar: string): RubyTypeRef | undefined {
    const targetCoord = ivarCoordKey(scope, ivar);
    let best: RubyTypeFact | undefined;
    let bestRank = Infinity;
    for (const f of this.resolvedFacts) {
      if (f.kind !== "ivar" || !f.name) continue;
      if (ivarCoordKey(f.symbolScope, f.name) !== targetCoord) continue;
      const rank = sourceRank(f.source, DEFAULT_SOURCE_ORDER);
      if (!best || rank < bestRank) {
        best = f;
        bestRank = rank;
      }
    }
    return best?.type;
  }

  /**
   * Full `"<fqClass>#<method>" → RubyTypeRef` map over every return fact, in the
   * engine's `structuredReturnTypes` key convention (the codegraph
   * `fqMethodKey`): fq class = `symbolScope.join("::")`, member joined with `#`.
   * Return facts carry no static flag, so the instance form `#` is always used
   * — matching the engine's `recv.name#member` lookup and {@link returnTypeByMethod}.
   * Union / container refs are preserved verbatim. Source precedence matches the
   * {@link structuredReturnType} point lookup: the highest-precedence source
   * (lowest `sourceRank`) wins per key.
   */
  structuredReturnTypesMap(): Record<string, RubyTypeRef> {
    const out: Record<string, RubyTypeRef> = {};
    const bestRank = new Map<string, number>();
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const key = `${f.symbolScope.join("::")}#${f.methodName}`;
      const rank = sourceRank(f.source, DEFAULT_SOURCE_ORDER);
      const prev = bestRank.get(key);
      if (prev === undefined || rank < prev) {
        out[key] = f.type;
        bestRank.set(key, rank);
      }
    }
    return out;
  }

  /**
   * Full `fqClass → "@ivar" → typeName` map over every ivar fact, in the engine's
   * `ivarTypes` key convention: fq class = `symbolScope.join("::")`, ivar name
   * retains its leading `@`. The value is the bare type NAME reduced via the same
   * {@link refToName} the point lookups use (container → element name; union →
   * undefined and skipped, since the string-valued map cannot carry a union).
   * Source precedence matches the {@link ivarType} point lookup: the
   * highest-precedence string-reducible source wins per `(fqClass, @ivar)`.
   */
  ivarTypesMap(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    const bestRank = new Map<string, number>();
    for (const f of this.resolvedFacts) {
      if (f.kind !== "ivar" || !f.name) continue;
      const type = refToName(f.type);
      if (type === undefined) continue;
      const fqClass = f.symbolScope.join("::");
      const coord = ivarCoordKey(f.symbolScope, f.name);
      const rank = sourceRank(f.source, DEFAULT_SOURCE_ORDER);
      const prev = bestRank.get(coord);
      if (prev === undefined || rank < prev) {
        (out[fqClass] ??= {})[f.name] = type;
        bestRank.set(coord, rank);
      }
    }
    return out;
  }
}
