/**
 * `TypeFactStore` — precedence-resolved type facts for one file, indexed for
 * the four channels a type-facts extraction pass publishes (E1 seam 2,
 * relocated from `ruby/walker/type-fact-store.ts`).
 *
 * The store resolves COLLISIONS, not policy. Which source outranks which is the
 * language's data, injected as `sourceOrder` at `fromFacts` and held on the
 * instance — Ruby says yard › associations › draper › body-last-expr › ast,
 * Python will say annotations › stubs › docstring › orm › body › ast, and the
 * store applies whichever it was handed to EVERY ranked read. (The Ruby
 * original took the order for its coordinate dedupe but re-read a module-level
 * default in `structuredReturnType` / `ivarType` and their map forms; that
 * split is closed here. No caller ever exercised it — production only ever
 * passed the default.)
 *
 * A source name absent from the order ranks `Infinity`, which is "lowest", not
 * "invalid": an unregistered source still contributes a fact when nothing else
 * claims that coordinate.
 */
import type { LocalBinding } from "../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../contracts/types/language.js";
import type { TypeFact } from "./type-facts.js";

/** Flatten a TypeRef to the bare class name today's LocalBinding.type holds. */
function refToName(ref: TypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return refToName(ref.element); // element wins (today's Array<Post> -> Post)
  // union / nil: no single name. A nilable union deliberately does NOT collapse
  // to its one nominal arm here (bd tea-rags-mcp-27q0z) — this feeds the FLAT,
  // corpus-wide `functionReturnTypes` / `ivarTypes` channels, where a fact keyed
  // by bare name already speaks for every same-named method in the project
  // (bd h4hxh). The nilable form stays in the owner-qualified structured channel
  // that can afford it.
  return undefined;
}

/**
 * Best-effort string name for union: the first member's refToName.
 * Used to populate LocalBinding.type when typeRef carries the full union
 * (INFRA-A: union params were previously dropped; now emitted with a
 * best-effort string + the full typeRef for the engine).
 */
function firstMemberName(ref: TypeRef): string | undefined {
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
function coordinateKey(f: TypeFact): string {
  return `${f.kind}|${f.symbolScope.join(",")}|${f.methodName ?? ""}|${f.name ?? ""}|${f.line ?? ""}`;
}

/**
 * Coordinate key for return-type facts keyed by scope + methodName.
 * Line is intentionally excluded — sidecar/name-keyed return facts lack a line.
 */
function returnCoordKey(scope: string[], methodName: string): string {
  return `${scope.join(",")}|${methodName}`;
}

/** Coordinate key for ivar facts keyed by scope + ivar name. */
function ivarCoordKey(scope: string[], ivar: string): string {
  return `${scope.join(",")}|${ivar}`;
}

export class TypeFactStore {
  private readonly resolvedFacts: readonly TypeFact[];
  /** The language's source precedence, applied to EVERY ranked read below. */
  private readonly sourceOrder: readonly string[];

  private constructor(resolvedFacts: readonly TypeFact[], sourceOrder: readonly string[]) {
    this.resolvedFacts = resolvedFacts;
    this.sourceOrder = sourceOrder;
  }

  /**
   * Resolve a flat fact list into the store. `sourceOrder` is REQUIRED — the
   * kernel has no default precedence, because a default would silently hand one
   * language another's ranks. Callers pass their own constant
   * (`RUBY_TYPE_SOURCE_ORDER`, `PYTHON_TYPE_SOURCE_ORDER`).
   */
  static fromFacts(facts: TypeFact[], sourceOrder: readonly string[]): TypeFactStore {
    // Group by coordinate key; keep the fact with the highest-precedence source.
    const byCoord = new Map<string, TypeFact>();
    for (const f of facts) {
      const key = coordinateKey(f);
      const existing = byCoord.get(key);
      if (!existing || sourceRank(f.source, sourceOrder) < sourceRank(existing.source, sourceOrder)) {
        byCoord.set(key, f);
      }
    }
    return new TypeFactStore(Array.from(byCoord.values()), sourceOrder);
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
   * Full TypeRef for a method's return type (union/container preserved).
   * Scope is matched as a joined string; method name is exact.
   */
  structuredReturnType(scope: string[], method: string): TypeRef | undefined {
    const targetCoord = returnCoordKey(scope, method);
    // Among return facts for this coord, pick by source precedence.
    // (Position-keyed facts are already deduplicated in resolvedFacts;
    // return facts are name-keyed so we do a secondary pass here.)
    let best: TypeFact | undefined;
    let bestRank = Infinity;
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      if (returnCoordKey(f.symbolScope, f.methodName) !== targetCoord) continue;
      const rank = sourceRank(f.source, this.sourceOrder);
      if (!best || rank < bestRank) {
        best = f;
        bestRank = rank;
      }
    }
    return best?.type;
  }

  /**
   * Full TypeRef for an instance variable (union/container preserved).
   * Scope is matched as a joined string; ivar name is exact.
   */
  ivarType(scope: string[], ivar: string): TypeRef | undefined {
    const targetCoord = ivarCoordKey(scope, ivar);
    let best: TypeFact | undefined;
    let bestRank = Infinity;
    for (const f of this.resolvedFacts) {
      if (f.kind !== "ivar" || !f.name) continue;
      if (ivarCoordKey(f.symbolScope, f.name) !== targetCoord) continue;
      const rank = sourceRank(f.source, this.sourceOrder);
      if (!best || rank < bestRank) {
        best = f;
        bestRank = rank;
      }
    }
    return best?.type;
  }

  /**
   * Full `"<fqClass>#<method>" → TypeRef` map over every return fact, in the
   * engine's `structuredReturnTypes` key convention (the codegraph
   * `fqMethodKey`): fq class = `symbolScope.join("::")`, member joined with `#`
   * — the instance form, which is also what the engine looks up for a class
   * receiver, so a `def self.x` `@return` keeps answering `Klass.x` chains.
   * The one exception is a fact that explicitly declares itself class-level
   * (`TypeFact.classForm`, set by an `@!method self.x` directive): it joins
   * with `.` so it cannot overwrite the same class's real instance method.
   * Union / container refs are preserved verbatim. Source precedence matches the
   * {@link structuredReturnType} point lookup: the highest-precedence source
   * (lowest `sourceRank`) wins per key.
   */
  structuredReturnTypesMap(): Record<string, TypeRef> {
    const out: Record<string, TypeRef> = {};
    const bestRank = new Map<string, number>();
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const key = `${f.symbolScope.join("::")}${f.classForm === true ? "." : "#"}${f.methodName}`;
      const rank = sourceRank(f.source, this.sourceOrder);
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
      const rank = sourceRank(f.source, this.sourceOrder);
      const prev = bestRank.get(coord);
      if (prev === undefined || rank < prev) {
        (out[fqClass] ??= {})[f.name] = type;
        bestRank.set(coord, rank);
      }
    }
    return out;
  }
}
