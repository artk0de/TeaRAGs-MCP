/**
 * Ruby instantiation SITES (bd tea-rags-mcp-0qaht.65) are resolved into the RTA
 * set at the barrier, by Ruby constant lookup against what the run declares —
 * never pre-qualified by the walker's lexical scope, which recorded mastodon's
 * top-level `AccountReachFinder` as `SuspendAccountService::AccountReachFinder`.
 *
 * Resolution runs at every seal over walked AND hydrated sites, so a full and an
 * incremental run derive the same set whichever side of the batch the declaring
 * file sits on.
 */
import { describe, expect, it } from "vitest";

import { fromCgPass1Row, toCgPass1Row } from "../../../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
  RubyInstantiationSite,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { InstantiationSiteResolver } from "../../../../../../src/core/contracts/types/language.js";
import { resolveRubyInstantiationSite } from "../../../../../../src/core/domains/language/ruby/instantiation-site-lookup.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const RESOLVERS: ReadonlyMap<string, InstantiationSiteResolver> = new Map([["ruby", resolveRubyInstantiationSite]]);

function newState(): CodegraphRunState {
  return new CodegraphRunState([], new Map(), new Map(), undefined, new Map(), RESOLVERS);
}

function rubyFile(
  relPath: string,
  facts: { sites?: RubyInstantiationSite[]; classAncestors?: Record<string, string[]> } = {},
): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [],
    ...(facts.sites === undefined ? {} : { rubyInstantiationSites: facts.sites }),
    ...(facts.classAncestors === undefined ? {} : { classAncestors: facts.classAncestors }),
  };
}

/** A project-wide symbol table declaring `classes`, as `cg_symbols` hydrates one. */
function tableDeclaring(...classes: [relPath: string, fq: string][]): () => Promise<GlobalSymbolTable> {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, fq] of classes) {
    table.upsertFile(relPath, [
      { symbolId: fq, fqName: fq, shortName: fq.split("::").pop() ?? fq, relPath, scope: fq.split("::").slice(0, -1) },
    ]);
  }
  return async () => table;
}

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

function persistedRow(file: FileExtraction): CodegraphPass1FileAggregates[] {
  const slice = buildPass1Aggregates(file, []);
  if (slice === undefined) return [];
  const [relPath, language, json] = toCgPass1Row(slice) as [string, string, string];
  return [fromCgPass1Row({ rel_path: relPath, language, aggregates_json: json })];
}

async function fullRun(
  files: readonly FileExtraction[],
  table: () => Promise<GlobalSymbolTable>,
): Promise<CodegraphRunState> {
  const state = newState();
  for (const file of files) state.absorb(file, []);
  await state.seal(table);
  return state;
}

async function incrementalRun(
  walked: readonly FileExtraction[],
  unwalked: readonly FileExtraction[],
  table: () => Promise<GlobalSymbolTable>,
): Promise<CodegraphRunState> {
  const state = newState();
  for (const file of walked) state.absorb(file, []);
  await state.seal(table, async () => unwalked.flatMap(persistedRow));
  return state;
}

const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

// mastodon: `AccountReachFinder.new` inside `class SuspendAccountService`.
const suspendService = rubyFile("app/services/suspend_account_service.rb", {
  sites: [{ name: "AccountReachFinder", nesting: ["SuspendAccountService"], rootAnchored: false }],
});

describe("CodegraphRunState resolves Ruby instantiation sites at the barrier (bd 0qaht.65)", () => {
  it("a nested constant reference reaches the real top-level class", async () => {
    const table = tableDeclaring(
      ["app/services/suspend_account_service.rb", "SuspendAccountService"],
      ["app/lib/account_reach_finder.rb", "AccountReachFinder"],
    );
    const state = await fullRun([suspendService], table);
    expect(sorted(state.instantiatedTypes)).toEqual(["AccountReachFinder"]);
  });

  it("prefers a declared nested sibling over the top-level namesake", async () => {
    const table = tableDeclaring(["a.rb", "Outer::Leaf"], ["b.rb", "Leaf"]);
    const file = rubyFile("c.rb", {
      sites: [{ name: "Leaf", nesting: ["Outer::Inner", "Outer"], rootAnchored: false }],
    });
    expect(sorted((await fullRun([file], table)).instantiatedTypes)).toEqual(["Outer::Leaf"]);
  });

  it("a root-anchored site is the top-level class", async () => {
    const table = tableDeclaring(["a.rb", "Zoo::Cat"], ["b.rb", "Cat"]);
    const file = rubyFile("c.rb", { sites: [{ name: "Cat", nesting: ["Zoo"], rootAnchored: true }] });
    expect(sorted((await fullRun([file], table)).instantiatedTypes)).toEqual(["Cat"]);
  });

  it("an undeclared site stays as written", async () => {
    const file = rubyFile("c.rb", { sites: [{ name: "Leaf", nesting: ["Outer"], rootAnchored: false }] });
    expect(sorted((await fullRun([file], noopTable)).instantiatedTypes)).toEqual(["Leaf"]);
  });

  it("a class only the hydrated ancestry declares still answers the lookup", async () => {
    const declaring = rubyFile("app/models/outer/leaf.rb", { classAncestors: { "Outer::Leaf": ["Base"] } });
    const caller = rubyFile("app/models/outer/inner.rb", {
      sites: [{ name: "Leaf", nesting: ["Outer::Inner", "Outer"], rootAnchored: false }],
    });
    const full = await fullRun([caller, declaring], noopTable);
    const inc = await incrementalRun([caller], [declaring], noopTable);
    expect(sorted(full.instantiatedTypes)).toEqual(["Outer::Leaf"]);
    expect(sorted(inc.instantiatedTypes)).toEqual(sorted(full.instantiatedTypes));
  });

  it("full == incremental when the SITE's file is outside the batch", async () => {
    const table = tableDeclaring(
      ["app/services/suspend_account_service.rb", "SuspendAccountService"],
      ["app/lib/account_reach_finder.rb", "AccountReachFinder"],
    );
    const finder = rubyFile("app/lib/account_reach_finder.rb");
    const full = await fullRun([suspendService, finder], table);
    const inc = await incrementalRun([finder], [suspendService], table);
    expect(sorted(inc.instantiatedTypes)).toEqual(sorted(full.instantiatedTypes));
    expect(sorted(inc.instantiatedTypes)).toEqual(["AccountReachFinder"]);
  });

  it("drops a site the re-walked file no longer makes", async () => {
    const edited = rubyFile("app/services/suspend_account_service.rb");
    const inc = await incrementalRun([edited], [suspendService], noopTable);
    expect(inc.instantiatedTypes.size).toBe(0);
  });

  it("keeps instantiations another language's walker emits directly", async () => {
    const ts: FileExtraction = {
      relPath: "web/app.ts",
      language: "typescript",
      imports: [],
      fileScope: [],
      chunks: [],
      instantiatedTypes: ["Widget"],
    };
    const state = await fullRun([ts, suspendService], noopTable);
    expect(sorted(state.instantiatedTypes)).toEqual(["AccountReachFinder", "Widget"]);
  });

  it("re-resolves at every seal: a declaration a later run adds moves the answer", async () => {
    const state = newState();
    const caller = rubyFile("c.rb", { sites: [{ name: "Leaf", nesting: ["Outer"], rootAnchored: false }] });
    state.absorb(caller, []);
    await state.seal(noopTable);
    expect(sorted(state.instantiatedTypes)).toEqual(["Leaf"]);
    await state.seal(tableDeclaring(["a.rb", "Outer::Leaf"]));
    expect(sorted(state.instantiatedTypes)).toEqual(["Outer::Leaf"]);
  });
});
