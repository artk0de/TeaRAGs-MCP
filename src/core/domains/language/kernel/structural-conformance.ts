/**
 * Structural conformance for the CHA cone (bd tea-rags-mcp-39xca.14, option D).
 *
 * The cone reaches an interface's implementers through `getDescendants`, and the
 * hierarchy held only what walkers DECLARED. A TypeScript class or object-literal
 * factory that satisfies an interface without an `implements` clause — and a
 * Python class that satisfies a `typing.Protocol` without subclassing it — was
 * invisible, so every dispatch edge onto it was lost.
 *
 * This derives the missing relation as `structural` hierarchy rows. An owner `O`
 * conforms to a contract `I` when, for every member `r` of `R(I)` (the contract's
 * own required members plus those of every contract it nominally extends), `O`
 * carries a member named `r.name` whose required positional count does not
 * exceed `r.params`: an implementation may accept fewer parameters than declared,
 * never require more. A member with no recorded arity matches by name.
 *
 * `O`'s members are its own INSTANCE-BOUND (`#`) definitions plus those of its
 * NOMINAL ancestors — a subclass carries what it inherits. A static member and a
 * helper nested in a function (`fn.inner`) are not carried by a value of `O`, so
 * they never count (bd tea-rags-mcp-39xca.19). The one owner whose `.` members
 * DO count is an object-literal declarator (`const X = { m() {} }`, walker kind
 * `module`): the literal itself is the value. The derived rows never feed back: a
 * structural ancestor gives downward dispatch only, never implementation.
 *
 * Deliberately recall-first (owner decision): no minimum member count, so a
 * one-member contract conforms every owner carrying that member, and the fan-out
 * that follows is bounded by the cone's own cap, not here.
 *
 * Cost: an index `memberName → owners`, and each contract intersects starting at
 * its rarest member — never contracts × owners.
 */

import {
  NOMINAL_INHERITANCE_KINDS,
  type AritySignature,
  type InheritanceEdgeRow,
  type StructuralContractDecl,
  type SymbolDefinition,
  type SymbolDefinitionKind,
} from "../../../contracts/types/codegraph.js";
import type { StructuralConformanceInput } from "../../../contracts/types/language.js";
import { symbolIdNamesInstanceMember } from "./symbol-id.js";

/** A definition of one of these kinds names a TYPE, never a member an owner carries. */
const TYPE_DEFINITION_KINDS: ReadonlySet<SymbolDefinitionKind> = new Set([
  "class",
  "module",
  "interface",
  "enum",
  "type_alias",
  "constant",
]);

/** `undefined` = the definition recorded no arity: it matches any declared count. */
type MemberArity = AritySignature | undefined;

/** memberName → owner → every arity the owner carries under that name. */
type OwnerMemberIndex = Map<string, Map<string, MemberArity[]>>;

/**
 * @param ownsDefinition which definitions belong to the calling language's
 *   family — the symbol table is one polyglot index, and a Ruby `find` must not
 *   make a Ruby class conform to a TypeScript interface. Omitted = all of them.
 */
export function deriveStructuralConformance(
  input: StructuralConformanceInput,
  ownsDefinition: (relPath: string) => boolean = () => true,
): InheritanceEdgeRow[] {
  if (input.contracts.length === 0) return [];
  // An owner is read off ONE scope segment, while a nested contract is named by
  // its qualified path (Python's `Outer.Inner`) — so a contract is recognised
  // as an owner by its innermost segment too, or it would conform to itself.
  const contractNames = new Set(input.contracts.flatMap((c) => [c.name, innermostSegment(c.name)]));
  const hierarchy = NominalHierarchy.of(input.nominalRows);
  const ownDefinitions = input.memberDefinitions.filter((def) => ownsDefinition(def.relPath));
  const valueOwners = objectLiteralOwnerKeys(input.ownerDefinitions ?? []);
  const index = buildOwnerMemberIndex(ownDefinitions, contractNames, hierarchy, valueOwners);
  const membersByContract = groupMembersByContract(input.contracts);

  const conforming = new Map<string, Set<string>>();
  for (const decl of input.contracts) {
    const required = requiredMembers(decl, membersByContract, hierarchy);
    if (required.size === 0) continue;
    for (const owner of conformingOwners(required, index)) {
      if (hierarchy.descendsFrom(owner, decl.name)) continue;
      let owners = conforming.get(decl.name);
      if (owners === undefined) conforming.set(decl.name, (owners = new Set<string>()));
      owners.add(owner);
    }
  }

  const rows: InheritanceEdgeRow[] = [];
  for (const contractName of [...conforming.keys()].sort(compareText)) {
    for (const owner of [...(conforming.get(contractName) ?? [])].sort(compareText)) {
      rows.push({
        sourceFqName: owner,
        sourceSymbolId: null,
        ancestorFqName: contractName,
        ancestorSymbolId: null,
        kind: "structural",
        ordinal: 0,
      });
    }
  }
  return rows;
}

/** The declared hierarchy, both directions, restricted to nominal kinds. */
class NominalHierarchy {
  private constructor(
    private readonly ancestorsOf: ReadonlyMap<string, readonly string[]>,
    private readonly descendantsOf: ReadonlyMap<string, readonly string[]>,
  ) {}

  static of(rows: readonly InheritanceEdgeRow[]): NominalHierarchy {
    const ancestors = new Map<string, string[]>();
    const descendants = new Map<string, string[]>();
    for (const row of rows) {
      if (!NOMINAL_INHERITANCE_KINDS.includes(row.kind)) continue;
      appendTo(ancestors, row.sourceFqName, row.ancestorFqName);
      appendTo(descendants, row.ancestorFqName, row.sourceFqName);
    }
    return new NominalHierarchy(ancestors, descendants);
  }

  private readonly ancestorMemo = new Map<string, ReadonlySet<string>>();
  private readonly descendantMemo = new Map<string, ReadonlySet<string>>();

  /** Every transitive nominal ancestor of `name`, excluding `name`. */
  ancestors(name: string): ReadonlySet<string> {
    return memoized(this.ancestorMemo, name, () => reach(name, this.ancestorsOf));
  }

  /** Every transitive nominal descendant of `name`, excluding `name`. */
  descendants(name: string): ReadonlySet<string> {
    return memoized(this.descendantMemo, name, () => reach(name, this.descendantsOf));
  }

  descendsFrom(owner: string, ancestor: string): boolean {
    return this.ancestors(owner).has(ancestor);
  }
}

function memoized<V>(memo: Map<string, V>, key: string, compute: () => V): V {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const value = compute();
  memo.set(key, value);
  return value;
}

/** Cycle-safe transitive closure over one adjacency map. */
function reach(start: string, edges: ReadonlyMap<string, readonly string[]>): Set<string> {
  const seen = new Set<string>();
  const stack = [...(edges.get(start) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (next === start || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(edges.get(next) ?? []));
  }
  return seen;
}

/**
 * The owner index: every owner's direct members, then each owner's members
 * pushed down to its nominal descendants. Contracts are not owners — a contract
 * declaring a member is a requirement, not an implementation.
 */
function buildOwnerMemberIndex(
  definitions: readonly SymbolDefinition[],
  contractNames: ReadonlySet<string>,
  hierarchy: NominalHierarchy,
  valueOwners: ReadonlySet<string>,
): OwnerMemberIndex {
  const direct: OwnerMemberIndex = new Map();
  for (const def of definitions) {
    const owner = def.scope.at(-1);
    if (owner === undefined || contractNames.has(owner)) continue;
    if (def.symbolKind !== undefined && TYPE_DEFINITION_KINDS.has(def.symbolKind)) continue;
    if (!isInstanceBound(def) && !valueOwners.has(scopeKey(def.relPath, def.scope))) continue;
    addMember(direct, def.shortName, owner, def.arity);
  }
  const index: OwnerMemberIndex = new Map();
  for (const [memberName, owners] of direct) {
    for (const [owner, arities] of owners) {
      for (const arity of arities) addMember(index, memberName, owner, arity);
      for (const heir of hierarchy.descendants(owner)) {
        if (contractNames.has(heir)) continue;
        for (const arity of arities) addMember(index, memberName, heir, arity);
      }
    }
  }
  return index;
}

/**
 * Is the definition invoked on its owner's VALUE — composed with the instance
 * separator (bd tea-rags-mcp-39xca.19)? A contract is satisfied by what a value
 * of the owner carries: a class's instance methods, an object-literal factory's
 * returned members. A static (`Pool.close`) is invoked on the class, and a
 * helper nested in a function (`parseSchema.close`) is a scope the owner never
 * exposes; counting either fanned a `close()` out to every function with a
 * local `close`. The separator is read from the id the producers composed
 * through `classifyMethod`, never re-derived here.
 */
function isInstanceBound(def: SymbolDefinition): boolean {
  return symbolIdNamesInstanceMember(def.fqName, def.shortName);
}

/**
 * The owners whose value IS the object that satisfies a contract (bd
 * tea-rags-mcp-39xca.19, option A): a declarator initialized by an object
 * literal, which the walker records as `symbolKind: "module"`. Their `.`
 * members count like `#` ones. Keyed by file and full scope path — the scope a
 * member of that owner carries — so a same-named function elsewhere, whose `.`
 * members are nested helpers, never borrows the kind.
 */
function objectLiteralOwnerKeys(ownerDefinitions: readonly SymbolDefinition[]): Set<string> {
  const keys = new Set<string>();
  for (const def of ownerDefinitions) {
    if (def.symbolKind === "module") keys.add(scopeKey(def.relPath, [...def.scope, def.shortName]));
  }
  return keys;
}

/** One file-and-scope identity; NUL cannot occur in a path or an identifier. */
function scopeKey(relPath: string, scope: readonly string[]): string {
  return [relPath, ...scope].join("\u0000");
}

function addMember(index: OwnerMemberIndex, memberName: string, owner: string, arity: MemberArity): void {
  let owners = index.get(memberName);
  if (owners === undefined) index.set(memberName, (owners = new Map<string, MemberArity[]>()));
  const arities = owners.get(owner);
  if (arities === undefined) owners.set(owner, [arity]);
  else arities.push(arity);
}

/** Every declaration's members under its contract name — a name declared twice contributes both to an heir. */
function groupMembersByContract(contracts: readonly StructuralContractDecl[]): Map<string, StructuralContractDecl[]> {
  const out = new Map<string, StructuralContractDecl[]>();
  for (const decl of contracts) appendTo(out, decl.name, decl);
  return out;
}

/**
 * `R(I)`: the declaration's own members plus every member of every contract it
 * nominally extends, keyed by name. A name required twice keeps the SMALLER
 * parameter count, the stricter of the two bounds.
 */
function requiredMembers(
  decl: StructuralContractDecl,
  membersByContract: ReadonlyMap<string, readonly StructuralContractDecl[]>,
  hierarchy: NominalHierarchy,
): Map<string, number> {
  const required = new Map<string, number>();
  const require = (source: StructuralContractDecl): void => {
    for (const member of source.members) {
      const bound = required.get(member.name);
      required.set(member.name, bound === undefined ? member.params : Math.min(bound, member.params));
    }
  };
  require(decl);
  for (const ancestor of hierarchy.ancestors(decl.name)) {
    for (const inherited of membersByContract.get(ancestor) ?? []) require(inherited);
  }
  return required;
}

/** Owners carrying every required member at a compatible arity, starting from the rarest member. */
function conformingOwners(required: ReadonlyMap<string, number>, index: OwnerMemberIndex): string[] {
  const byRarity = [...required].sort(([a], [b]) => (index.get(a)?.size ?? 0) - (index.get(b)?.size ?? 0));
  const [rarest, ...rest] = byRarity;
  const rarestOwners = index.get(rarest[0]);
  if (rarestOwners === undefined) return [];
  const survivors: string[] = [];
  for (const [owner, arities] of rarestOwners) {
    if (!acceptsParams(arities, rarest[1])) continue;
    if (rest.every(([name, params]) => acceptsParams(index.get(name)?.get(owner), params))) survivors.push(owner);
  }
  return survivors;
}

/** Can some definition of the member be called with `params` positional arguments? */
function acceptsParams(arities: readonly MemberArity[] | undefined, params: number): boolean {
  if (arities === undefined) return false;
  return arities.some((arity) => arity === undefined || arity.minRequired <= params);
}

function appendTo<V>(map: Map<string, V[]>, key: string, value: V): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [value]);
  else bucket.push(value);
}

function innermostSegment(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1);
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
