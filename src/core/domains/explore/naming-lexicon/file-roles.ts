import type { TypeNameRow } from "../../../contracts/types/codegraph-storage.js";
import type { DependencyNormFileRole, RelPath } from "../../../contracts/types/codegraph.js";
import { deriveTypeRoles, filePrimaryDeclaration, type TypeRoleAssignment } from "./type-roles.js";

/**
 * The FILE→role map the dependency norms judge by (bd tea-rags-mcp-rpx0v):
 * each file carries its PRIMARY type's role (bd tea-rags-mcp-vi0wx's entry
 * contract — the type the file is named for), strong unless that assignment's
 * evidence is a project suffix, which confirms a role without asserting it.
 * A file whose primary carries no role is absent — the norms see it as
 * untyped, never as misfitting on a guess.
 *
 * `assignments` is injectable so tests can pin the role layer directly; by
 * default it derives from the same rows. A type may hold one assignment per
 * evidence kind, strongest first — the first per symbol wins.
 */
export function buildDependencyNormFileRoles(
  rows: readonly TypeNameRow[],
  assignments: readonly TypeRoleAssignment[] = deriveTypeRoles(rows),
): Map<RelPath, DependencyNormFileRole> {
  const roleBySymbol = new Map<string, TypeRoleAssignment>();
  for (const assignment of assignments) {
    if (!roleBySymbol.has(assignment.symbolId)) roleBySymbol.set(assignment.symbolId, assignment);
  }
  const byFile = new Map<RelPath, TypeNameRow[]>();
  for (const row of rows) {
    const file = byFile.get(row.relPath);
    if (file) file.push(row);
    else byFile.set(row.relPath, [row]);
  }
  const roles = new Map<RelPath, DependencyNormFileRole>();
  for (const [relPath, declarations] of byFile) {
    const primary = filePrimaryDeclaration(declarations);
    if (primary === undefined) continue;
    const assignment = roleBySymbol.get(primary.symbolId);
    if (assignment === undefined) continue;
    roles.set(relPath, { role: assignment.role, strong: assignment.evidence !== "projectSuffix" });
  }
  return roles;
}
