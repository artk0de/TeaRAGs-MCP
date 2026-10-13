import type { TypeNameRow } from "../../../contracts/types/codegraph-storage.js";
import type { DependencyNormFileRole, RelPath } from "../../../contracts/types/codegraph.js";
import type { TypeRoleEvidence } from "../../../contracts/types/naming-lexicon.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../primitives/graph/index.js";
import { singularizeIdentifierWord, splitIdentifierWords, typeNameLastSegment, typeNameWords } from "./casing.js";
import type { TypeNameParser } from "./name-slots.js";
import {
  deriveTypeRoles,
  filePrimaryDeclaration,
  MIN_ROLE_MEMBERS,
  TYPE_ROLE_THRESHOLDS,
  typeNameParser,
  type TypeRoleAssignment,
} from "./type-roles.js";

/**
 * The population under which Otsu's split of family sizes is not trusted —
 * the majority floor ({@link MIN_ROLE_MEMBERS}) holds alone there, the same
 * gate the norms' pair-support cut uses.
 */
const FAMILY_SIZE_OTSU_MIN_POPULATION = 5;

/** Declaration kinds that only describe a SHAPE — no behaviour, no supertype a class would carry. */
const SHAPE_KINDS: ReadonlySet<TypeNameRow["symbolKind"]> = new Set(["interface", "type_alias"]);

/**
 * The FILE→role map the dependency norms judge by (bd tea-rags-mcp-rpx0v):
 * each file carries its PRIMARY type's role (bd tea-rags-mcp-vi0wx's entry
 * contract — the type the file is named for), strong unless that assignment's
 * evidence is a project suffix, which confirms a role without asserting it.
 * A file whose primary carries no role is absent — the norms see it as
 * untyped, never as misfitting on a guess.
 *
 * ARCHITECTURAL roles over domain nouns (bd tea-rags-mcp-xb669.6). A norm is
 * a habit between KINDS of file; measured on taxdome, naming's head-noun roles
 * scattered each kind into singleton pairs — models carried `field` /
 * `template` / `user`, service objects `update` / `create`, hooks `params` /
 * `return`. Three corrections, each read off the corpus, none a vocabulary:
 *   1. an inheritance family whose population clears the adaptive cut over
 *      family sizes is ONE kind: every member, transitively, carries the
 *      family's role — its majority head, else its base's own head
 *      (`ApplicationRecord` → `record`); the NEAREST such family decides;
 *   2. a CONVENTIONAL directory — one whose name is the role most of the
 *      role-bearing files beneath it carry, or the head of a supertype most of
 *      its primaries declare (mixins included) — gives that role to a file
 *      beneath it whose role is only a head noun (directory / suffix evidence;
 *      for the supertype reading, only to that supertype's carriers);
 *   3. a primary that only shapes the I/O of the function the file is named
 *      for (`UseXParams` in `useX.ts`, `XProps` in `X.tsx`) asserts no role:
 *      weak, with `weakReason: "ioShape"`;
 *   4–5. a head-noun role read where the role does not live — outside its
 *      conventional directories, or with a call shape its home's carriers do
 *      not have — is DISPLACED (bd tea-rags-mcp-4vj2u, see `applyRoleHomes`).
 *
 * `assignments` is injectable so tests can pin the role layer directly; by
 * default it derives from the same rows. A type may hold one assignment per
 * evidence kind, strongest first — the first per symbol wins.
 */
export function buildDependencyNormFileRoles(
  rows: readonly TypeNameRow[],
  assignments?: readonly TypeRoleAssignment[],
): Map<RelPath, DependencyNormFileRole> {
  const kindRows = rows.map(superclassOnly);
  const roleBySymbol = new Map<string, TypeRoleAssignment>();
  for (const assignment of assignments ?? deriveTypeRoles(kindRows)) {
    if (!roleBySymbol.has(assignment.symbolId)) roleBySymbol.set(assignment.symbolId, assignment);
  }
  const primaries = primaryRowPerFile(kindRows);
  const familyRoleOf = architecturalFamilyRoles(kindRows, primaries);

  const entries = new Map<RelPath, { role: DependencyNormFileRole; evidence: TypeRoleEvidence }>();
  for (const [relPath, primary] of primaries) {
    const assignment = roleBySymbol.get(primary.symbolId);
    if (isIoShape(primary)) {
      if (assignment !== undefined) {
        entries.set(relPath, {
          role: { role: assignment.role, strong: false, weakReason: "ioShape" },
          evidence: assignment.evidence,
        });
      }
      continue;
    }
    const familyRole = familyRoleOf(primary, assignment?.evidence === "inheritance" ? assignment : undefined);
    if (familyRole !== undefined) {
      entries.set(relPath, { role: { role: familyRole, strong: true }, evidence: "inheritance" });
      continue;
    }
    if (assignment === undefined) continue;
    entries.set(relPath, {
      role: { role: assignment.role, strong: assignment.evidence !== "projectSuffix" },
      evidence: assignment.evidence,
    });
  }

  const conventional = applyConventionalDirectoryRoles(
    entries,
    primaries,
    declaredAncestorsOf(rows, primaries),
    typeNameParser(kindRows),
  );
  applyRoleHomes(entries, primaries, conventional);
  return new Map([...entries].map(([relPath, { role }]) => [relPath, role]));
}

/**
 * Each file's PRIMARY type's last namespace segment (bd tea-rags-mcp-xb669.6)
 * — what the norms read to tell an edge into the file's role from one into a
 * constant nested in it (`BaseAdapter::RateLimitError`).
 */
export function buildDependencyNormFilePrimaryTypes(rows: readonly TypeNameRow[]): Map<RelPath, string> {
  return new Map(
    [...primaryRowPerFile(rows)].map(([relPath, primary]) => [relPath, typeNameLastSegment(primary.shortName)]),
  );
}

/**
 * `row` with its SUPERCLASS as its only ancestor (bd tea-rags-mcp-xb669.6,
 * owner decision): a role family is a KIND, and only the superclass says what
 * a type is. A mixin (`include Api::Contracts::Enforcement` in 86 API
 * modules) or an implemented interface is a capability shared across kinds —
 * as a family it would pull every includer into one role and hide the
 * directory role (`api`) they really carry. A mixin may still CONFIRM a
 * directory's own role (rule 2, bd tea-rags-mcp-8up12) — it never names one.
 */
function superclassOnly(row: TypeNameRow): TypeNameRow {
  return { ...row, ancestors: row.superclass === undefined ? [] : [row.superclass] };
}

function primaryRowPerFile(rows: readonly TypeNameRow[]): Map<RelPath, TypeNameRow> {
  const byFile = new Map<RelPath, TypeNameRow[]>();
  for (const row of rows) {
    const file = byFile.get(row.relPath);
    if (file) file.push(row);
    else byFile.set(row.relPath, [row]);
  }
  const primaries = new Map<RelPath, TypeNameRow>();
  for (const [relPath, declarations] of byFile) {
    const primary = filePrimaryDeclaration(declarations);
    if (primary !== undefined) primaries.set(relPath, primary);
  }
  return primaries;
}

/**
 * Whether the primary only SHAPES the I/O of the function the file is named
 * for: a shape kind that is either the stem's words plus at least one more
 * (`UseLoadThreadsParams` in `useLoadThreads.ts`, `SelectProps` in
 * `Select.tsx`) or shares no word with the stem at all (`type Props` in
 * `PinModal.tsx`). The stem-named declaration is then a function — no type row
 * — and the type names its parameter / props / result, not the file's kind. A
 * shape the file IS named for (`InvoiceSidebarContext.ts`), or one the stem
 * wraps (`SidebarsStore` in `useSidebarsStore.ts`), is its subject.
 */
function isIoShape(primary: TypeNameRow): boolean {
  if (!SHAPE_KINDS.has(primary.symbolKind)) return false;
  const base = primary.relPath.slice(primary.relPath.lastIndexOf("/") + 1);
  const stem = splitIdentifierWords(base.split(".")[0] ?? "").map(singularizeIdentifierWord);
  const words = typeNameWords(primary.shortName).map(singularizeIdentifierWord);
  if (stem.length === 0 || words.length === 0) return false;
  const extendsStem = words.length > stem.length && stem.every((word, i) => words[i] === word);
  return extendsStem || !words.some((word) => stem.includes(word));
}

/**
 * The role a primary owes its LARGE inheritance family, or `undefined`.
 *
 * A family is every primary reaching a supertype (as written, namespace kept)
 * through the declared supertypes, transitively; its population is that file
 * count. "Large" is the adaptive cut over every family's population — Otsu's
 * split, floored by the majority {@link MIN_ROLE_MEMBERS} — so the corpus, not
 * a framework list, says which bases are architectural kinds. A primary takes
 * the NEAREST large family (fewest supertype hops; the more populous on a tie
 * — the rows arrive {@link superclassOnly}, so a mixin never competes). The family's role
 * is its members' majority head (≥ `familyShare`), else the base's own head:
 * `ApplicationRecord`'s models split over `field` / `template` / `user`, and
 * all of them are `record`s.
 */
function architecturalFamilyRoles(
  rows: readonly TypeNameRow[],
  primaries: ReadonlyMap<RelPath, TypeNameRow>,
): (primary: TypeNameRow, inherited?: TypeRoleAssignment) => string | undefined {
  // Families key on the supertype AS WRITTEN: a bare last segment pools unrelated
  // bases (`Seed::Base`, `Api::Contracts::Results::Base`) into one "family". The
  // HOP to the next supertype resolves the written name against its writer (bd
  // tea-rags-mcp-9okcg) — by last segment, every `*::Base` inherited the
  // superclass of the one `Base` that declared any.
  const supertypes = supertypeResolver(rows);
  /** Every supertype `row` reaches, with its hop distance (1 = declared). */
  const reach = (row: TypeNameRow): Map<string, number> => {
    const depths = new Map<string, number>();
    const own = typeNameLastSegment(row.shortName);
    const visited = new Set<string>([row.symbolId]);
    let frontier = [...new Set(row.ancestors.map(writtenSupertype))].map((name) => ({ name, writer: row.symbolId }));
    for (let depth = 1; frontier.length > 0; depth++) {
      const next: typeof frontier = [];
      for (const { name, writer } of frontier) {
        if (typeNameLastSegment(name) === own) continue;
        if (!depths.has(name)) depths.set(name, depth);
        const resolved = supertypes.resolve(name, writer);
        if (resolved === undefined || visited.has(resolved)) continue;
        visited.add(resolved);
        for (const supertype of supertypes.declaredBy(resolved)) next.push({ name: supertype, writer: resolved });
      }
      frontier = next;
    }
    return depths;
  };

  const reached = new Map<TypeNameRow, Map<string, number>>();
  const members = new Map<string, TypeNameRow[]>();
  for (const primary of primaries.values()) {
    const depths = reach(primary);
    reached.set(primary, depths);
    for (const supertype of depths.keys()) {
      const list = members.get(supertype) ?? [];
      list.push(primary);
      members.set(supertype, list);
    }
  }
  const sizes = [...members.values()].map((list) => list.length).filter((size) => size >= MIN_ROLE_MEMBERS);
  const cut = resolveMajorityFlooredOtsuThreshold(sizes, {
    majority: MIN_ROLE_MEMBERS,
    minPopulation: FAMILY_SIZE_OTSU_MIN_POPULATION,
  });

  const parse = typeNameParser(rows);
  const roleOfFamily = new Map<string, string | undefined>();
  const familyRole = (supertype: string, familyMembers: readonly TypeNameRow[]): string | undefined => {
    if (roleOfFamily.has(supertype)) return roleOfFamily.get(supertype);
    const counts = new Map<string, number>();
    for (const member of familyMembers) {
      const { head } = parse(member.shortName);
      if (head !== undefined) counts.set(head, (counts.get(head) ?? 0) + 1);
    }
    const [top] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const majority =
      top !== undefined &&
      top[1] >= MIN_ROLE_MEMBERS &&
      top[1] / familyMembers.length >= TYPE_ROLE_THRESHOLDS.familyShare
        ? top[0]
        : undefined;
    const role = majority ?? parse(supertype).head;
    roleOfFamily.set(supertype, role);
    return role;
  };

  return (primary, inherited) => {
    const depths = reached.get(primary);
    if (depths === undefined) return undefined;
    let best: { supertype: string; depth: number; size: number } | undefined;
    for (const [supertype, depth] of depths) {
      const size = members.get(supertype)?.length ?? 0;
      if (!cut.admits(size)) continue;
      if (best === undefined || depth < best.depth || (depth === best.depth && size > best.size)) {
        best = { supertype, depth, size };
      }
    }
    if (best === undefined) return undefined;
    if (inherited !== undefined) {
      // The role layer's own inheritance role names the family at `scope`. It stands
      // when that family IS the large one (as written or by last segment — the nearer,
      // more specific reading) or sits nearer; a sibling at the same depth yields.
      const scopeLast = typeNameLastSegment(inherited.scope);
      const same = (name: string) => name === inherited.scope || typeNameLastSegment(name) === scopeLast;
      if (same(best.supertype)) return undefined;
      const scopeDepth = Math.min(...[...depths].filter(([name]) => same(name)).map(([, depth]) => depth));
      if (scopeDepth < best.depth) return undefined;
    }
    return familyRole(best.supertype, members.get(best.supertype) ?? []);
  };
}

/**
 * Each primary's DECLARED supertypes as written — superclass, mixins and
 * implemented interfaces alike, read off the raw rows before
 * {@link superclassOnly} narrows them for families.
 */
function declaredAncestorsOf(
  rows: readonly TypeNameRow[],
  primaries: ReadonlyMap<RelPath, TypeNameRow>,
): Map<RelPath, ReadonlySet<string>> {
  const declared = new Map<RelPath, ReadonlySet<string>>();
  for (const row of rows) {
    if (primaries.get(row.relPath)?.symbolId !== row.symbolId) continue;
    declared.set(row.relPath, new Set(row.ancestors.map(writtenSupertype)));
  }
  return declared;
}

/** The role a directory's own name states: its last word, singular (`app/services` → `service`). */
function directoryNameRole(dir: string): string {
  return singularizeIdentifierWord(splitIdentifierWords(dir.slice(dir.lastIndexOf("/") + 1)).at(-1) ?? "");
}

/**
 * Rule 2 of {@link buildDependencyNormFileRoles}: a directory is CONVENTIONAL
 * for role R — R being its own name's last word, singular — when either
 *   a. R is the role a majority (`directoryShare`) of the strongly-roled files
 *      beneath it carry; a file beneath it whose role is only a head noun
 *      (directory or suffix evidence) takes R; or
 *   b. a supertype its primaries DECLARE — superclass, mixin or implemented
 *      interface — is headed by R and declared by ≥ {@link MIN_ROLE_MEMBERS}
 *      and a majority (`directoryShare`) of its non-ioShape primaries
 *      (bd tea-rags-mcp-8up12: `app/services`, where most service objects
 *      only `include KindOfService` and are named by a verb). Only that
 *      supertype's CARRIERS take R, untyped ones included; every other file
 *      keeps its own role. A mixin still forms no family — it confirms the
 *      role the directory name states, it never names one.
 * The NEAREST conventional directory decides; inheritance evidence and I/O
 * shapes keep theirs.
 */
function applyConventionalDirectoryRoles(
  entries: Map<RelPath, { role: DependencyNormFileRole; evidence: TypeRoleEvidence }>,
  primaries: ReadonlyMap<RelPath, TypeNameRow>,
  declaredAncestors: ReadonlyMap<RelPath, ReadonlySet<string>>,
  parse: TypeNameParser,
): ReadonlyMap<string, string> {
  const tallies = new Map<string, Map<string, number>>();
  for (const [relPath, { role }] of entries) {
    if (!role.strong) continue;
    for (const dir of ancestorDirectories(relPath)) {
      const tally = tallies.get(dir) ?? new Map<string, number>();
      tally.set(role.role, (tally.get(role.role) ?? 0) + 1);
      tallies.set(dir, tally);
    }
  }
  const conventional = new Map<string, string>();
  for (const [dir, tally] of tallies) {
    const named = directoryNameRole(dir);
    const carriers = tally.get(named) ?? 0;
    const total = [...tally.values()].reduce((sum, n) => sum + n, 0);
    if (carriers >= MIN_ROLE_MEMBERS && carriers / total >= TYPE_ROLE_THRESHOLDS.directoryShare) {
      conventional.set(dir, named);
    }
  }
  const confirmedBy = ancestorConfirmedDirectories(primaries, declaredAncestors, conventional, parse);
  for (const [dir, { role }] of confirmedBy) conventional.set(dir, role);

  for (const [relPath, primary] of primaries) {
    const entry = entries.get(relPath);
    const keepsOwn =
      entry === undefined
        ? isIoShape(primary)
        : entry.evidence === "inheritance" || entry.role.weakReason !== undefined;
    const dir = keepsOwn ? undefined : ancestorDirectories(relPath).find((d) => conventional.has(d));
    const role = dir === undefined ? undefined : conventional.get(dir);
    if (dir === undefined || role === undefined) continue;
    const confirming = confirmedBy.get(dir)?.ancestor;
    // A strong-carrier directory relabels typed files only; an ancestor-confirmed one its carriers only.
    const takesRole =
      confirming === undefined ? entry !== undefined : declaredAncestors.get(relPath)?.has(confirming) === true;
    if (takesRole && (role !== entry?.role.role || entry.role.strong !== true)) {
      entries.set(relPath, { role: { role, strong: true }, evidence: "directory" });
    }
  }
  return conventional;
}

/**
 * Rule 2b of {@link applyConventionalDirectoryRoles}: each directory not
 * already conventional whose name's role heads a supertype declared by
 * ≥ {@link MIN_ROLE_MEMBERS} and ≥ `directoryShare` of its non-ioShape
 * primaries — mapped to that role and its confirming supertype (the most
 * carried one when several qualify).
 */
function ancestorConfirmedDirectories(
  primaries: ReadonlyMap<RelPath, TypeNameRow>,
  declaredAncestors: ReadonlyMap<RelPath, ReadonlySet<string>>,
  conventional: ReadonlyMap<string, string>,
  parse: TypeNameParser,
): Map<string, { role: string; ancestor: string }> {
  const tallies = new Map<string, { primaries: number; carriers: Map<string, number> }>();
  for (const [relPath, primary] of primaries) {
    if (isIoShape(primary)) continue;
    const declared = declaredAncestors.get(relPath) ?? new Set<string>();
    for (const dir of ancestorDirectories(relPath)) {
      if (conventional.has(dir)) continue;
      const tally = tallies.get(dir) ?? { primaries: 0, carriers: new Map<string, number>() };
      tally.primaries++;
      for (const ancestor of declared) tally.carriers.set(ancestor, (tally.carriers.get(ancestor) ?? 0) + 1);
      tallies.set(dir, tally);
    }
  }
  const confirmed = new Map<string, { role: string; ancestor: string }>();
  for (const [dir, tally] of tallies) {
    const named = directoryNameRole(dir);
    let best: { ancestor: string; carriers: number } | undefined;
    for (const [ancestor, carriers] of tally.carriers) {
      if (carriers < MIN_ROLE_MEMBERS || carriers / tally.primaries < TYPE_ROLE_THRESHOLDS.directoryShare) continue;
      if (parse(ancestor).head !== named) continue;
      const beats =
        best === undefined || carriers > best.carriers || (carriers === best.carriers && ancestor < best.ancestor);
      if (beats) best = { ancestor, carriers };
    }
    if (best !== undefined) confirmed.set(dir, { role: named, ancestor: best.ancestor });
  }
  return confirmed;
}

/** How a primary's callables are called: on instances, on the type only, or unknown. */
type PrimaryCallShape = "instance" | "functions" | undefined;

function callShapeOf(primary: TypeNameRow | undefined): PrimaryCallShape {
  if (primary?.instanceMethodCount === undefined || primary.singletonMethodCount === undefined) return undefined;
  if (primary.instanceMethodCount > 0) return "instance";
  return primary.singletonMethodCount > 0 ? "functions" : undefined;
}

/**
 * Rules 4 and 5 of {@link buildDependencyNormFileRoles} (bd tea-rags-mcp-4vj2u):
 * a head noun asserts a role only where the role LIVES. A role's HOMES are its
 * conventional directories (rule 2); its home SHAPE is how the majority
 * (`directoryShare`) of the carriers there with a known shape are called — on
 * instances (Rails view-helper mixins) or on the type itself (a namespace of
 * functions). A strong carrier whose role is only a head noun (directory
 * evidence) is DISPLACED when
 *   4. the role has a home and the file sits beneath none of them
 *      (`displaced: "outsideRoleHome"`) — `app/lib/billing/fee_helper.rb` is
 *      no view helper because its name ends in `Helper`; or
 *   5. its own shape is not the role's home shape (`displaced: "callShape"`)
 *      — a `class << self` utility in a helpers directory of mixins.
 * A displaced role stays STRONG: the ledgers count its edges as precedent
 * (weakening them erased the helper → record direction the real view helpers
 * hold, measured), while no edge touching it carries a verdict. Inheritance
 * evidence and weak readings keep theirs; a carrier of unknown shape is never
 * displaced by shape. Measured on taxdome (xb669.8 gold set): `helper` lumped
 * view mixins, `lib` utilities and `app/lib` calculators — 17 FALSE and 6
 * DOUBTFUL of 51 MISFITs.
 */
function applyRoleHomes(
  entries: Map<RelPath, { role: DependencyNormFileRole; evidence: TypeRoleEvidence }>,
  primaries: ReadonlyMap<RelPath, TypeNameRow>,
  conventional: ReadonlyMap<string, string>,
): void {
  const homeOf = (relPath: RelPath, role: string): boolean =>
    ancestorDirectories(relPath).some((dir) => conventional.get(dir) === role);
  const hasHome = new Set(conventional.values());

  const shapeTally = new Map<string, { instance: number; functions: number }>();
  for (const [relPath, { role }] of entries) {
    if (!role.strong || !homeOf(relPath, role.role)) continue;
    const shape = callShapeOf(primaries.get(relPath));
    if (shape === undefined) continue;
    const tally = shapeTally.get(role.role) ?? { instance: 0, functions: 0 };
    tally[shape]++;
    shapeTally.set(role.role, tally);
  }
  const homeShape = (role: string): PrimaryCallShape => {
    const tally = shapeTally.get(role);
    if (tally === undefined) return undefined;
    const known = tally.instance + tally.functions;
    if (tally.instance >= MIN_ROLE_MEMBERS && tally.instance / known >= TYPE_ROLE_THRESHOLDS.directoryShare) {
      return "instance";
    }
    if (tally.functions >= MIN_ROLE_MEMBERS && tally.functions / known >= TYPE_ROLE_THRESHOLDS.directoryShare) {
      return "functions";
    }
    return undefined;
  };

  for (const [relPath, entry] of entries) {
    const { role } = entry;
    if (!role.strong || entry.evidence !== "directory") continue;
    if (!hasHome.has(role.role)) continue;
    if (!homeOf(relPath, role.role)) {
      entries.set(relPath, { ...entry, role: { ...role, displaced: "outsideRoleHome" } });
      continue;
    }
    const expected = homeShape(role.role);
    const shape = callShapeOf(primaries.get(relPath));
    if (expected !== undefined && shape !== undefined && shape !== expected) {
      entries.set(relPath, { ...entry, role: { ...role, displaced: "callShape" } });
    }
  }
}

/** A supertype as written, namespace kept (`::Api::Results::Base<T>` → `Api::Results::Base`). */
function writtenSupertype(typeName: string): string {
  return typeName.replace(/^::/, "").replace(/[<[].*$/, "");
}

/**
 * The project type a WRITTEN supertype names, read the way the writer's
 * language reads a constant (bd tea-rags-mcp-9okcg): `Handlers::Base` written
 * inside `Billing::Handlers::AccessRestored` is the innermost declared
 * `<enclosing namespace>::Handlers::Base`, tried from the writer's own
 * namespace outward to the top level, skipping the writer itself
 * (`class Risk::Model < Model` names the outer `Model`). No declared match = a type outside the
 * project (`Dry::Struct`, `ActiveRecord::Base`): an external leaf with no
 * further hop. Never a match by last segment — that pooled every `*::Base`.
 * `declaredBy` is a resolved type's declared supertypes, as written.
 */
function supertypeResolver(rows: readonly TypeNameRow[]): {
  resolve: (written: string, writerSymbolId: string) => string | undefined;
  declaredBy: (symbolId: string) => ReadonlySet<string>;
} {
  const declared = new Map<string, Set<string>>();
  for (const row of rows) {
    const supertypes = declared.get(row.symbolId) ?? new Set<string>();
    for (const ancestor of row.ancestors) supertypes.add(writtenSupertype(ancestor));
    declared.set(row.symbolId, supertypes);
  }
  return {
    resolve: (written, writerSymbolId) => {
      const scopes = writerSymbolId.split("::");
      for (let depth = scopes.length - 1; depth >= 0; depth--) {
        const candidate = [...scopes.slice(0, depth), written].join("::");
        // A class statement's superclass is read before the class exists — never itself.
        if (candidate !== writerSymbolId && declared.has(candidate)) return candidate;
      }
      return undefined;
    },
    declaredBy: (symbolId) => declared.get(symbolId) ?? new Set<string>(),
  };
}

/** `relPath`'s directories, nearest first: `a/b/c.rb` → `a/b`, `a`. */
function ancestorDirectories(relPath: string): string[] {
  const dirs: string[] = [];
  for (let slash = relPath.lastIndexOf("/"); slash > 0; slash = relPath.lastIndexOf("/", slash - 1)) {
    dirs.push(relPath.slice(0, slash));
  }
  return dirs;
}
