/**
 * bd tea-rags-mcp-2m83f.24 live-validation finding — a Rails framework instance
 * member (`save!`, `presence`, `days`, `with_lock`) called on an UNTYPED
 * receiver targets ActiveRecord / ActiveModel / ActiveSupport, not the one to
 * three project namesakes the short-name lookup happens to find. Such a call is
 * `externalSkipped` — out of the recall denominator and out of the residual
 * rows — unless a namesake lives inside the ActiveRecord model hierarchy (a
 * model, `ApplicationRecord`, a module a model mixes in): that one overrides the
 * framework method, so the call may genuinely land on it and stays a miss.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RUBY_CORE_MEMBERS } from "../../../../../../src/core/domains/language/ruby/dsl/core-members.js";
import {
  ACTIVE_RECORD_INSTANCE_BUILTINS,
  RAILS_UNTYPED_RECEIVER_MEMBERS,
} from "../../../../../../src/core/domains/language/ruby/dsl/rails-runtime.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { residualKindOf } from "../../../../../../src/core/domains/trajectory/codegraph/residual/residual-site-builder.js";
import { classifyResolveMiss } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const resolver = new RubyCallResolver();

function sym(symbolId: string, relPath: string, isSchemaColumn = false): SymbolDefinition {
  const cut = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  const owner = cut === -1 ? [] : symbolId.slice(0, cut).split("::");
  const shortName = cut === -1 ? (symbolId.split("::").at(-1) ?? symbolId) : symbolId.slice(cut + 1);
  return {
    symbolId,
    fqName: symbolId,
    shortName,
    relPath,
    scope: owner,
    ...(isSchemaColumn ? { isSchemaColumn } : {}),
  };
}

function table(defs: SymbolDefinition[], columns: SymbolDefinition[] = []): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  const byFile = new Map<string, SymbolDefinition[]>();
  for (const def of defs) byFile.set(def.relPath, [...(byFile.get(def.relPath) ?? []), def]);
  for (const [relPath, fileDefs] of byFile) t.upsertFile(relPath, fileDefs);
  if (columns.length > 0) t.setSchemaColumns(columns);
  return t;
}

/** A project namesake outside the model hierarchy — a form object and a settings PORO. */
const poroTable = (): InMemoryGlobalSymbolTable =>
  table([
    sym("Reports::Form", "app/forms/reports/form.rb"),
    sym("Reports::Form#save!", "app/forms/reports/form.rb"),
    sym("Settings", "app/lib/settings.rb"),
    sym("Settings#presence", "app/lib/settings.rb"),
  ]);

const AR_ANCESTORS: Record<string, readonly string[]> = {
  ApplicationRecord: ["ActiveRecord::Base"],
  Invoice: ["ApplicationRecord", "Auditable"],
  "Reports::Form": [],
};

function ctx(symbolTable: InMemoryGlobalSymbolTable, extra?: Partial<CallContext>): CallContext {
  return {
    callerFile: "app/services/billing.rb",
    callerScope: ["Billing"],
    imports: [],
    symbolTable,
    classAncestors: AR_ANCESTORS,
    declaredDependencies: new Set(["rails"]),
    ...extra,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}`,
  receiver,
  member,
  startLine: 10,
});

describe("Rails framework member on an untyped receiver (2m83f.24)", () => {
  it("x.save! with one non-model namesake is externalSkipped and leaves the residual rows", () => {
    const site = call("form", "save!");
    const callCtx = ctx(poroTable());
    expect(resolver.targetsExternalImport(site, callCtx)).toBe(true);
    const bucket = classifyResolveMiss(site, callCtx, resolver, callCtx.symbolTable);
    expect(bucket).toBe("externalSkipped");
    expect(residualKindOf({ receiverKind: "dynamic", outcome: "unresolved", missBucket: bucket })).toBeNull();
  });

  it("x.presence (ActiveSupport Object extension) is externalSkipped", () => {
    expect(resolver.targetsExternalImport(call("value", "presence"), ctx(poroTable()))).toBe(true);
  });

  it("an ActiveSupport Numeric extension on a chain receiver is externalSkipped", () => {
    const t = table([sym("Calendar#days", "app/lib/calendar.rb")]);
    expect(resolver.targetsExternalImport(call("config.retention", "days"), ctx(t))).toBe(true);
  });

  it("keeps the miss when a namesake is an AR model's override of the framework method", () => {
    const t = table([sym("Invoice", "app/models/invoice.rb"), sym("Invoice#save!", "app/models/invoice.rb")]);
    const site = call("record", "save!");
    const callCtx = ctx(t);
    expect(resolver.targetsExternalImport(site, callCtx)).toBe(false);
    expect(classifyResolveMiss(site, callCtx, resolver, t)).toBe("missWithInProjectDef");
  });

  it("keeps the miss when the namesake sits on ApplicationRecord", () => {
    const t = table([sym("ApplicationRecord#save!", "app/models/application_record.rb")]);
    expect(resolver.targetsExternalImport(call("record", "save!"), ctx(t))).toBe(false);
  });

  it("keeps the miss when the namesake sits in a module a model mixes in", () => {
    const t = table([sym("Auditable#with_lock", "app/models/concerns/auditable.rb")]);
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(t))).toBe(false);
  });

  it("keeps the miss when the namesake is a schema column of a model", () => {
    const t = table([sym("Invoice", "app/models/invoice.rb")], [sym("Invoice#day", "app/models/invoice.rb", true)]);
    expect(resolver.targetsExternalImport(call("entry", "day"), ctx(t))).toBe(false);
  });

  it("a class-method namesake on a model never blocks an instance call", () => {
    const t = table([sym("Invoice", "app/models/invoice.rb"), sym("Invoice.with_lock", "app/models/invoice.rb")]);
    expect(resolver.targetsExternalImport(call("record", "with_lock"), ctx(t))).toBe(true);
  });

  it("is unchanged when the Gemfile declares no Rails gem", () => {
    const callCtx = ctx(poroTable(), { declaredDependencies: new Set(["sinatra"]) });
    expect(resolver.targetsExternalImport(call("form", "save!"), callCtx)).toBe(false);
    expect(classifyResolveMiss(call("form", "save!"), callCtx, resolver, callCtx.symbolTable)).toBe(
      "missWithInProjectDef",
    );
  });

  it("does not claim a typed receiver — the chain's evidence names the project class", () => {
    const callCtx = ctx(poroTable(), {
      localBindings: { form: [{ type: "Reports::Form", line: 1, valueKind: "instance" }] },
    });
    expect(resolver.targetsExternalImport(call("form", "save!"), callCtx)).toBe(false);
  });

  it("does not claim self or a project constant receiver", () => {
    const callCtx = ctx(poroTable());
    expect(resolver.targetsExternalImport(call("self", "save!"), callCtx)).toBe(false);
    expect(resolver.targetsExternalImport(call("Reports::Form", "save!"), callCtx)).toBe(false);
  });

  it("does not claim a member outside the Rails vocabulary", () => {
    const t = table([sym("Reports::Form#recalculate", "app/forms/reports/form.rb")]);
    expect(resolver.targetsExternalImport(call("form", "recalculate"), ctx(t))).toBe(false);
  });

  it("keeps the miss when the namesake patches a reopened core class", () => {
    const t = table([sym("String#squish", "lib/core_ext/string.rb")]);
    expect(resolver.targetsExternalImport(call("title", "squish"), ctx(t))).toBe(false);
  });

  it("does not claim without ancestry facts to tell a model namesake from a homonym", () => {
    expect(resolver.targetsExternalImport(call("form", "save!"), ctx(poroTable(), { classAncestors: undefined }))).toBe(
      false,
    );
  });

  it("owns no name another axis already classifies", () => {
    const shared = [...RAILS_UNTYPED_RECEIVER_MEMBERS].filter(
      (name) => RUBY_CORE_MEMBERS.has(name) || ACTIVE_RECORD_INSTANCE_BUILTINS.has(name),
    );
    expect(shared).toEqual([]);
  });
});

/**
 * TaxDome-shaped residual sites (cg_residual_call_sites, 1–3 entry menus): what
 * each moves to once the arm runs. `externalSkipped` leaves the residual rows;
 * `missWithInProjectDef` on a dynamic receiver stays one.
 */
describe("TaxDome residual shapes (2m83f.24)", () => {
  const taxdome = (): InMemoryGlobalSymbolTable =>
    table([
      sym("Platform::Schedule.save!", "app/models/platform/schedule.rb"),
      sym("GeoResolver#presence", "app/lib/geo_resolver.rb"),
      sym("Params#days", "app/lib/params.rb"),
      sym("Document", "app/models/document.rb"),
      sym("TaxPreparation::DocumentLockHelper#with_lock", "app/models/tax_preparation/document_lock_helper.rb"),
      sym("Metrics::Counter#increment", "app/lib/metrics/counter.rb"),
      sym("Kafka::Consumer#topic", "app/consumers/kafka/consumer.rb"),
      sym("Csv::Row#split", "app/lib/csv/row.rb"),
    ]);
  const ancestors: Record<string, readonly string[]> = {
    ApplicationRecord: ["ActiveRecord::Base"],
    Document: ["ApplicationRecord", "TaxPreparation::DocumentLockHelper"],
  };

  it.each([
    ["client", "save!", "externalSkipped"],
    ["@subscription", "save!", "externalSkipped"],
    ["geo", "presence", "externalSkipped"],
    ["7", "days", "externalSkipped"],
    ["config.retention", "days", "externalSkipped"],
    ["group.rejections_total", "increment", "externalSkipped"],
    ['"a,b"', "split", "externalSkipped"],
    ["document", "with_lock", "missWithInProjectDef"],
    ["event", "topic", "missWithInProjectDef"],
  ])("%s.%s → %s", (receiver, member, expected) => {
    const callCtx = ctx(taxdome(), { classAncestors: ancestors });
    const bucket = classifyResolveMiss(call(receiver, member), callCtx, resolver, callCtx.symbolTable);
    expect(bucket).toBe(expected);
    expect(residualKindOf({ receiverKind: "dynamic", outcome: "unresolved", missBucket: bucket })).toBe(
      expected === "externalSkipped" ? null : "dynamic",
    );
  });
});

describe("literal receivers are typed by their core class (2m83f.24)", () => {
  it("claims a member on a literal whatever the Gemfile says", () => {
    const callCtx = ctx(table([sym("Params#days", "app/lib/params.rb")]), { declaredDependencies: new Set() });
    expect(resolver.targetsExternalImport(call("30", "days"), callCtx)).toBe(true);
    expect(resolver.targetsExternalImport(call(":ok", "days"), callCtx)).toBe(true);
    expect(resolver.targetsExternalImport(call("%w[a b]", "days"), callCtx)).toBe(true);
  });

  it("keeps the miss when the project patches the literal's class", () => {
    const t = table([sym("Integer#days", "lib/core_ext/integer.rb")]);
    expect(resolver.targetsExternalImport(call("7", "days"), ctx(t))).toBe(false);
  });

  it("keeps the miss when the patch arrives through a module the core class mixes in", () => {
    const t = table([sym("DurationExt#days", "lib/core_ext/duration_ext.rb")]);
    const callCtx = ctx(t, { classAncestors: { Integer: ["DurationExt"] } });
    expect(resolver.targetsExternalImport(call("7", "days"), callCtx)).toBe(false);
  });

  it("keeps the miss when an Object patch or a top-level def is the namesake", () => {
    expect(resolver.targetsExternalImport(call("7", "days"), ctx(table([sym("Object#days", "lib/ext.rb")])))).toBe(
      false,
    );
    expect(resolver.targetsExternalImport(call("7", "days"), ctx(table([sym("days", "lib/ext.rb")])))).toBe(false);
  });

  it("a literal is a typed receiver, so the core-homonym bucket never claims it", () => {
    expect(
      resolver.targetsCoreAmbiguousMember(call("7", "times"), ctx(table([sym("Integer#times", "lib/i.rb")]))),
    ).toBe(false);
  });
});
