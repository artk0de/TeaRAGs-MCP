/**
 * Change-reason extraction (B1, bd tea-rags-mcp-psh3j): a ticket's domain is
 * the dominant component of every file its commits touched, the module under
 * measurement excluded from the vote; a module's change reasons are the
 * distinct domains of the tickets that changed it.
 *
 * Invariants under test:
 *   - the measured module never votes for its own tickets' domain;
 *   - two tickets dominated by different components are two reasons;
 *   - a ticket that touched nothing outside the module is a reason of the
 *     module's own domain;
 *   - commits naming no ticket are counted as untracked, never as a reason;
 *   - a tie between components makes the ticket a reason of EVERY tied one;
 *   - below the task-id commit share floor the extraction is unavailable and
 *     names the share, never a confident reason set.
 */

import { describe, expect, it } from "vitest";

import type { RelPath } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  CHANGE_REASON_MIN_TASK_ID_COMMIT_SHARE,
  extractChangeReasons,
  type ChangeReasonCommit,
  type ModuleChangeReasons,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const componentOf: ReadonlyMap<RelPath, string> = new Map([
  ["billing/invoice.ts", "billing"],
  ["billing/tax.ts", "billing"],
  ["auth/session.ts", "auth"],
  ["auth/token.ts", "auth"],
  ["ui/form.ts", "ui"],
  ["ui/button.ts", "ui"],
  ["core/money.ts", "core"],
]);

function commit(taskIds: readonly string[], ...files: readonly RelPath[]): ChangeReasonCommit {
  return { taskIds, files };
}

function moduleOf(modules: readonly ModuleChangeReasons[], module: string): ModuleChangeReasons {
  const found = modules.find((m) => m.module === module);
  if (!found) throw new Error(`no change reasons for ${module}`);
  return found;
}

function available(commits: readonly ChangeReasonCommit[]): readonly ModuleChangeReasons[] {
  const extraction = extractChangeReasons({ commits, componentOf });
  if (!extraction.available) throw new Error("extraction unavailable");
  return extraction.modules;
}

describe("extractChangeReasons (bd tea-rags-mcp-psh3j)", () => {
  it("excludes the measured module from its tickets' dominant-component vote", () => {
    // TD-1 touched one core file and two billing files: measured from core,
    // billing dominates; measured from billing, its own two files do not
    // vote, so core is the reason.
    const modules = available([
      commit(["TD-1"], "core/money.ts", "billing/invoice.ts", "billing/tax.ts"),
      commit(["TD-1"], "billing/invoice.ts"),
    ]);
    expect(moduleOf(modules, "core").reasons).toEqual([{ domain: "billing", tickets: 1, commits: 1 }]);
    expect(moduleOf(modules, "billing").reasons).toEqual([{ domain: "core", tickets: 1, commits: 2 }]);
  });

  it("makes two tickets dominated by different components two reasons", () => {
    const modules = available([
      commit(["TD-1"], "core/money.ts", "billing/invoice.ts", "billing/tax.ts"),
      commit(["TD-2"], "core/money.ts", "auth/session.ts", "auth/token.ts"),
      commit(["TD-3"], "core/money.ts", "auth/session.ts"),
    ]);
    expect(moduleOf(modules, "core").reasons).toEqual([
      { domain: "auth", tickets: 2, commits: 2 },
      { domain: "billing", tickets: 1, commits: 1 },
    ]);
  });

  it("reads a ticket that never left the module as the module's own reason", () => {
    const modules = available([commit(["TD-9"], "ui/form.ts", "ui/button.ts")]);
    expect(moduleOf(modules, "ui").reasons).toEqual([{ domain: "ui", tickets: 1, commits: 1 }]);
  });

  it("counts commits naming no ticket as untracked, never as a reason", () => {
    const modules = available([
      commit(["TD-1"], "core/money.ts", "billing/invoice.ts"),
      commit(["TD-2"], "core/money.ts", "billing/tax.ts"),
      commit([], "core/money.ts", "auth/session.ts"),
    ]);
    const core = moduleOf(modules, "core");
    expect(core.reasons).toEqual([{ domain: "billing", tickets: 2, commits: 2 }]);
    expect(core.untrackedCommits).toBe(1);
    expect(core.commits).toBe(3);
  });

  it("makes a ticket tied between components a reason of every tied component", () => {
    const modules = available([commit(["TD-4"], "core/money.ts", "billing/invoice.ts", "auth/session.ts")]);
    expect(moduleOf(modules, "core").reasons).toEqual([
      { domain: "auth", tickets: 1, commits: 1 },
      { domain: "billing", tickets: 1, commits: 1 },
    ]);
  });

  it("ignores files outside the partition — they neither vote nor form a module", () => {
    const modules = available([commit(["TD-5"], "core/money.ts", "README.md", "docs/a.md", "ui/form.ts")]);
    expect(moduleOf(modules, "core").reasons).toEqual([{ domain: "ui", tickets: 1, commits: 1 }]);
    expect(modules.map((m) => m.module).sort()).toEqual(["core", "ui"]);
  });

  it("orders modules by distinct reason count, most first", () => {
    const modules = available([
      commit(["TD-1"], "core/money.ts", "billing/invoice.ts"),
      commit(["TD-2"], "core/money.ts", "auth/session.ts"),
      commit(["TD-3"], "ui/form.ts", "auth/token.ts"),
      commit(["TD-4"], "core/money.ts", "ui/button.ts"),
    ]);
    expect(modules[0].module).toBe("core");
    expect(modules[0].reasons).toHaveLength(3);
  });

  it("is unavailable below the task-id commit share floor and names the share", () => {
    const commits = [
      commit(["TD-1"], "core/money.ts", "billing/invoice.ts"),
      commit([], "core/money.ts"),
      commit([], "auth/session.ts"),
      commit([], "ui/form.ts"),
    ];
    expect(extractChangeReasons({ commits, componentOf })).toEqual({
      available: false,
      unavailable: {
        reason: "noTicketDiscipline",
        taskIdCommitShare: 0.25,
        minTaskIdCommitShare: CHANGE_REASON_MIN_TASK_ID_COMMIT_SHARE,
      },
    });
  });

  it("is available at the floor and carries the share", () => {
    const extraction = extractChangeReasons({
      commits: [commit(["TD-1"], "core/money.ts"), commit([], "core/money.ts")],
      componentOf,
    });
    expect(extraction.available).toBe(true);
    expect(extraction.available && extraction.taskIdCommitShare).toBe(0.5);
  });

  it("is unavailable on an empty history", () => {
    expect(extractChangeReasons({ commits: [], componentOf }).available).toBe(false);
  });
});
