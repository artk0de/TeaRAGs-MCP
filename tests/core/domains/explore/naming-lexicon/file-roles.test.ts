/**
 * buildDependencyNormFileRoles (bd tea-rags-mcp-rpx0v): the file→role map
 * dependency norms judge by. The file carries its PRIMARY type's role — the
 * type the file is named for, never a secondary one — and a project-suffix
 * assignment stays weak, because suffix evidence confirms a role without
 * asserting it (naming's entry gate).
 */
import { describe, expect, it } from "vitest";

import type { TypeNameRow } from "../../../../../src/core/contracts/types/codegraph-storage.js";
import {
  buildDependencyNormFilePrimaryTypes,
  buildDependencyNormFileRoles,
} from "../../../../../src/core/domains/explore/naming-lexicon/file-roles.js";
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

/**
 * Architectural roles over domain nouns (bd tea-rags-mcp-xb669.6): measured on
 * taxdome, models carried their class's head noun (`field`, `template`,
 * `user`), service objects their verb (`update`, `create`), and hooks /
 * components the suffix of the type describing their I/O (`params`, `props`)
 * — so each architectural kind scattered into singleton role pairs.
 */
describe("buildDependencyNormFileRoles — architectural roles (xb669.6)", () => {
  function typed(
    relPath: string,
    shortName: string,
    ancestors: string[] = [],
    symbolKind: TypeNameRow["symbolKind"] = "class",
  ): TypeNameRow {
    return { symbolId: shortName, relPath, shortName, symbolKind, ancestors };
  }

  it("gives every member of a LARGE inheritance family that family's one role, whatever its head noun", () => {
    const rows = [
      typed("app/models/application_record.rb", "ApplicationRecord", ["ActiveRecord::Base"]),
      typed("app/models/crm/custom_field.rb", "CustomField", ["ApplicationRecord"]),
      typed("app/models/getting_paid/contract_template.rb", "ContractTemplate", ["ApplicationRecord"]),
      typed("app/models/user.rb", "User", ["ApplicationRecord"]),
      typed("app/models/tech/sms_code.rb", "SmsCode", ["ApplicationRecord"]),
      typed("app/models/firm.rb", "Firm", ["ApplicationRecord"]),
      typed("app/models/getting_paid/invoice_item.rb", "InvoiceItem", ["ApplicationRecord"]),
      // A grandchild through a small intermediate base still belongs to the family.
      typed("app/models/getting_paid/proposal_template.rb", "ProposalTemplate", ["ApplicationRecord"]),
      typed("app/models/getting_paid/package_template.rb", "PackageTemplate", ["ProposalTemplate"]),
      // A small split family is no architectural kind: it keeps what it had.
      typed("app/lib/a/left_thing.rb", "LeftThing", ["Pair"]),
      typed("app/lib/b/right_item.rb", "RightItem", ["Pair"]),
    ];
    const roles = buildDependencyNormFileRoles(rows);

    for (const relPath of [
      "app/models/crm/custom_field.rb",
      "app/models/getting_paid/contract_template.rb",
      "app/models/user.rb",
      "app/models/tech/sms_code.rb",
      "app/models/getting_paid/package_template.rb",
    ]) {
      expect(roles.get(relPath), relPath).toEqual({ role: "record", strong: true });
    }
    expect(roles.get("app/lib/a/left_thing.rb")?.role).not.toBe("pair");
  });

  it("lets a CONVENTIONAL directory's role beat a head-noun role beneath it", () => {
    const rows = [
      typed("app/services/billing/charge_service.rb", "ChargeService"),
      typed("app/services/billing/refund_service.rb", "RefundService"),
      typed("app/services/crm/merge_service.rb", "MergeService"),
      typed("app/services/getting_paid/proposals/update.rb", "Update"),
      typed("app/services/getting_paid/proposals/sync_worker.rb", "SyncWorker"),
      typed("app/lib/getting_paid/update.rb", "Update"),
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      assignment("ChargeService", "app/services/billing/charge_service.rb", "service", "directory"),
      assignment("RefundService", "app/services/billing/refund_service.rb", "service", "directory"),
      assignment("MergeService", "app/services/crm/merge_service.rb", "service", "directory"),
      assignment("Update", "app/services/getting_paid/proposals/update.rb", "update", "directory"),
      assignment("SyncWorker", "app/services/getting_paid/proposals/sync_worker.rb", "worker", "inheritance"),
      assignment("Update", "app/lib/getting_paid/update.rb", "update", "directory"),
    ]);

    // `services` is conventional: most role-bearing files beneath it are services,
    // and the directory names that role. A verb head noun beneath it yields.
    expect(roles.get("app/services/getting_paid/proposals/update.rb")).toEqual({ role: "service", strong: true });
    // Inheritance evidence is stronger than a directory convention.
    expect(roles.get("app/services/getting_paid/proposals/sync_worker.rb")).toEqual({ role: "worker", strong: true });
    // Outside the conventional directory nothing changes.
    expect(roles.get("app/lib/getting_paid/update.rb")).toEqual({ role: "update", strong: true });
  });

  it("weakens a role read off a type that only shapes the file's function I/O", () => {
    const rows = [
      typed("modules/hooks/useLoadThreads.ts", "UseLoadThreadsParams", [], "type_alias"),
      typed("modules/components/Select/Select.tsx", "SelectProps", [], "interface"),
      typed("modules/types/InvoiceSidebarContext.ts", "InvoiceSidebarContext", [], "interface"),
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      assignment("UseLoadThreadsParams", "modules/hooks/useLoadThreads.ts", "params", "directory"),
      assignment("SelectProps", "modules/components/Select/Select.tsx", "props", "directory"),
      assignment("InvoiceSidebarContext", "modules/types/InvoiceSidebarContext.ts", "context", "directory"),
    ]);

    // The file is named for its function (`useLoadThreads`, `Select`); the type
    // is that function's parameter / props shape — no architectural role.
    expect(roles.get("modules/hooks/useLoadThreads.ts")).toEqual({
      role: "params",
      strong: false,
      weakReason: "ioShape",
    });
    expect(roles.get("modules/components/Select/Select.tsx")).toEqual({
      role: "props",
      strong: false,
      weakReason: "ioShape",
    });
    // A shape type the file IS named for is the file's subject.
    expect(roles.get("modules/types/InvoiceSidebarContext.ts")).toEqual({ role: "context", strong: true });
  });

  it("weakens an anonymous shape (`type Props`) and keeps a shape the stem's hook wraps", () => {
    const rows = [
      typed("modules/components/PinModal/PinModal.tsx", "Props", [], "type_alias"),
      typed("modules/stores/useSidebarsStore.ts", "SidebarsStore", [], "type_alias"),
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      assignment("Props", "modules/components/PinModal/PinModal.tsx", "props", "directory"),
      assignment("SidebarsStore", "modules/stores/useSidebarsStore.ts", "store", "directory"),
    ]);

    // `Props` shares no word with `PinModal`: the file is named for the component it shapes.
    expect(roles.get("modules/components/PinModal/PinModal.tsx")).toEqual({
      role: "props",
      strong: false,
      weakReason: "ioShape",
    });
    // `useSidebarsStore` wraps the `SidebarsStore` it is named for — the store IS the subject.
    expect(roles.get("modules/stores/useSidebarsStore.ts")).toEqual({ role: "store", strong: true });
  });

  it("keeps a nearer inheritance family's role inside a large family split over unrelated bases", () => {
    const rows = [
      ...["sms", "chat", "seats"].map((d) =>
        typed(`app/services/api/contracts/${d}/result.rb`, "Result", ["Api::Contracts::Results::Base"]),
      ),
      ...["Task", "Stage", "Pipeline", "Client"].map((name) =>
        typed(`lib/seed/${name.toLowerCase()}.rb`, name, ["Seed::Base"]),
      ),
    ];
    const roles = buildDependencyNormFileRoles(rows);

    // `Base` by last segment pools two unrelated bases; the written family
    // `Api::Contracts::Results::Base` already names its members `result`.
    expect(roles.get("app/services/api/contracts/sms/result.rb")).toEqual({ role: "result", strong: true });
  });
});

describe("buildDependencyNormFilePrimaryTypes (xb669.6)", () => {
  it("names each file's primary type by its last namespace segment", () => {
    const rows = [
      row("s1", "app/lib/ai/adapters/base_adapter.rb", "Ai::Adapters::BaseAdapter"),
      row("s2", "app/lib/ai/adapters/base_adapter.rb", "RateLimitError"),
    ];
    expect(buildDependencyNormFilePrimaryTypes(rows).get("app/lib/ai/adapters/base_adapter.rb")).toBe("BaseAdapter");
  });
});
