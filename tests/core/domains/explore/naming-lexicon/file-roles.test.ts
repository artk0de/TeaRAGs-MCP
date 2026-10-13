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
    // A class's first named ancestor is its superclass; anything else a row names
    // (a module's `include`, a class's later mixins) is a mixin.
    const superclass = symbolKind === "class" ? ancestors[0] : undefined;
    return { symbolId: shortName, relPath, shortName, symbolKind, ancestors, ...(superclass ? { superclass } : {}) };
  }

  it("never forms a role family from a mixin: only the superclass names a kind (xb669.6 owner decision)", () => {
    const domains = ["sms", "chat", "seats", "billing", "crm", "tasks", "proposals", "invoices"];
    const title = (d: string) => `${d[0]?.toUpperCase() ?? ""}${d.slice(1)}`;
    const rows = [
      // Eight API modules `include Api::Contracts::Enforcement` — a capability, not a kind.
      ...domains.map((d) => ({
        ...typed(`app/services/${d}/api/client.rb`, `${title(d)}Client`, [], "module"),
        ancestors: ["Api::Contracts::Enforcement"],
      })),
      // Classes subclassing a base AND including the same mixin: the superclass is the kind.
      ...domains.map((d) =>
        typed(`app/models/${d}_thing.rb`, `${title(d)}Thing`, ["ApplicationRecord", "Api::Contracts::Enforcement"]),
      ),
      typed("app/models/application_record.rb", "ApplicationRecord", ["ActiveRecord::Base"]),
    ];
    const roles = buildDependencyNormFileRoles(rows);

    for (const d of domains) {
      expect(roles.get(`app/services/${d}/api/client.rb`)?.role, d).not.toBe("enforcement");
      // The superclass family's majority head — never the mixin family's.
      expect(roles.get(`app/models/${d}_thing.rb`), d).toEqual({ role: "thing", strong: true });
    }
  });

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

/**
 * A head noun asserts a role only where the role LIVES (bd tea-rags-mcp-4vj2u,
 * xb669.8 gold set): taxdome's `helper` lumped Rails view mixins under
 * `app/helpers`, `class << self` utilities under `lib/helpers` and module
 * calculators under `app/lib` — 17 FALSE and 6 DOUBTFUL of 51 MISFITs. A role
 * read off a head noun stays strong (ledger precedent) but is DISPLACED — no
 * edge touching it carries a verdict — when the file sits outside every
 * conventional directory of its role, or is called on the type itself while
 * the role's home carriers are called on instances.
 */
describe("buildDependencyNormFileRoles — role homes (4vj2u)", () => {
  function shaped(relPath: string, shortName: string, instance: number, singleton: number): TypeNameRow {
    return {
      symbolId: shortName,
      relPath,
      shortName,
      symbolKind: "module",
      ancestors: [],
      instanceMethodCount: instance,
      singletonMethodCount: singleton,
    };
  }
  const helperRows = [
    // The home: a conventional `helpers` directory of view mixins.
    shaped("app/helpers/firms_helper.rb", "FirmsHelper", 9, 2),
    shaped("app/helpers/clients_helper.rb", "ClientsHelper", 4, 0),
    shaped("app/helpers/tasks_helper.rb", "TasksHelper", 3, 0),
    // A `class << self` namespace of functions inside the home.
    shaped("app/helpers/schedule_helper.rb", "ScheduleHelper", 0, 3),
    // Named like a helper, outside every `helpers` directory.
    shaped("app/lib/billing/fee_helper.rb", "FeeHelper", 5, 0),
    shaped("app/lib/billing/tax_helper.rb", "TaxHelper", 2, 0),
  ];
  const helperAssignments = helperRows.map((r) => assignment(r.symbolId, r.relPath, "helper", "directory"));

  it("keeps a carrier at its role's home with its home's call shape", () => {
    const roles = buildDependencyNormFileRoles(helperRows, helperAssignments);

    expect(roles.get("app/helpers/firms_helper.rb")).toEqual({ role: "helper", strong: true });
    expect(roles.get("app/helpers/clients_helper.rb")).toEqual({ role: "helper", strong: true });
  });

  it("displaces a head-noun role outside every conventional directory of that role", () => {
    const roles = buildDependencyNormFileRoles(helperRows, helperAssignments);

    expect(roles.get("app/lib/billing/fee_helper.rb")).toEqual({
      role: "helper",
      strong: true,
      displaced: "outsideRoleHome",
    });
  });

  it("displaces a namespace of functions among a home of instance-called carriers", () => {
    const roles = buildDependencyNormFileRoles(helperRows, helperAssignments);

    expect(roles.get("app/helpers/schedule_helper.rb")).toEqual({
      role: "helper",
      strong: true,
      displaced: "callShape",
    });
  });

  it("never displaces inheritance evidence, a role with no home, or a carrier of unknown shape", () => {
    const rows = [
      ...helperRows,
      { ...shaped("app/lib/billing/sync_worker.rb", "SyncWorker", 0, 1), symbolKind: "class" as const },
      shaped("app/lib/billing/period_update.rb", "PeriodUpdate", 0, 2),
      { ...shaped("app/helpers/legacy_helper.rb", "LegacyHelper", 0, 0), instanceMethodCount: undefined },
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      ...helperAssignments,
      assignment("SyncWorker", "app/lib/billing/sync_worker.rb", "worker", "inheritance"),
      assignment("PeriodUpdate", "app/lib/billing/period_update.rb", "update", "directory"),
      assignment("LegacyHelper", "app/helpers/legacy_helper.rb", "helper", "directory"),
    ]);

    expect(roles.get("app/lib/billing/sync_worker.rb")).toEqual({ role: "worker", strong: true });
    expect(roles.get("app/lib/billing/period_update.rb")).toEqual({ role: "update", strong: true });
    expect(roles.get("app/helpers/legacy_helper.rb")).toEqual({ role: "helper", strong: true });
  });
});

describe("buildDependencyNormFileRoles — conventional directory promotes an already-matching weak role (8up12)", () => {
  const dirRows = ["a", "b", "c"].map((d) => ({
    symbolId: `${d}Helper`,
    relPath: `app/helpers/${d}/${d}_helper.rb`,
    shortName: `${d.toUpperCase()}Helper`,
    symbolKind: "module" as const,
    ancestors: [],
  }));
  const carriers = dirRows.map((r) => assignment(r.symbolId, r.relPath, "helper", "directory"));

  it("promotes a projectSuffix role equal to the conventional role to strong, evidence directory", () => {
    const rows = [
      ...dirRows,
      { ...dirRows[0], symbolId: "xHelper", relPath: "app/helpers/x/foo_helper.rb", shortName: "FooHelper" },
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      ...carriers,
      assignment("xHelper", "app/helpers/x/foo_helper.rb", "helper", "projectSuffix"),
    ]);

    expect(roles.get("app/helpers/x/foo_helper.rb")).toEqual({ role: "helper", strong: true });
  });

  it("keeps an ioShape-weakened entry weak under a conventional directory", () => {
    const rows = [
      ...dirRows,
      {
        symbolId: "FooProps",
        relPath: "app/helpers/foo.ts",
        shortName: "FooProps",
        symbolKind: "type_alias" as const,
        ancestors: [],
      },
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      ...carriers,
      assignment("FooProps", "app/helpers/foo.ts", "props", "directory"),
    ]);

    expect(roles.get("app/helpers/foo.ts")).toMatchObject({ strong: false, weakReason: "ioShape" });
  });

  it("leaves an inheritance entry unchanged", () => {
    const rows = [
      ...dirRows,
      { ...dirRows[0], symbolId: "wWorker", relPath: "app/helpers/w/sync_worker.rb", shortName: "SyncWorker" },
    ];
    const roles = buildDependencyNormFileRoles(rows, [
      ...carriers,
      assignment("wWorker", "app/helpers/w/sync_worker.rb", "worker", "inheritance"),
    ]);

    expect(roles.get("app/helpers/w/sync_worker.rb")).toEqual({ role: "worker", strong: true });
  });
});

describe("buildDependencyNormFileRoles — ancestor-confirmed conventional directories (8up12 part 2)", () => {
  /** A class row: `superclass` is its kind; every other ancestor is a mixin / implemented interface. */
  function declared(
    relPath: string,
    shortName: string,
    { mixins = [], superclass }: { mixins?: string[]; superclass?: string } = {},
    symbolKind: TypeNameRow["symbolKind"] = "class",
  ): TypeNameRow {
    return {
      symbolId: shortName,
      relPath,
      shortName,
      symbolKind,
      ancestors: [...(superclass ? [superclass] : []), ...mixins],
      ...(superclass ? { superclass } : {}),
    };
  }
  const service = { mixins: ["KindOfService"] };
  const services = [
    declared("app/services/a/create_invoice.rb", "CreateInvoice", service),
    declared("app/services/a/update_client.rb", "UpdateClient", service),
    declared("app/services/b/create_task.rb", "CreateTask", service),
    declared("app/services/b/archive_job.rb", "ArchiveJob", service),
  ];

  it("confirms a directory whose name is a majority mixin's head: its carriers, untyped ones included, take the role strong", () => {
    const untyped = declared("app/services/b/qux.rb", "Qux", service);
    const roles = buildDependencyNormFileRoles([...services, untyped]);

    for (const { relPath } of [...services, untyped]) {
      expect(roles.get(relPath), relPath).toEqual({ role: "service", strong: true });
    }
  });

  it("gives the role to the confirming ancestor's carriers only — a file without it keeps its own role", () => {
    const outsider = declared("app/services/a/report_builder.rb", "ReportBuilder");
    const without = buildDependencyNormFileRoles([outsider]).get(outsider.relPath);
    const roles = buildDependencyNormFileRoles([...services, outsider]);

    expect(roles.get(outsider.relPath)).toEqual(without);
    expect(roles.get(services[0]?.relPath ?? "")).toEqual({ role: "service", strong: true });
  });

  it("never confirms a directory whose name is not the mixin's head", () => {
    const domains = ["sms", "chat", "seats", "billing"];
    const clients = domains.map((d) =>
      declared(`app/services/${d}/api/${d}_client.rb`, `${d.toUpperCase()}Client`, {
        mixins: ["Api::Contracts::Enforcement"],
      }),
    );
    const roles = buildDependencyNormFileRoles(clients);

    for (const { relPath } of clients) expect(roles.get(relPath)?.role, relPath).not.toBe("api");
  });

  it("lets a domain-noun subdirectory inherit the confirmed role from its ancestor directory, never its own name", () => {
    const billing = [
      declared("app/services/growth_billing/charge_card.rb", "ChargeCard", service),
      declared("app/services/growth_billing/refund_payment.rb", "RefundPayment", service),
      declared(
        "app/services/growth_billing/subscription_payment_date_update_service.rb",
        "SubscriptionPaymentDateUpdate",
        service,
      ),
    ];
    const roles = buildDependencyNormFileRoles([...services, ...billing]);

    for (const { relPath } of billing) expect(roles.get(relPath), relPath).toEqual({ role: "service", strong: true });
  });

  it("does not confirm a directory where the ancestor's carriers are under the directory share", () => {
    const rows = [
      declared("app/services/a/create_invoice.rb", "CreateInvoice", service),
      declared("app/services/b/create_task.rb", "CreateTask", service),
      declared("app/services/a/report_builder.rb", "ReportBuilder"),
      declared("app/services/b/invoice_presenter.rb", "InvoicePresenter"),
      declared("app/services/c/payment_gateway.rb", "PaymentGateway"),
    ];
    const roles = buildDependencyNormFileRoles(rows);

    expect(roles.get("app/services/a/create_invoice.rb")?.role).not.toBe("service");
    expect(roles.get("app/services/b/create_task.rb")?.role).not.toBe("service");
  });

  it("leaves an inheritance-family file under a confirmed directory with its family role", () => {
    const widget = { mixins: ["BaseWidget"] };
    const rows = [
      declared("app/widgets/a/sales_chart.rb", "SalesChart", widget),
      declared("app/widgets/a/team_list.rb", "TeamList", widget),
      declared("app/widgets/b/inbox_feed.rb", "InboxFeed", widget),
      declared("app/widgets/b/stored_layout.rb", "StoredLayout", {
        superclass: "ApplicationRecord",
        mixins: ["BaseWidget"],
      }),
      declared("app/models/invoice.rb", "Invoice", { superclass: "ApplicationRecord" }),
      declared("app/models/client.rb", "Client", { superclass: "ApplicationRecord" }),
      declared("app/models/firm.rb", "Firm", { superclass: "ApplicationRecord" }),
    ];
    const roles = buildDependencyNormFileRoles(rows);

    expect(roles.get("app/widgets/a/sales_chart.rb")).toEqual({ role: "widget", strong: true });
    expect(roles.get("app/widgets/b/stored_layout.rb")).toEqual({ role: "record", strong: true });
  });

  it("keeps an ioShape entry weak under a confirmed directory", () => {
    const props = declared("app/services/b/foo.ts", "FooProps", service, "type_alias");
    const roles = buildDependencyNormFileRoles(
      [...services, props],
      [
        ...services.map((r) => assignment(r.symbolId, r.relPath, "service", "projectSuffix")),
        assignment("FooProps", props.relPath, "props", "directory"),
      ],
    );

    expect(roles.get(props.relPath)).toMatchObject({ strong: false, weakReason: "ioShape" });
  });

  it("confirms a directory from an implemented interface: implementers take its role, a sibling without it keeps its own", () => {
    const migration = { mixins: ["Migration"] };
    const rows = [
      declared("src/maintenance/migration/steps/add-index.ts", "AddIndexStep", migration),
      declared("src/maintenance/migration/steps/drop-field.ts", "DropLegacyField", migration),
      declared("src/maintenance/migration/steps/rename-key.ts", "RenamePayloadKey", migration),
      declared("src/maintenance/migration/schema-migrator.ts", "SchemaMigrator"),
      declared("src/ingest/snapshot-migrator.ts", "SnapshotMigrator"),
      declared("src/explore/stats-migrator.ts", "StatsMigrator"),
    ];
    const roles = buildDependencyNormFileRoles(rows);

    for (const { relPath } of rows.slice(0, 3)) {
      expect(roles.get(relPath), relPath).toEqual({ role: "migration", strong: true });
    }
    expect(roles.get("src/maintenance/migration/schema-migrator.ts")?.role).toBe("migrator");
  });
});

describe("buildDependencyNormFileRoles — a written supertype resolves against its writer's namespace (9okcg)", () => {
  /** A class declared under its full `symbolId`, its superclass written as the source spells it. */
  function nested(relPath: string, symbolId: string, superclass?: string): TypeNameRow {
    const shortName = symbolId.slice(symbolId.lastIndexOf("::") + 2);
    return {
      symbolId,
      relPath,
      shortName,
      symbolKind: "class",
      ancestors: superclass === undefined ? [] : [superclass],
      ...(superclass === undefined ? {} : { superclass }),
    };
  }
  const pathOf = (symbolId: string) => `lib/${symbolId.toLowerCase().replaceAll("::", "/")}.rb`;
  const at = (symbolId: string, superclass?: string) => nested(pathOf(symbolId), symbolId, superclass);

  it("never lets a same-named base in another namespace lend its superclass to unrelated families", () => {
    const rows = [
      at("Results::Base", "Ext::Value"),
      at("Money", "Ext::Value"),
      at("Period", "Ext::Value"),
      at("Address", "Ext::Value"),
      // Two small, unrelated `Base` families — neither declares a superclass.
      at("Seed::Base"),
      at("Seed::TaskSeed", "Seed::Base"),
      at("Seed::StageLoader", "Seed::Base"),
      at("Admin::Base"),
      at("Admin::RefundAction", "Admin::Base"),
      at("Admin::AuditPage", "Admin::Base"),
    ];
    const roles = buildDependencyNormFileRoles(rows, []);

    for (const symbolId of ["Money", "Period", "Address"]) {
      expect(roles.get(pathOf(symbolId)), symbolId).toEqual({ role: "value", strong: true });
    }
    for (const symbolId of ["Seed::TaskSeed", "Seed::StageLoader", "Admin::RefundAction", "Admin::AuditPage"]) {
      expect(roles.get(pathOf(symbolId))?.role, symbolId).not.toBe("value");
    }
  });

  it("resolves a relative supertype through the writer's enclosing namespaces and keeps hopping", () => {
    const rows = [
      at("Billing::Handlers::Base", "Ext::Event"),
      at("Billing::Handlers::AccessRestored", "Handlers::Base"),
      at("Billing::Handlers::PlanChanged", "Handlers::Base"),
      at("Signup", "Ext::Event"),
      at("Payout", "Ext::Event"),
    ];
    const roles = buildDependencyNormFileRoles(rows, []);

    for (const symbolId of ["Billing::Handlers::AccessRestored", "Billing::Handlers::PlanChanged"]) {
      expect(roles.get(pathOf(symbolId)), symbolId).toEqual({ role: "event", strong: true });
    }
  });

  it("takes the INNERMOST declaration of a written name, never a namesake further out", () => {
    const rows = [
      at("Shop::Orders::Base", "Ext::Inner"),
      at("Shop::Orders::Checkout", "Base"),
      at("Shop::Orders::Refund", "Base"),
      at("Base", "Ext::Outer"),
      at("Ledger", "Ext::Outer"),
      at("Journal", "Ext::Outer"),
      at("Account", "Ext::Outer"),
    ];
    const roles = buildDependencyNormFileRoles(rows, []);

    for (const symbolId of ["Shop::Orders::Checkout", "Shop::Orders::Refund"]) {
      expect(roles.get(pathOf(symbolId)), symbolId).toEqual({ role: "inner", strong: true });
    }
    for (const symbolId of ["Ledger", "Journal", "Account"]) {
      expect(roles.get(pathOf(symbolId)), symbolId).toEqual({ role: "outer", strong: true });
    }
  });

  it("treats a supertype no row declares as an external leaf: no hop through a same-named declared type", () => {
    const rows = [
      at("Lib::Base", "Ext::Wrong"),
      at("Lib::Alpha", "Ext::Wrong"),
      at("Lib::Beta", "Ext::Wrong"),
      // `Vendor::Base` is no project type — the hop stops at it.
      at("Sync::PushJob", "Vendor::Base"),
      at("Sync::PullTask", "Vendor::Base"),
    ];
    const roles = buildDependencyNormFileRoles(rows, []);

    for (const symbolId of ["Sync::PushJob", "Sync::PullTask"]) {
      expect(roles.get(pathOf(symbolId))?.role, symbolId).not.toBe("wrong");
    }
  });

  it("resolves each further hop against the type that WROTE it, not against the original row", () => {
    const rows = [
      at("Crm::Base", "Ext::Near"),
      at("Crm::Mid", "Base"),
      at("Reports::DailyDigest", "Crm::Mid"),
      at("Pipe", "Ext::Near"),
      at("Base", "Ext::Far"),
      at("Tray", "Ext::Far"),
      at("Shelf", "Ext::Far"),
      at("Crate", "Ext::Far"),
    ];
    const roles = buildDependencyNormFileRoles(rows, []);

    // `Crm::Mid` writes `Base` inside `Crm` — `Crm::Base`, whatever namespace the subclass sits in.
    expect(roles.get(pathOf("Reports::DailyDigest"))).toEqual({ role: "near", strong: true });
  });

  it("never resolves a written supertype to its own writer: a namespaced base naming the outer one hops past itself", () => {
    const rows = [
      at("Model", "Ext::Rec"),
      at("Invoice", "Ext::Rec"),
      at("Payment", "Ext::Rec"),
      // `class Risk::Model < Model` names the top-level `Model`, not itself.
      at("Risk::Model", "Model"),
      at("Risk::ScoreSnapshot", "Risk::Model"),
    ];
    const roles = buildDependencyNormFileRoles(rows, []);

    expect(roles.get(pathOf("Risk::ScoreSnapshot"))).toEqual({ role: "rec", strong: true });
  });

  it("terminates on a supertype cycle the rows declare", () => {
    const rows = [at("Loop::Left", "Right"), at("Loop::Right", "Left")];

    expect(() => buildDependencyNormFileRoles(rows, [])).not.toThrow();
  });
});
