/**
 * Type roles (bd tea-rags-mcp-vi0wx): the tail word a family of types shares
 * (`…Strategy`, `…Preset`, `…Store`). Evidence, strongest first:
 *   1. inheritance — types with a common ancestor whose names share a tail word;
 *   2. directory   — the MAJORITY family: the plurality tail word of the
 *      directory's primaries, carried by ≥ 2 files and ≥ half (`directoryShare`
 *      0.5 — the definition of a majority) of the files that have a primary;
 *      a plurality tie is no role;
 *   3. project suffix — a tail word carried by the primary types of
 *      ≥ `projectSuffixMinTypes` files in ≥ `projectSuffixMinDirs` directories.
 * Directory and suffix evidence read ONE type per file, its primary (the type
 * whose words overlap the file stem most, see {@link primaryPerFile}): one
 * `errors.ts` of ten `*Error` classes is one file's convention, and a
 * `RerankOptions` beside `Reranker` is part of reranker.ts's subject, not a role.
 * The rows must arrive in declaration order within a file.
 * Every scope needs two types sharing the word: one type is not a family.
 *
 * What is NOT a role (bd tea-rags-mcp-49fsr, live on taxdome):
 *   - a family's minority head: the family role is the MAJORITY head of the
 *     family (`familyShare`), a split family has none — `create` on 324 of
 *     2,554 `KindOfService` services named no family;
 *   - a head that VARIES within an inheritance family: when a majority of a
 *     directory / suffix word's carriers share an ancestor whose family role is
 *     not that word (and no such majority family names it), the word is the
 *     family's varying slot — `*Async`, `*Finish`, `*Updated` are the verbs and
 *     events of role-less `KindOfService` / `BaseEvent` families;
 *   - a namespace `module` not named for its file: never the file's primary
 *     (it wraps the file's subject), and as a draft no member of its
 *     directory's role ({@link isNamespaceDeclaration});
 *   - a head restating the carrier's own declaration kind (`type` on a type
 *     alias, `enum` on an enum), read off the kind vocabulary itself;
 *   - a project suffix fewer than `projectSuffixMinTypes` DISTINCT names
 *     qualify: a bare `Finish` is the concept, not a family member, and a name
 *     declared in two files is one name;
 *   - the head of a member of a DISPERSED family's kind: a project-declared
 *     supertype whose family has no role, whose head word (singular) most of
 *     its members do not carry, and which a directory segment of the member's
 *     path names (its last word, singular) — `KindOfService` commands under
 *     `app/services/`. Such a member's role is that word, flagged
 *     `carriedInName: false`, and its head (`SendFirmAttributes` → `attributes`)
 *     is the family's varying slot, no directory or suffix role. A head the
 *     directory does not name (`ApplicationRecord` models in `app/models/`) or
 *     an undeclared supertype (`ActiveModel::Model`) names no kind;
 *   - a carrier that is no MEMBER of its directory / suffix family
 *     ({@link isRoleFamilyMember}): a `module` in a suffix family of types (the
 *     mixin `ClientPushBaseData` among `*Data` type aliases), or a type missing
 *     a cohesive family's supertype (`SendFailedPaymentNotification`, a
 *     `KindOfService` command, among `*Notification < Notification`).
 * Pure: the rows come in already read (type-level kinds only) by the caller.
 */
import type { TypeNameRow } from "../../../contracts/types/codegraph.js";
import { singularizeIdentifierWord, splitIdentifierWords, typeNameLastSegment, typeNameWords } from "./casing.js";

/** The row shape is owned by the store contract (`GraphDbClient.readTypeNameRows`). */
export type { TypeNameRow };

export type TypeRoleEvidence = "inheritance" | "directory" | "projectSuffix";

/**
 * A type carrying the role of one evidence scope. A type may carry one
 * assignment per evidence kind; the list is ordered strongest evidence first.
 */
export interface TypeRoleAssignment {
  symbolId: string;
  relPath: string;
  role: string;
  evidence: TypeRoleEvidence;
  /** Types sharing the role in that family / dir / project. */
  support: number;
  /** The scope the role holds in: the ancestor's last segment, the directory, or `""` for the project. */
  scope: string;
  /**
   * A directory or project-suffix role whose family is COHESIVE: the
   * supertype(s) (last namespace segment) the role's carriers share — each
   * carried by ≥ 2 of them and by at least half of them, the most carried.
   * Absent when the carriers share no supertype (`*Args`, `*Options`).
   */
  familySupertypes?: readonly string[];
  /**
   * `false` on an inheritance role its family does NOT carry in names — a
   * dispersed family's kind ({@link deriveTypeRoles}): what the type IS, never a
   * word its name owes. Absent: the role is the name's head.
   */
  carriedInName?: boolean;
}

/**
 * What a declaration IS, for family membership (bd tea-rags-mcp-49fsr): a
 * `module` — a namespace, a mixin, a TS `const` object — or a TYPE, whatever
 * kind declares it. The kinds that declare a type are one form: `interface
 * CacheStore` is the contract its `*Store` classes implement, and 45 of
 * taxdome's 4,136 `*Props` are interfaces beside type aliases.
 */
export type DeclarationForm = "module" | "type";

export function declarationForm(kind: TypeNameRow["symbolKind"]): DeclarationForm | undefined {
  if (kind === null) return undefined;
  return kind === NAMESPACE_KIND ? "module" : "type";
}

/** The kind that names a type without extending one: its supertypes are not known to miss, they do not exist. */
const SUPERTYPELESS_KIND: TypeNameRow["symbolKind"] = "type_alias";

function declaresSupertypes(kind: TypeNameRow["symbolKind"] | undefined): boolean {
  return kind !== SUPERTYPELESS_KIND;
}

/** What makes a type a member of a non-inheritance role family: its form and its supertypes. */
export interface RoleFamilyMembership {
  familySupertypes?: readonly string[];
  familyForm?: DeclarationForm;
}

/**
 * Whether a type belongs to a role family (bd tea-rags-mcp-49fsr): its form is
 * the family's, and — when the family is cohesive — its supertypes (by last
 * namespace segment) include one the family shares. What is not KNOWN about the
 * type (`symbolKind` / `supertypes` undefined) never excludes it, and neither do
 * the supertypes of a kind that declares none (a type alias). Callers pass
 * `supertypes` only for a type that DECLARES at least one: `BatchAccumulator`
 * declaring nothing beside `implements StatsAccumulator` classes is no evidence
 * of non-membership, `SendFailedPaymentNotification` declaring `KindOfService`
 * among `Notification` subclasses is. The one test the
 * derivation applies to an existing type and the draft verdict to a draft.
 */
export function isRoleFamilyMember(
  family: RoleFamilyMembership,
  type: { symbolKind?: TypeNameRow["symbolKind"]; supertypes?: ReadonlySet<string> },
): boolean {
  const form = type.symbolKind === undefined ? undefined : declarationForm(type.symbolKind);
  if (family.familyForm !== undefined && form !== undefined && form !== family.familyForm) return false;
  const { familySupertypes } = family;
  const { supertypes } = type;
  if (familySupertypes === undefined || supertypes === undefined || !declaresSupertypes(type.symbolKind)) return true;
  return familySupertypes.some((supertype) => supertypes.has(supertype));
}

export interface TypeRoleThresholds {
  /** The share of a directory's primaries its role word must hold: a MAJORITY family. */
  directoryShare: number;
  /** The share of an inheritance family its role word must hold — and of a word's carriers a family must hold to veto it. */
  familyShare: number;
  projectSuffixMinTypes: number;
  projectSuffixMinDirs: number;
}

export const TYPE_ROLE_THRESHOLDS: TypeRoleThresholds = {
  // 0.5 is the definition of a majority, not a tuned value: a directory's role is the family
  // at least half of its files belong to. A lower share let two helper files name a directory.
  directoryShare: 0.5,
  // The same majority for an inheritance family (bd tea-rags-mcp-49fsr).
  familyShare: 0.5,
  projectSuffixMinTypes: 3,
  projectSuffixMinDirs: 2,
};

/** Two types sharing a tail word are the least that makes a family. */
const MIN_ROLE_MEMBERS = 2;

/**
 * The project-wide spread that makes a word the project's CONVENTION rather
 * than one module's: ≥ `projectSuffixMinTypes` files (never under two) in ≥
 * `projectSuffixMinDirs` directories. The project-suffix role reads it for a
 * tail word; a type draft's collision check reads it for a whole short name
 * (bd tea-rags-mcp-icuxg) — one criterion for "the project writes this".
 */
export function meetsProjectConventionSpread(
  files: number,
  dirs: number,
  t: TypeRoleThresholds = TYPE_ROLE_THRESHOLDS,
): boolean {
  return files >= Math.max(t.projectSuffixMinTypes, MIN_ROLE_MEMBERS) && dirs >= t.projectSuffixMinDirs;
}
/** Examples returned by {@link expectedRoleFor}. */
const MAX_ROLE_EXAMPLES = 3;
const EVIDENCE_ORDER: readonly TypeRoleEvidence[] = ["inheritance", "directory", "projectSuffix"];

interface HeadedRow {
  row: TypeNameRow;
  /** The name's last word as a role candidate; `null` when it restates the row's declaration kind. */
  head: string | null;
}

/** The namespace kind: a primary only when named for its file, else it wraps the file's subject. */
const NAMESPACE_KIND: TypeNameRow["symbolKind"] = "module";

/** The file's directory: everything before the last `/`, `""` at the root. */
function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash < 0 ? "" : relPath.slice(0, slash);
}

function groupBy<K>(items: readonly HeadedRow[], keysOf: (item: HeadedRow) => readonly K[]): Map<K, HeadedRow[]> {
  const groups = new Map<K, HeadedRow[]>();
  for (const item of items) {
    for (const key of keysOf(item)) {
      const group = groups.get(key);
      if (group) group.push(item);
      else groups.set(key, [item]);
    }
  }
  return groups;
}

/**
 * The plurality head of a group — a directory's primaries (one per file) or a
 * family's members — and its count; `undefined` when two heads tie for the
 * most (a split group has no majority family) or no member has a head.
 */
function pluralityHead(members: readonly HeadedRow[]): { head: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const { head } of members) if (head !== null) counts.set(head, (counts.get(head) ?? 0) + 1);
  let best: { head: string; count: number } | undefined;
  let tied = false;
  for (const [head, count] of counts) {
    if (!best || count > best.count) {
      best = { head, count };
      tied = false;
    } else if (count === best.count) tied = true;
  }
  return tied ? undefined : best;
}

/** Leading / trailing words of a file stem that mark a test file, not its subject. */
const TEST_STEM_WORDS = new Set(["test", "tests", "spec"]);

/** The singular words of a file's basename up to its first `.`, test markers dropped: `errors.test.ts` → `{error}`. */
function fileStemWords(relPath: string): Set<string> {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const words = splitIdentifierWords(base.split(".")[0] ?? "");
  while (words.length > 0 && TEST_STEM_WORDS.has(words[0])) words.shift();
  while (words.length > 0 && TEST_STEM_WORDS.has(words[words.length - 1])) words.pop();
  return new Set(words.map(singularizeIdentifierWord));
}

/** Tie-break rank of a declaration kind for the primary pick: lower wins. */
const PRIMARY_KIND_RANK: Partial<Record<NonNullable<TypeNameRow["symbolKind"]>, number>> = {
  class: 0,
  interface: 1,
  enum: 1,
  module: 1,
  type_alias: 2,
};
const OTHER_KIND_RANK = 3;

interface PrimaryCandidate {
  member: HeadedRow;
  overlap: number;
  /** The name's words that are not stem words. */
  extra: number;
  kindRank: number;
}

/** Whether `a` beats the incumbent `b` (declared earlier): more overlap, then — on overlap — fewer extra words, then the stronger kind. */
function beatsPrimary(a: PrimaryCandidate, b: PrimaryCandidate): boolean {
  if (a.overlap !== b.overlap) return a.overlap > b.overlap;
  if (a.overlap === 0) return false;
  if (a.extra !== b.extra) return a.extra < b.extra;
  return a.kindRank < b.kindRank;
}

/**
 * Each file's PRIMARY type: the one whose (singular) words overlap its file
 * stem's most. Among the max-overlap types the fewest words beyond the stem's
 * win (`CompletionRunner` over `CompletionRunnerDeps`), then the kind — class >
 * interface / enum / module > type alias > the rest (`FileOutlineStrategy` over
 * `FileOutlineInput`) — then the first declared; with no overlap at all, the
 * first declared. The rows arrive in declaration order within a file.
 * `errors.ts` contributes one `*Error`; `reranker.ts` contributes `Reranker`,
 * not `RerankOptions`. A `module` competes only when its name overlaps the stem
 * (bd tea-rags-mcp-49fsr): one named for the file is its subject (a Ruby
 * concern, a TS `const` object of hooks), one that is not is the NAMESPACE
 * wrapping the subject — `module Communication` around a contract whose
 * `Request = Data.define(…)` is a constant leaves that file without a primary.
 */
function primaryHeadedPerFile(headed: readonly HeadedRow[]): HeadedRow[] {
  const best = new Map<string, PrimaryCandidate>();
  for (const member of headed) {
    if (isNamespaceDeclaration(member.row)) continue;
    const { words, overlap } = fileStemOverlap(member.row.shortName, member.row.relPath);
    const kind = member.row.symbolKind;
    const candidate: PrimaryCandidate = {
      member,
      overlap,
      extra: words.size - overlap,
      kindRank: (kind === null ? undefined : PRIMARY_KIND_RANK[kind]) ?? OTHER_KIND_RANK,
    };
    const current = best.get(member.row.relPath);
    if (!current || beatsPrimary(candidate, current)) best.set(member.row.relPath, candidate);
  }
  return [...best.values()].map(({ member }) => member);
}

/** A type name's singular words, and how many of them its file's stem shares. */
function fileStemOverlap(shortName: string, relPath: string): { words: Set<string>; overlap: number } {
  const stem = fileStemWords(relPath);
  const words = new Set(typeNameWords(shortName).map(singularizeIdentifierWord));
  return { words, overlap: [...words].filter((word) => stem.has(word)).length };
}

/**
 * A NAMESPACE declaration: a `module` sharing no word with its file's stem —
 * it wraps the file's subject instead of being it (bd tea-rags-mcp-49fsr). Such
 * a declaration is never a file's primary, and a namespace DRAFT is no member of
 * its directory's role family (bd tea-rags-mcp-59q9c): `module GettingPaid`
 * around a worker in `app/workers/getting_paid/` is not a `*Worker`.
 */
export function isNamespaceDeclaration(declaration: {
  shortName: string;
  relPath: string;
  symbolKind?: TypeNameRow["symbolKind"];
}): boolean {
  return (
    declaration.symbolKind === NAMESPACE_KIND &&
    fileStemOverlap(declaration.shortName, declaration.relPath).overlap === 0
  );
}

/** Each file's primary type, in first-seen file order (see {@link primaryHeadedPerFile}); nameless rows are skipped. */
export function primaryPerFile(rows: readonly TypeNameRow[]): TypeNameRow[] {
  return primaryHeadedPerFile(headedRows(rows)).map(({ row }) => row);
}

/**
 * The words a declaration kind is spelled with (`type_alias` → `type`, `alias`):
 * a name ending in one restates what its declaration already says.
 */
function kindWords(kind: TypeNameRow["symbolKind"]): ReadonlySet<string> {
  return new Set(kind === null ? [] : splitIdentifierWords(kind));
}

function headedRows(rows: readonly TypeNameRow[]): HeadedRow[] {
  const headed: HeadedRow[] = [];
  for (const row of rows) {
    const words = typeNameWords(row.shortName);
    const last = words.at(-1);
    if (last === undefined) continue;
    headed.push({ row, head: kindWords(row.symbolKind).has(last) ? null : last });
  }
  return headed;
}

/** A head qualified by at least one word before it: `ContactImportFinish`, not a bare `Finish`. */
function qualifiesHead(row: TypeNameRow): boolean {
  return typeNameWords(row.shortName).length > 1;
}

function assign(
  members: readonly HeadedRow[],
  role: string,
  evidence: TypeRoleEvidence,
  scope: string,
): TypeRoleAssignment[] {
  const carriers = members.filter((member) => member.head === role);
  return carriers.map(({ row }) => ({
    symbolId: row.symbolId,
    relPath: row.relPath,
    role,
    evidence,
    support: carriers.length,
    scope,
  }));
}

/** A cohesive family's supertypes on each assignment; the form is read back off the carriers ({@link projectSuffixRole}). */
function withFamily(assignments: TypeRoleAssignment[], family: RoleFamilyMembership): TypeRoleAssignment[] {
  const { familySupertypes } = family;
  return familySupertypes === undefined
    ? assignments
    : assignments.map((assignment) => ({ ...assignment, familySupertypes }));
}

/**
 * The supertypes a directory / suffix role's carriers share (bd tea-rags-mcp-tun7x):
 * the most carried supertype(s), by last namespace segment, when that count is
 * ≥ {@link MIN_ROLE_MEMBERS} and at least `share` of the carriers — the same
 * majority the role itself is defined by. Ties at that count are all
 * returned, sorted. `undefined` when the family shares none.
 */
function cohesiveSupertypes(carriers: readonly HeadedRow[], share: number): string[] | undefined {
  const counts = new Map<string, number>();
  for (const { row } of carriers) {
    for (const supertype of new Set(row.ancestors.map(typeNameLastSegment))) {
      counts.set(supertype, (counts.get(supertype) ?? 0) + 1);
    }
  }
  const most = Math.max(0, ...counts.values());
  if (most < MIN_ROLE_MEMBERS || most / carriers.length < share) return undefined;
  return [...counts]
    .filter(([, count]) => count === most)
    .map(([supertype]) => supertype)
    .sort();
}

/** The form at least `share` of the carriers are declared in; `undefined` on a tie or with no such majority. */
function dominantForm(carriers: readonly { row: TypeNameRow }[], share: number): DeclarationForm | undefined {
  const counts = new Map<DeclarationForm, number>();
  for (const { row } of carriers) {
    const form = declarationForm(row.symbolKind);
    if (form !== undefined) counts.set(form, (counts.get(form) ?? 0) + 1);
  }
  let best: { form: DeclarationForm; count: number } | undefined;
  let tied = false;
  for (const [form, count] of counts) {
    if (!best || count > best.count) {
      best = { form, count };
      tied = false;
    } else if (count === best.count) tied = true;
  }
  return best && !tied && best.count / carriers.length >= share ? best.form : undefined;
}

/**
 * A non-inheritance family's membership (bd tea-rags-mcp-49fsr): with `byForm`,
 * its dominant form first, then the supertypes shared by its carriers of that
 * form that can declare one — a type alias declares none, so counting it would
 * dilute the rest: taxdome's `*Notification` is cohesive at 68 of 103 classes,
 * not at 68 of 140 types.
 */
function roleFamily(carriers: readonly HeadedRow[], share: number, byForm: boolean): RoleFamilyMembership {
  const familyForm = byForm ? dominantForm(carriers, share) : undefined;
  const declaring = carriers.filter(
    ({ row }) =>
      declaresSupertypes(row.symbolKind) &&
      (familyForm === undefined || declarationForm(row.symbolKind) === familyForm),
  );
  const familySupertypes = cohesiveSupertypes(declaring, share);
  return { ...(familyForm ? { familyForm } : {}), ...(familySupertypes ? { familySupertypes } : {}) };
}

/** A family's carriers that belong to it ({@link isRoleFamilyMember}): an existing row's kind and supertypes are known. */
function familyMembers(
  carriers: readonly HeadedRow[],
  family: RoleFamilyMembership,
  supertypesOf: ProjectSupertypes,
): HeadedRow[] {
  return carriers.filter(({ row }) =>
    isRoleFamilyMember(family, {
      symbolKind: row.symbolKind,
      // Declaring nothing is no evidence of non-membership (TS structural typing, Ruby duck
      // typing): only a type that DECLARES a supertype can miss the family's.
      ...(row.ancestors.length > 0 ? { supertypes: supertypesOf(row.shortName, row.ancestors) } : {}),
    }),
  );
}

/**
 * A type's supertypes for family membership, by last namespace segment: the
 * type itself, its declared supertypes, and theirs as the project declares
 * them, transitively. `ApplicationForm` is a member of the family extending it,
 * and `ReplaceForm < ActivateForm < ApplicationForm` is one of its members.
 */
export type ProjectSupertypes = (shortName: string, ancestors: readonly string[]) => Set<string>;

const projectSupertypesCache = new WeakMap<readonly TypeNameRow[], ProjectSupertypes>();

export function projectSupertypes(rows: readonly TypeNameRow[]): ProjectSupertypes {
  const cached = projectSupertypesCache.get(rows);
  if (cached) return cached;
  const declared = new Map<string, Set<string>>();
  for (const row of rows) {
    const name = typeNameLastSegment(row.shortName);
    const set = declared.get(name) ?? new Set<string>();
    for (const ancestor of row.ancestors) set.add(typeNameLastSegment(ancestor));
    declared.set(name, set);
  }
  const resolve: ProjectSupertypes = (shortName, ancestors) => {
    const seen = new Set<string>([typeNameLastSegment(shortName)]);
    const queue = ancestors.map(typeNameLastSegment);
    for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(declared.get(next) ?? []));
    }
    return seen;
  };
  projectSupertypesCache.set(rows, resolve);
  return resolve;
}

/**
 * Whether `word` is the VARYING slot of an inheritance family rather than a role
 * (bd tea-rags-mcp-49fsr): a family (by last namespace segment) holding at least
 * `share` of the carriers — and ≥ {@link MIN_ROLE_MEMBERS} of them — has a role
 * other than `word`, and no family holding such a majority has `word` as its
 * role. The carriers' kinship is their ancestor; their heads vary inside it —
 * `*Async`, `*Finish`, `*Create` are the verbs of taxdome's role-less
 * `KindOfService` services, `*Updated` the events of `BaseEvent`. A mixin family
 * with no role never vetoes a head another majority family names (`*Form`
 * under both `BaseForm` and `ActiveModel::Model`).
 */
function familySlot(
  carriers: readonly HeadedRow[],
  word: string,
  familyRoles: ReadonlyMap<string, string | undefined>,
  share: number,
): boolean {
  const counts = new Map<string, number>();
  for (const { row } of carriers) {
    for (const ancestor of new Set(row.ancestors.map(typeNameLastSegment))) {
      counts.set(ancestor, (counts.get(ancestor) ?? 0) + 1);
    }
  }
  let vetoed = false;
  for (const [ancestor, count] of counts) {
    if (count < MIN_ROLE_MEMBERS || count / carriers.length < share) continue;
    if (familyRoles.get(ancestor) === word) return false;
    vetoed = true;
  }
  return vetoed;
}

/** A path's directory segments, each read as its last word, singular: `app/async_operations/x.rb` → `{app, operation}`. */
function directoryWords(relPath: string): Set<string> {
  const words = new Set<string>();
  for (const segment of relPath.split("/").slice(0, -1)) {
    const last = splitIdentifierWords(segment).at(-1);
    if (last !== undefined) words.add(singularizeIdentifierWord(last));
  }
  return words;
}

/** The kind a dispersed family names for a member ({@link unnamedKinds}). */
interface UnnamedKind {
  role: string;
  scope: string;
  familySize: number;
  support: number;
}

/**
 * The members of DISPERSED families that take the family's kind (bd
 * tea-rags-mcp-49fsr): the family (by last namespace segment) has no role, the
 * supertype is declared in the project, fewer than `share` of its members end
 * in the supertype's head word (singular) — it is not carried in names — and a
 * directory segment of the member's path names that word. Of two such
 * families the larger names the kind, then the first by name.
 */
function unnamedKinds(
  families: ReadonlyMap<string, readonly HeadedRow[]>,
  familyRoles: ReadonlyMap<string, string | undefined>,
  declared: ReadonlySet<string>,
  share: number,
): Map<TypeNameRow, UnnamedKind> {
  const kinds = new Map<TypeNameRow, UnnamedKind>();
  for (const [ancestor, members] of families) {
    if (familyRoles.get(ancestor) !== undefined || members.length < MIN_ROLE_MEMBERS || !declared.has(ancestor)) {
      continue;
    }
    const last = typeNameWords(ancestor).at(-1);
    if (last === undefined) continue;
    const role = singularizeIdentifierWord(last);
    const carried = members.filter(({ head }) => head !== null && singularizeIdentifierWord(head) === role).length;
    if (carried / members.length >= share) continue;
    const agreeing = members.filter(({ row }) => directoryWords(row.relPath).has(role));
    for (const { row } of agreeing) {
      const current = kinds.get(row);
      const larger =
        !current ||
        members.length > current.familySize ||
        (members.length === current.familySize && ancestor.localeCompare(current.scope) < 0);
      if (larger) kinds.set(row, { role, scope: ancestor, familySize: members.length, support: agreeing.length });
    }
  }
  return kinds;
}

/** Derives every type's role assignments, strongest evidence first, then by scope and symbolId. */
export function deriveTypeRoles(
  rows: readonly TypeNameRow[],
  t: TypeRoleThresholds = TYPE_ROLE_THRESHOLDS,
): TypeRoleAssignment[] {
  const headed = headedRows(rows);
  const supertypesOf = projectSupertypes(rows);
  const assignments: TypeRoleAssignment[] = [];

  const familyRoles = new Map<string, string | undefined>();
  const families = groupBy(headed, ({ row }) => [...new Set(row.ancestors.map(typeNameLastSegment))]);
  for (const [ancestor, members] of families) {
    const plurality = pluralityHead(members);
    const role =
      plurality && plurality.count >= MIN_ROLE_MEMBERS && plurality.count / members.length >= t.familyShare
        ? plurality.head
        : undefined;
    familyRoles.set(ancestor, role);
    if (role !== undefined) assignments.push(...assign(members, role, "inheritance", ancestor));
  }
  const isFamilySlot = (carriers: readonly HeadedRow[], word: string): boolean =>
    familySlot(carriers, word, familyRoles, t.familyShare);

  const declared = new Set(rows.map((row) => typeNameLastSegment(row.shortName)));
  const kinds = unnamedKinds(families, familyRoles, declared, t.familyShare);
  const inherited = new Set(
    assignments.map((assignment) => `${assignment.relPath}\u0000${assignment.symbolId}\u0000${assignment.role}`),
  );
  for (const [row, kind] of kinds) {
    if (inherited.has(`${row.relPath}\u0000${row.symbolId}\u0000${kind.role}`)) continue;
    assignments.push({
      symbolId: row.symbolId,
      relPath: row.relPath,
      role: kind.role,
      evidence: "inheritance",
      support: kind.support,
      scope: kind.scope,
      carriedInName: false,
    });
  }
  /** A kind member's head is its family's varying slot: no directory / suffix role but its kind. */
  const outsideKinds = (members: readonly HeadedRow[], word: string): HeadedRow[] =>
    members.filter(({ row }) => {
      const kind = kinds.get(row);
      return kind === undefined || kind.role === word;
    });

  const primaries = primaryHeadedPerFile(headed);
  const directories = groupBy(primaries, ({ row }) => [directoryOf(row.relPath)]);
  for (const [dir, members] of directories) {
    const plurality = pluralityHead(members);
    if (!plurality || plurality.count < MIN_ROLE_MEMBERS || plurality.count / members.length < t.directoryShare) {
      continue;
    }
    const carriers = members.filter(({ head }) => head === plurality.head);
    if (isFamilySlot(carriers, plurality.head)) continue;
    // No form test here: a directory is one module's convention, and a module named for its
    // file there is the file's subject, held to the directory's role (bd tea-rags-mcp-59q9c).
    // Forms mix across a PROJECT suffix — Ruby classes and TS type aliases share tail words.
    const family = roleFamily(carriers, t.directoryShare, false);
    assignments.push(
      ...withFamily(
        assign(
          outsideKinds(familyMembers(carriers, family, supertypesOf), plurality.head),
          plurality.head,
          "directory",
          dir,
        ),
        family,
      ),
    );
  }

  const byHead = groupBy(primaries, ({ head }) => (head === null ? [] : [head]));
  for (const [head, members] of byHead) {
    // A suffix is a word names ATTACH to: a bare `Finish` is the concept itself, and a name
    // declared in two files is one name — neither is a second member of the family.
    const qualified = members.filter(({ row }) => qualifiesHead(row));
    const names = new Set(qualified.map(({ row }) => row.shortName));
    const files = new Set(qualified.map(({ row }) => row.relPath));
    const dirs = new Set(qualified.map(({ row }) => directoryOf(row.relPath)));
    if (names.size < Math.max(t.projectSuffixMinTypes, MIN_ROLE_MEMBERS)) continue;
    if (!meetsProjectConventionSpread(files.size, dirs.size, t)) continue;
    if (isFamilySlot(members, head)) continue;
    const family = roleFamily(members, t.familyShare, true);
    assignments.push(
      ...withFamily(
        assign(outsideKinds(familyMembers(members, family, supertypesOf), head), head, "projectSuffix", ""),
        family,
      ),
    );
  }

  return assignments.sort(
    (a, b) =>
      EVIDENCE_ORDER.indexOf(a.evidence) - EVIDENCE_ORDER.indexOf(b.evidence) ||
      a.scope.localeCompare(b.scope) ||
      a.symbolId.localeCompare(b.symbolId),
  );
}

/** The most-supported role among `assignments`, with up to three example short names; ties by role name. */
function pickRole(
  assignments: readonly TypeRoleAssignment[],
  evidence: TypeRoleEvidence,
): ExpectedTypeRole | undefined {
  if (assignments.length === 0) return undefined;
  const best = [...assignments].sort((a, b) => b.support - a.support || a.role.localeCompare(b.role))[0];
  const examples = assignments
    .filter((assignment) => assignment.role === best.role)
    .map((assignment) => typeNameLastSegment(assignment.symbolId))
    .sort()
    .slice(0, MAX_ROLE_EXAMPLES);
  return {
    role: best.role,
    evidence,
    examples,
    ...(best.familySupertypes ? { familySupertypes: best.familySupertypes } : {}),
    ...(best.carriedInName === false ? { carriedInName: false } : {}),
  };
}

/** The role a type draft is expected to carry ({@link expectedRoleFor}). */
export interface ExpectedTypeRole extends RoleFamilyMembership {
  role: string;
  evidence: TypeRoleEvidence;
  examples: string[];
  /** A cohesive family: the supertypes a member declares ({@link TypeRoleAssignment.familySupertypes}). */
  familySupertypes?: readonly string[];
  /** A project suffix: the form its carriers are declared in ({@link projectSuffixRole}). */
  familyForm?: DeclarationForm;
  /** A dispersed family's kind: `false`, the role is not the name's head ({@link TypeRoleAssignment.carriedInName}). */
  carriedInName?: boolean;
}

/**
 * The project-suffix family of `word`, when the project has one — what a
 * draft's head is confirmed by — with the form its carriers (`rows` holds them)
 * are declared in: the members the derivation kept share the family's dominant
 * form ({@link isRoleFamilyMember}), so the form is read back off them.
 */
export function projectSuffixRole(
  roles: readonly TypeRoleAssignment[],
  rows: readonly TypeNameRow[],
  word: string,
  t: TypeRoleThresholds = TYPE_ROLE_THRESHOLDS,
): ExpectedTypeRole | undefined {
  const carried = roles.filter((r) => r.evidence === "projectSuffix" && r.role === word);
  const role = pickRole(carried, "projectSuffix");
  if (role === undefined) return undefined;
  const keys = new Set(carried.map((r) => `${r.relPath}\u0000${r.symbolId}`));
  const carriers = rows.filter((row) => keys.has(`${row.relPath}\u0000${row.symbolId}`)).map((row) => ({ row }));
  const familyForm = dominantForm(carriers, t.familyShare);
  return familyForm === undefined ? role : { ...role, familyForm };
}

/**
 * The role a type draft is expected to carry: its planned ancestor's family
 * role (matched by last namespace segment), else its directory's role, else a
 * project suffix carried by a type in its directory (examples project-wide).
 * `undefined` when no evidence applies.
 */
export function expectedRoleFor(
  roles: readonly TypeRoleAssignment[],
  draft: { path: string; extends?: string },
): ExpectedTypeRole | undefined {
  if (draft.extends !== undefined) {
    const ancestor = typeNameLastSegment(draft.extends);
    const family = pickRole(
      roles.filter((r) => r.evidence === "inheritance" && r.scope === ancestor),
      "inheritance",
    );
    if (family) return family;
  }
  const dir = directoryOf(draft.path);
  const directory = pickRole(
    roles.filter((r) => r.evidence === "directory" && r.scope === dir),
    "directory",
  );
  if (directory) return directory;
  const suffixes = roles.filter((r) => r.evidence === "projectSuffix");
  const suffixesHere = new Set(suffixes.filter((r) => directoryOf(r.relPath) === dir).map((r) => r.role));
  return pickRole(
    suffixes.filter((r) => suffixesHere.has(r.role)),
    "projectSuffix",
  );
}
