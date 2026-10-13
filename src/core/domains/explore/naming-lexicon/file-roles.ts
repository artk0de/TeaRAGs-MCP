import type { TypeNameRow } from "../../../contracts/types/codegraph-storage.js";
import type { DependencyNormFileRole, RelPath } from "../../../contracts/types/codegraph.js";
import type { TypeRoleEvidence } from "../../../contracts/types/naming-lexicon.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../primitives/graph/index.js";
import { singularizeIdentifierWord, splitIdentifierWords, typeNameLastSegment, typeNameWords } from "./casing.js";
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
 *      role-bearing files beneath it carry — gives that role to a file beneath
 *      it whose role is only a head noun (directory / suffix evidence);
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

  const conventional = applyConventionalDirectoryRoles(entries);
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
 * directory role (`api`) they really carry.
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
  // bases (`Seed::Base`, `Api::Contracts::Results::Base`) into one "family".
  const supertypesOf = new Map<string, Set<string>>();
  for (const row of rows) {
    const name = typeNameLastSegment(row.shortName);
    const set = supertypesOf.get(name) ?? new Set<string>();
    for (const ancestor of row.ancestors) set.add(writtenSupertype(ancestor));
    supertypesOf.set(name, set);
  }
  /** Every supertype `row` reaches, with its hop distance (1 = declared). */
  const reach = (row: TypeNameRow): Map<string, number> => {
    const depths = new Map<string, number>();
    let frontier = [...new Set(row.ancestors.map(writtenSupertype))];
    const own = typeNameLastSegment(row.shortName);
    for (let depth = 1; frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const name of frontier) {
        if (typeNameLastSegment(name) === own || depths.has(name)) continue;
        depths.set(name, depth);
        next.push(...(supertypesOf.get(typeNameLastSegment(name)) ?? []));
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
 * Rule 2 of {@link buildDependencyNormFileRoles}: a directory is CONVENTIONAL
 * for role R when its own name's last word (singular) is R and R is the role a
 * majority (`directoryShare`) of the strongly-roled files beneath it carry —
 * `app/services` once its `KindOfService` family reads `service`. A file
 * beneath it whose role is only a head noun (directory or suffix evidence)
 * takes R from the NEAREST such directory; inheritance evidence and I/O shapes
 * keep theirs.
 */
function applyConventionalDirectoryRoles(
  entries: Map<RelPath, { role: DependencyNormFileRole; evidence: TypeRoleEvidence }>,
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
    const named = singularizeIdentifierWord(splitIdentifierWords(dir.slice(dir.lastIndexOf("/") + 1)).at(-1) ?? "");
    const carriers = tally.get(named) ?? 0;
    const total = [...tally.values()].reduce((sum, n) => sum + n, 0);
    if (carriers >= MIN_ROLE_MEMBERS && carriers / total >= TYPE_ROLE_THRESHOLDS.directoryShare) {
      conventional.set(dir, named);
    }
  }
  for (const [relPath, entry] of entries) {
    if (entry.evidence === "inheritance" || entry.role.weakReason !== undefined) continue;
    const dir = ancestorDirectories(relPath).find((d) => conventional.has(d));
    const role = dir === undefined ? undefined : conventional.get(dir);
    if (role !== undefined && (role !== entry.role.role || !entry.role.strong)) {
      entries.set(relPath, { role: { role, strong: true }, evidence: "directory" });
    }
  }
  return conventional;
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

/** `relPath`'s directories, nearest first: `a/b/c.rb` → `a/b`, `a`. */
function ancestorDirectories(relPath: string): string[] {
  const dirs: string[] = [];
  for (let slash = relPath.lastIndexOf("/"); slash > 0; slash = relPath.lastIndexOf("/", slash - 1)) {
    dirs.push(relPath.slice(0, slash));
  }
  return dirs;
}
