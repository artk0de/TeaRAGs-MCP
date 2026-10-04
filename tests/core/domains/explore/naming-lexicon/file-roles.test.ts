/**
 * buildDependencyNormFileRoles (bd tea-rags-mcp-rpx0v): the file→role map
 * dependency norms judge by. The file carries its PRIMARY type's role — the
 * type the file is named for, never a secondary one — and a project-suffix
 * assignment stays weak, because suffix evidence confirms a role without
 * asserting it (naming's entry gate).
 */
import { describe, expect, it } from "vitest";

import type { TypeNameRow } from "../../../../../src/core/contracts/types/codegraph-storage.js";
import { buildDependencyNormFileRoles } from "../../../../../src/core/domains/explore/naming-lexicon/file-roles.js";
import type { TypeRoleAssignment } from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";

function row(symbolId: string, relPath: string, shortName: string): TypeNameRow {
  return { symbolId, relPath, shortName, symbolKind: "class", ancestors: [] };
}

function assignment(
  symbolId: string,
  relPath: string,
  role: string,
  evidence: TypeRoleAssignment["evidence"],
): TypeRoleAssignment {
  return {
    symbolId,
    relPath,
    role,
    evidence,
    support: 3,
    scope: evidence === "inheritance" ? "IJob" : evidence === "directory" ? "logic" : "",
  };
}

describe("buildDependencyNormFileRoles", () => {
  it("assigns the PRIMARY type's role, not a secondary one", () => {
    const rows = [row("s1", "logic/tasks.ts", "TaskService"), row("s2", "logic/tasks.ts", "TaskHelper")];
    const roles = buildDependencyNormFileRoles(rows, [assignment("s1", "logic/tasks.ts", "service", "inheritance")]);

    // Both names overlap the stem ("tasks"), no extra-word winner, so the
    // first declared is primary — and only ITS role counts.
    expect(roles.get("logic/tasks.ts")).toEqual({ role: "service", strong: true });
  });

  it("leaves a file untyped when its PRIMARY carries no role", () => {
    const rows = [row("s1", "logic/tasks.ts", "TaskRunner"), row("s2", "logic/tasks.ts", "TaskHelper")];
    const roles = buildDependencyNormFileRoles(rows, [assignment("s2", "logic/tasks.ts", "helper", "inheritance")]);

    // TaskRunner wins the stem tie by declaration order; Helper's role on the
    // secondary type must not leak onto the file.
    expect(roles.has("logic/tasks.ts")).toBe(false);
  });

  it("marks a project-suffix role weak and an inheritance role strong", () => {
    const rows = [row("s1", "logic/tasks.ts", "TaskOptions")];
    const roles = buildDependencyNormFileRoles(rows, [assignment("s1", "logic/tasks.ts", "options", "projectSuffix")]);

    expect(roles.get("logic/tasks.ts")).toEqual({ role: "options", strong: false });
  });

  it("keeps the strongest assignment when a symbol holds several", () => {
    const rows = [row("s1", "logic/tasks.ts", "TaskService")];
    const roles = buildDependencyNormFileRoles(rows, [
      assignment("s1", "logic/tasks.ts", "service", "inheritance"),
      assignment("s1", "logic/tasks.ts", "service", "projectSuffix"),
    ]);

    expect(roles.get("logic/tasks.ts")).toEqual({ role: "service", strong: true });
  });

  it("skips a namespace-only file: no primary declaration, no role", () => {
    const rows = [{ ...row("s1", "logic/payments.rb", "Communication"), symbolKind: "module" as const }];
    const roles = buildDependencyNormFileRoles(rows, [
      assignment("s1", "logic/payments.rb", "communication", "directory"),
    ]);

    // `module Communication` shares no word with its file stem — the
    // namespace wrapping the subject, never the subject itself.
    expect(roles.size).toBe(0);
  });
});
