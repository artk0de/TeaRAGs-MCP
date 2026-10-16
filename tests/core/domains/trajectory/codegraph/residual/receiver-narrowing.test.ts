import { describe, expect, it } from "vitest";

import type {
  CallRef,
  GlobalSymbolTable,
  HierarchyQuery,
  HierarchyView,
  InheritanceEdge,
  InheritanceKind,
  SymbolDefinition,
  SymbolLookupOptions,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  DEFAULT_RESIDUAL_MENU_LIMIT,
  residualMenuHash,
  ResidualSiteCollector,
  type ResidualVerdictView,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";

function def(symbolId: string, relPath: string, isSchemaColumn = false): SymbolDefinition {
  const shortName = symbolId.split(/[#.]/).pop() ?? symbolId;
  const d: SymbolDefinition = { symbolId, fqName: symbolId, shortName, relPath, scope: [] };
  if (isSchemaColumn) d.isSchemaColumn = true;
  return d;
}

function tableOf(defs: SymbolDefinition[]): Pick<GlobalSymbolTable, "lookupByShortName"> {
  return {
    lookupByShortName: (name: string, options?: SymbolLookupOptions) =>
      defs.filter((d) => d.shortName === name && (options?.includeSchemaColumns === true || d.isSchemaColumn !== true)),
  };
}

/** `[descendant, ancestor, kind]` rows; getDescendants answers transitively with depth. */
function hierarchyOf(rows: [string, string, InheritanceKind][]): HierarchyView {
  const getDescendants = (fqName: string, opts?: HierarchyQuery): InheritanceEdge[] => {
    const out: InheritanceEdge[] = [];
    const visit = (ancestor: string, depth: number): void => {
      for (const [source, anc, kind] of rows) {
        if (anc !== ancestor) continue;
        if (opts?.kinds !== undefined && !opts.kinds.includes(kind)) continue;
        out.push({ sourceFqName: source, ancestorFqName: fqName, ancestorSymbolId: null, kind, depth });
        if (opts?.transitive === true) visit(source, depth + 1);
      }
    };
    visit(fqName, 1);
    return out;
  };
  return { getAncestors: () => [], getDescendants };
}

const METHOD = { symbolId: "Billing#run", startLine: 10, endLine: 30 };
const DYNAMIC_MISS: ResidualVerdictView = {
  receiverKind: "dynamic",
  outcome: "unresolved",
  missBucket: "missWithInProjectDef",
};

function call(receiver: string, member: string, line: number): CallRef {
  return { callText: `${receiver}.${member}`, receiver, member, startLine: line, startColumn: 4 };
}

const BASE_DEFS = [
  def("Invoice#number", "app/models/invoice.rb"),
  def("Estimate#number", "app/models/estimate.rb"),
  def("Payment#firm_id", "app/models/payment.rb"),
  def("Invoice#firm_id", "db/schema.rb", true),
];

function collectorOf(defs: SymbolDefinition[], hierarchy?: HierarchyView): ResidualSiteCollector {
  return new ResidualSiteCollector("app/services/billing.rb", tableOf(defs), DEFAULT_RESIDUAL_MENU_LIMIT, "ruby", {
    hierarchy,
  });
}

describe("ResidualSiteCollector — receiver narrowing", () => {
  it("narrows `r.firm_id; r.number` to Invoice and settles the site as a static edge", () => {
    const collector = collectorOf(BASE_DEFS);

    collector.observe(METHOD, call("r", "firm_id", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "number", 13), DYNAMIC_MISS);

    expect(collector.narrowed()).toEqual([
      {
        receiverKind: "dynamic",
        edge: {
          sourceSymbolId: "Billing#run",
          targetSymbolId: "Invoice#number",
          targetRelPath: "app/models/invoice.rb",
          callExpression: "r.number",
        },
      },
    ]);
    // The column read narrows to Invoice too, but its callee is the column accessor: excluded.
    expect(collector.rows()).toEqual([]);
    expect(collector.excluded().schemaColumn).toBe(1);
    expect(collector.narrowEmptyKinds()).toEqual([]);
  });

  it("tags a group's rows with one receiver group and its class set, each class with the target it reaches", () => {
    const defs = [
      def("Invoice#save", "app/models/invoice.rb"),
      def("Invoice#title", "app/models/invoice.rb"),
      def("Document#save", "app/models/document.rb"),
      def("Bill#title", "app/models/bill.rb"),
      def("Estimate#save", "app/models/estimate.rb"),
      def("Estimate#title", "app/models/estimate.rb"),
    ];
    const collector = collectorOf(defs, hierarchyOf([["Bill", "Document", "super"]]));

    collector.observe(METHOD, call("rec", "save", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("rec", "title", 13), DYNAMIC_MISS);

    const rows = collector.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0].receiverGroup).toMatch(/^[0-9a-f]{40}$/);
    expect(rows[1].receiverGroup).toBe(rows[0].receiverGroup);
    expect(rows.find((r) => r.member === "save")?.classTargets).toEqual([
      ["Bill", "Document#save"],
      ["Estimate", "Estimate#save"],
      ["Invoice", "Invoice#save"],
    ]);
    expect(rows.find((r) => r.member === "title")?.classTargets).toEqual([
      ["Bill", "Bill#title"],
      ["Estimate", "Estimate#title"],
      ["Invoice", "Invoice#title"],
    ]);
  });

  it("orders a group's class set by the receiver's naming prior and keeps it uncut past the menu limit", () => {
    const defs = Array.from({ length: 45 }, (_, i) => def(`K${String(i).padStart(2, "0")}#save`, "app/k.rb"));
    defs.push(def("Invoice#save", "app/models/invoice.rb"));
    const collector = collectorOf(defs);

    collector.observe(METHOD, call("invoice", "save", 12), DYNAMIC_MISS);

    const [row] = collector.rows();
    expect(row.menuOverflow).toBe(true);
    expect(row.classTargets).toHaveLength(46);
    expect(row.classTargets?.[0]).toEqual(["Invoice", "Invoice#save"]);
  });

  it("keeps two receivers apart when the local is reassigned between the calls", () => {
    const collector = collectorOf(BASE_DEFS);
    const method = { ...METHOD, localAssignmentLines: { r: [14] } };

    collector.observe(method, call("r", "number", 13), DYNAMIC_MISS);
    collector.observe(method, call("r", "firm_id", 15), DYNAMIC_MISS);

    expect(collector.narrowed().map((n) => n.edge.targetSymbolId)).toEqual([]);
    const numberRow = collector.rows().find((row) => row.member === "number");
    expect(numberRow?.candidates).toEqual(["Estimate#number", "Invoice#number"]);
  });

  it("counts a member inherited through a superclass", () => {
    const defs = [...BASE_DEFS, def("Document#total", "app/models/document.rb")];
    const collector = collectorOf(defs, hierarchyOf([["Invoice", "Document", "super"]]));

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "number", 13), DYNAMIC_MISS);

    expect(collector.narrowed().map((n) => n.edge.targetSymbolId)).toEqual(["Document#total", "Invoice#number"]);
    expect(collector.rows()).toEqual([]);
  });

  it("counts a member brought in by an included concern", () => {
    const defs = [...BASE_DEFS, def("Billable#total", "app/models/concerns/billable.rb")];
    const collector = collectorOf(defs, hierarchyOf([["Invoice", "Billable", "include"]]));

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "number", 13), DYNAMIC_MISS);

    expect(collector.narrowed().map((n) => n.edge.targetSymbolId)).toEqual(["Billable#total", "Invoice#number"]);
  });

  it("does not let a member classified external constrain the receiver", () => {
    const defs = [...BASE_DEFS, def("Importer#save!", "app/services/importer.rb")];
    const collector = collectorOf(defs);

    collector.observe(METHOD, call("r", "save!", 12), {
      receiverKind: "dynamic",
      outcome: "unresolved",
      missBucket: "externalSkipped",
    });
    collector.observe(METHOD, call("r", "firm_id", 13), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "number", 14), DYNAMIC_MISS);

    expect(collector.narrowed().map((n) => n.edge.targetSymbolId)).toEqual(["Invoice#number"]);
  });

  it("keeps the single-member menu when the constraints intersect to no class", () => {
    const defs = [...BASE_DEFS, def("Importer#save!", "app/services/importer.rb")];
    const collector = collectorOf(defs);

    collector.observe(METHOD, call("r", "save!", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "number", 13), DYNAMIC_MISS);

    const numberRow = collector.rows().find((row) => row.member === "number");
    expect(numberRow?.candidates).toEqual(["Estimate#number", "Invoice#number"]);
    expect(collector.narrowed()).toEqual([]);
    expect(collector.narrowEmptyKinds()).toEqual(["dynamic", "dynamic"]);
  });

  it("never edges a member one class answers on its own, however the other calls agree", () => {
    const defs = [
      def("TaskHelper.filter", "app/helpers/task_helper.rb"),
      def("TaskHelper.map", "app/helpers/task_helper.rb"),
    ];
    const collector = collectorOf(defs);

    collector.observe(METHOD, call("items", "filter", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("items", "map", 13), DYNAMIC_MISS);

    expect(collector.narrowed()).toEqual([]);
    expect(collector.rows().map((row) => row.candidates)).toEqual([["TaskHelper.filter"], ["TaskHelper.map"]]);
  });

  it("does not narrow a self receiver", () => {
    const collector = collectorOf(BASE_DEFS);

    collector.observe(METHOD, call("self", "firm_id", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("self", "number", 13), DYNAMIC_MISS);

    expect(collector.narrowed()).toEqual([]);
    expect(collector.rows().find((row) => row.member === "number")?.candidates).toEqual([
      "Estimate#number",
      "Invoice#number",
    ]);
  });

  it("orders a narrowed menu by the receiver's naming prior without dropping a candidate", () => {
    const collector = collectorOf(BASE_DEFS);

    collector.observe(METHOD, call("invoice", "number", 12), DYNAMIC_MISS);

    expect(collector.rows()[0]?.candidates).toEqual(["Invoice#number", "Estimate#number"]);
  });

  it("computes overflow after narrowing", () => {
    const many = Array.from({ length: 5 }, (_, i) => def(`Model${i}#number`, `app/models/model${i}.rb`));
    const defs = [...many, def("Model0#total", "app/models/model0.rb"), def("Model1#total", "app/models/model1.rb")];
    const collector = new ResidualSiteCollector("app/services/billing.rb", tableOf(defs), 3, "ruby", {});

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "number", 13), DYNAMIC_MISS);

    const numberRow = collector.rows().find((row) => row.member === "number");
    expect(numberRow).toMatchObject({ candidates: ["Model0#number", "Model1#number"], menuOverflow: false });
  });
});

describe("ResidualSiteCollector — receiver narrowing of a frameworkOverride menu", () => {
  const SAVE_DEFS = [
    def("Invoice#save!", "app/models/invoice.rb"),
    def("Estimate#save!", "app/models/estimate.rb"),
    def("Payment#save!", "app/models/payment.rb"),
    def("Invoice#total", "app/models/invoice.rb"),
  ];
  const overridesOf = (ids: string[]) => () => ids;

  it("settles an override site narrowed to one class whose definition is an override as a static edge", () => {
    const collector = collectorOf(SAVE_DEFS);

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(
      METHOD,
      call("r", "save!", 13),
      DYNAMIC_MISS,
      undefined,
      overridesOf(["Invoice#save!", "Estimate#save!"]),
    );

    expect(collector.narrowed().map((n) => n.edge.targetSymbolId)).toEqual(["Invoice#save!"]);
    expect(collector.rows().filter((r) => r.member === "save!")).toEqual([]);
  });

  it("keeps the override menu when the narrowed class has no override — narrowing never adds a candidate", () => {
    const collector = collectorOf(SAVE_DEFS);

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(METHOD, call("r", "save!", 13), DYNAMIC_MISS, undefined, overridesOf(["Estimate#save!"]));

    const [row] = collector.rows().filter((r) => r.member === "save!");
    expect(row?.candidates).toEqual(["Estimate#save!"]);
    expect(row?.reason).toBe("frameworkOverride");
    expect(collector.narrowed()).toEqual([]);
    expect(collector.narrowEmptyKinds()).toEqual(["dynamic"]);
  });

  it("intersects the override menu with the narrowed classes and hashes the final menu", () => {
    const collector = collectorOf([...SAVE_DEFS, def("Payment#total", "app/models/payment.rb")]);

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(
      METHOD,
      call("r", "save!", 13),
      DYNAMIC_MISS,
      undefined,
      overridesOf(["Invoice#save!", "Estimate#save!"]),
    );

    const [row] = collector.rows().filter((r) => r.member === "save!");
    expect(row?.candidates).toEqual(["Invoice#save!"]);
    expect(row?.reason).toBe("frameworkOverride");
    expect(row?.menuHash).toBe(residualMenuHash(["Invoice#save!"]));
  });

  it("does not let an override site constrain its receiver's other calls", () => {
    const collector = collectorOf([
      ...BASE_DEFS,
      def("Invoice#save!", "app/models/invoice.rb"),
      def("Payment#save!", "app/models/payment.rb"),
    ]);

    collector.observe(METHOD, call("r", "save!", 12), DYNAMIC_MISS, undefined, overridesOf(["Invoice#save!"]));
    collector.observe(METHOD, call("r", "number", 13), DYNAMIC_MISS);

    const [row] = collector.rows().filter((r) => r.member === "number");
    expect(row?.candidates.slice().sort()).toEqual(["Estimate#number", "Invoice#number"]);
    expect(collector.narrowed().map((n) => n.edge.targetSymbolId)).toEqual(["Invoice#save!"]);
  });

  it("offers a grouped override site only the classes that reach a reachable override, keeping its reason", () => {
    const collector = collectorOf([
      ...SAVE_DEFS,
      def("Estimate#total", "app/models/estimate.rb"),
      def("Payment#total", "app/models/payment.rb"),
    ]);

    collector.observe(METHOD, call("r", "total", 12), DYNAMIC_MISS);
    collector.observe(
      METHOD,
      call("r", "save!", 13),
      DYNAMIC_MISS,
      undefined,
      overridesOf(["Invoice#save!", "Estimate#save!"]),
    );

    const rows = collector.rows();
    const save = rows.find((r) => r.member === "save!");
    const total = rows.find((r) => r.member === "total");
    expect(save?.reason).toBe("frameworkOverride");
    expect(save?.receiverGroup).toBe(total?.receiverGroup);
    expect(save?.classTargets).toEqual([
      ["Estimate", "Estimate#save!"],
      ["Invoice", "Invoice#save!"],
    ]);
    expect(total?.classTargets?.map(([cls]) => cls)).toEqual(["Estimate", "Invoice", "Payment"]);
  });
});
