/**
 * Type roles (bd tea-rags-mcp-vi0wx): the tail word a family of types shares
 * (`…Strategy`, `…Preset`, `…Store`). Evidence, strongest first:
 *   1. inheritance — types with a common ancestor whose names share a tail word;
 *   2. directory   — a tail word carried by the primary types of ≥ 2 files and
 *      ≥ `directoryShare` of the directory's files that have a primary;
 *   3. project suffix — a tail word carried by the primary types of
 *      ≥ `projectSuffixMinTypes` files in ≥ `projectSuffixMinDirs` directories.
 * Directory and suffix evidence read ONE type per file, its primary (the type
 * whose words overlap the file stem most, see {@link primaryPerFile}): one
 * `errors.ts` of ten `*Error` classes is one file's convention, and a
 * `RerankOptions` beside `Reranker` is part of reranker.ts's subject, not a role.
 * The rows must arrive in declaration order within a file.
 * Every scope needs two types sharing the word: one type is not a family.
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
}

export interface TypeRoleThresholds {
  directoryShare: number;
  projectSuffixMinTypes: number;
  projectSuffixMinDirs: number;
}

export const TYPE_ROLE_THRESHOLDS: TypeRoleThresholds = {
  directoryShare: 0.2,
  projectSuffixMinTypes: 3,
  projectSuffixMinDirs: 2,
};

/** Two types sharing a tail word are the least that makes a family. */
const MIN_ROLE_MEMBERS = 2;
/** Examples returned by {@link expectedRoleFor}. */
const MAX_ROLE_EXAMPLES = 3;
const EVIDENCE_ORDER: readonly TypeRoleEvidence[] = ["inheritance", "directory", "projectSuffix"];

interface HeadedRow {
  row: TypeNameRow;
  head: string;
}

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

/** The most frequent head in a group and its count; ties go to the alphabetically first head. */
function dominantHead(members: readonly HeadedRow[]): { head: string; count: number } {
  const counts = new Map<string, number>();
  for (const { head } of members) counts.set(head, (counts.get(head) ?? 0) + 1);
  let best = { head: "", count: 0 };
  for (const [head, count] of counts) {
    if (count > best.count || (count === best.count && head < best.head)) best = { head, count };
  }
  return best;
}

/**
 * The head carried by the most FILES of a group (a file counts once per head,
 * however many of its types end in it) and that file count; ties go to the
 * alphabetically first head. One `errors.ts` of ten `*Error` classes is one
 * file of evidence, not ten.
 */
function dominantFileHead(members: readonly HeadedRow[]): { head: string; count: number } {
  const files = new Map<string, Set<string>>();
  for (const { row, head } of members) files.set(head, (files.get(head) ?? new Set<string>()).add(row.relPath));
  let best = { head: "", count: 0 };
  for (const [head, paths] of files) {
    if (paths.size > best.count || (paths.size === best.count && head < best.head)) {
      best = { head, count: paths.size };
    }
  }
  return best;
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

/**
 * Each file's PRIMARY type: the one whose (singular) words overlap its file
 * stem's most. A tie, or no overlap at all, goes to the first declared — the
 * rows arrive in declaration order within a file. `errors.ts` contributes one
 * `*Error`; `reranker.ts` contributes `Reranker`, not `RerankOptions`.
 */
function primaryPerFile(headed: readonly HeadedRow[]): HeadedRow[] {
  const best = new Map<string, { member: HeadedRow; overlap: number }>();
  for (const member of headed) {
    const stem = fileStemWords(member.row.relPath);
    const words = new Set(typeNameWords(member.row.shortName).map(singularizeIdentifierWord));
    const overlap = [...words].filter((word) => stem.has(word)).length;
    const current = best.get(member.row.relPath);
    if (!current || overlap > current.overlap) best.set(member.row.relPath, { member, overlap });
  }
  return [...best.values()].map(({ member }) => member);
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

/** Derives every type's role assignments, strongest evidence first, then by scope and symbolId. */
export function deriveTypeRoles(
  rows: readonly TypeNameRow[],
  t: TypeRoleThresholds = TYPE_ROLE_THRESHOLDS,
): TypeRoleAssignment[] {
  const headed: HeadedRow[] = [];
  for (const row of rows) {
    const words = typeNameWords(row.shortName);
    if (words.length > 0) headed.push({ row, head: words[words.length - 1] });
  }
  const assignments: TypeRoleAssignment[] = [];

  const families = groupBy(headed, ({ row }) => [...new Set(row.ancestors.map(typeNameLastSegment))]);
  for (const [ancestor, members] of families) {
    const { head, count } = dominantHead(members);
    if (count >= MIN_ROLE_MEMBERS) assignments.push(...assign(members, head, "inheritance", ancestor));
  }

  const primaries = primaryPerFile(headed);
  const directories = groupBy(primaries, ({ row }) => [directoryOf(row.relPath)]);
  for (const [dir, members] of directories) {
    const { head, count } = dominantFileHead(members);
    const files = new Set(members.map(({ row }) => row.relPath)).size;
    if (count >= MIN_ROLE_MEMBERS && count / files >= t.directoryShare) {
      assignments.push(...assign(members, head, "directory", dir));
    }
  }

  const byHead = groupBy(primaries, ({ head }) => [head]);
  for (const [head, members] of byHead) {
    const files = new Set(members.map(({ row }) => row.relPath));
    const dirs = new Set(members.map(({ row }) => directoryOf(row.relPath)));
    if (files.size >= Math.max(t.projectSuffixMinTypes, MIN_ROLE_MEMBERS) && dirs.size >= t.projectSuffixMinDirs) {
      assignments.push(...assign(members, head, "projectSuffix", ""));
    }
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
): { role: string; evidence: TypeRoleEvidence; examples: string[] } | undefined {
  if (assignments.length === 0) return undefined;
  const best = [...assignments].sort((a, b) => b.support - a.support || a.role.localeCompare(b.role))[0];
  const examples = assignments
    .filter((assignment) => assignment.role === best.role)
    .map((assignment) => typeNameLastSegment(assignment.symbolId))
    .sort()
    .slice(0, MAX_ROLE_EXAMPLES);
  return { role: best.role, evidence, examples };
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
): { role: string; evidence: TypeRoleEvidence; examples: string[] } | undefined {
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
