/**
 * A Ruby class can be REOPENED in any number of files, and every reopening adds
 * to the same class: the superclass is declared at most once (a reopening
 * without `< X` keeps it), while `include` / `extend` / `prepend` accumulate.
 * The run-global ancestry maps are keyed by class FQ, so a merge that lets one
 * file's entry replace another's keeps only whichever reopening it saw last.
 *
 * Measured on graphql-ruby (bd tea-rags-mcp-89k7k.35.30): `GraphQL::Schema::Directive`
 * is declared in `schema/directive.rb` with `extend HasArguments` and reopened
 * by eight `schema/directive/*.rb` files that only restate `< Member`. The
 * relPath-sorted full run absorbed a reopening last and lost the `extend`s, so
 * it was MISSING the `HasArguments#argument` edges; a shuffled walk kept them
 * whenever `directive.rb` happened to come last — 16 edges that depended on
 * absorb order alone.
 *
 * The invariants: the merged ancestry is the union of every reopening (first
 * declared superclass by relPath, then every mixin in relPath + declaration
 * order), it does not depend on absorb order, and an incremental run that
 * hydrates some reopenings from their persisted slices derives exactly what a
 * full run derives.
 */
import { describe, expect, it } from "vitest";

import { fromCgPass1Row, toCgPass1Row } from "../../../../../../src/core/adapters/duckdb/cg-pass1-aggregates-row.js";
import { NoopGlobalSymbolTable } from "../../../../../../src/core/adapters/duckdb/daemon/noop-symbol-table.js";
import type {
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { buildPass1Aggregates } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/pass1-aggregates.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const noopTable = async (): Promise<GlobalSymbolTable> => new NoopGlobalSymbolTable();

interface RubyClassDecl {
  superclass?: string;
  mixins?: string[];
  prepends?: string[];
}

/** A Ruby file's hierarchy channels, shaped exactly as the walker emits them. */
function rubyFile(relPath: string, classes: Record<string, RubyClassDecl>): FileExtraction {
  const file: FileExtraction = { relPath, language: "ruby", imports: [], fileScope: [], chunks: [] };
  const ancestors: Record<string, readonly string[]> = {};
  const prepended: Record<string, readonly string[]> = {};
  const extendsMap: Record<string, string> = {};
  for (const [fq, decl] of Object.entries(classes)) {
    const list = [...(decl.superclass === undefined ? [] : [decl.superclass]), ...(decl.mixins ?? [])];
    if (list.length > 0) ancestors[fq] = list;
    if (decl.prepends !== undefined && decl.prepends.length > 0) prepended[fq] = decl.prepends;
    if (decl.superclass !== undefined) extendsMap[fq] = decl.superclass;
  }
  if (Object.keys(ancestors).length > 0) file.classAncestors = ancestors;
  if (Object.keys(prepended).length > 0) file.classPrependedAncestors = prepended;
  if (Object.keys(extendsMap).length > 0) file.classExtends = extendsMap;
  return file;
}

/** The persisted row of a file, exactly as a later run reads it back. */
function persistedRow(file: FileExtraction): CodegraphPass1FileAggregates[] {
  const slice = buildPass1Aggregates(file, []);
  if (slice === undefined) return [];
  const [relPath, language, json] = toCgPass1Row(slice) as [string, string, string];
  return [fromCgPass1Row({ rel_path: relPath, language, aggregates_json: json })];
}

async function fullRun(files: readonly FileExtraction[]): Promise<CodegraphRunState> {
  const state = new CodegraphRunState();
  for (const file of files) state.absorb(file, []);
  await state.seal(noopTable);
  return state;
}

async function incrementalRun(
  walked: readonly FileExtraction[],
  unwalked: readonly FileExtraction[],
): Promise<CodegraphRunState> {
  const state = new CodegraphRunState();
  for (const file of walked) state.absorb(file, []);
  await state.seal(noopTable, async () => unwalked.flatMap(persistedRow));
  return state;
}

function hierarchyOf(state: CodegraphRunState): unknown {
  return {
    ancestors: state.ancestorsFor("ruby"),
    prepended: state.prependedAncestorsFor("ruby"),
    superclass: state.classExtendsFor("ruby"),
  };
}

const DIRECTIVE = "GraphQL::Schema::Directive";
const MEMBER = "GraphQL::Schema::Member";

// graphql-ruby's shape: the declaring file mixes in, the reopenings restate the superclass.
const declaring = rubyFile("lib/graphql/schema/directive.rb", {
  [DIRECTIVE]: {
    superclass: MEMBER,
    mixins: ["GraphQL::Schema::Member::HasArguments", "GraphQL::Schema::Member::HasValidators"],
  },
});
const reopenedFeature = rubyFile("lib/graphql/schema/directive/feature.rb", { [DIRECTIVE]: { superclass: MEMBER } });
const reopenedSkip = rubyFile("lib/graphql/schema/directive/skip.rb", { [DIRECTIVE]: { superclass: MEMBER } });
const graphqlCorpus = [declaring, reopenedFeature, reopenedSkip];

describe("CodegraphRunState merges a reopened Ruby class across files", () => {
  it("keeps the mixins of the declaring file when a later reopening only restates the superclass", async () => {
    const state = await fullRun(graphqlCorpus);

    expect(state.ancestorsFor("ruby")[DIRECTIVE]).toEqual([
      MEMBER,
      "GraphQL::Schema::Member::HasArguments",
      "GraphQL::Schema::Member::HasValidators",
    ]);
    expect(state.classExtendsFor("ruby")[DIRECTIVE]).toBe(MEMBER);
  });

  it("keeps the superclass from another file when a reopening declares none, in either absorb order", async () => {
    const base = rubyFile("app/models/user.rb", { User: { superclass: "ApplicationRecord" } });
    const reopening = rubyFile("app/models/user/auth.rb", { User: { mixins: ["Auth"] } });

    for (const order of [
      [base, reopening],
      [reopening, base],
    ]) {
      const state = await fullRun(order);
      expect(state.ancestorsFor("ruby").User).toEqual(["ApplicationRecord", "Auth"]);
      expect(state.classExtendsFor("ruby").User).toBe("ApplicationRecord");
    }
  });

  it("accumulates the mixins of two reopenings in relPath then declaration order", async () => {
    const a = rubyFile("lib/a.rb", { Widget: { mixins: ["A1", "A2"], prepends: ["PA"] } });
    const b = rubyFile("lib/b.rb", { Widget: { mixins: ["B1", "A1"], prepends: ["PB"] } });

    const state = await fullRun([b, a]);

    expect(state.ancestorsFor("ruby").Widget).toEqual(["A1", "A2", "B1"]);
    expect(state.prependedAncestorsFor("ruby").Widget).toEqual(["PA", "PB"]);
  });

  it("keeps the first superclass by relPath when two reopenings conflict, without throwing", async () => {
    const first = rubyFile("lib/a.rb", { Thing: { superclass: "Base", mixins: ["M"] } });
    const second = rubyFile("lib/b.rb", { Thing: { superclass: "Other", mixins: ["N"] } });

    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const state = await fullRun(order);
      expect(state.ancestorsFor("ruby").Thing).toEqual(["Base", "M", "N"]);
      expect(state.classExtendsFor("ruby").Thing).toBe("Base");
    }
  });

  it("does not depend on the order a run absorbs its files in", async () => {
    const forward = await fullRun(graphqlCorpus);
    const reverse = await fullRun([...graphqlCorpus].reverse());
    const shuffled = await fullRun([reopenedSkip, declaring, reopenedFeature]);

    expect(hierarchyOf(reverse)).toEqual(hierarchyOf(forward));
    expect(hierarchyOf(shuffled)).toEqual(hierarchyOf(forward));
  });

  it("an incremental run derives what a full run derives, whichever reopening it walked", async () => {
    const full = await fullRun(graphqlCorpus);

    for (const walked of graphqlCorpus) {
      const unwalked = graphqlCorpus.filter((file) => file !== walked);
      const inc = await incrementalRun([walked], unwalked);
      expect(hierarchyOf(inc)).toEqual(hierarchyOf(full));
    }
  });

  it("a re-walked reopening replaces its own persisted contribution", async () => {
    const edited = rubyFile("lib/graphql/schema/directive/feature.rb", {
      [DIRECTIVE]: { superclass: MEMBER, mixins: ["FeatureFlags"] },
    });
    const inc = await incrementalRun([edited], graphqlCorpus);

    expect(inc.ancestorsFor("ruby")[DIRECTIVE]).toEqual([
      MEMBER,
      "GraphQL::Schema::Member::HasArguments",
      "GraphQL::Schema::Member::HasValidators",
      "FeatureFlags",
    ]);
  });

  it("leaves a class declared by one file exactly as that file emitted it", async () => {
    const single = rubyFile("lib/one.rb", { Solo: { superclass: "Base", mixins: ["M", "M"] } });
    const state = await fullRun([single]);

    expect(state.ancestorsFor("ruby").Solo).toEqual(["Base", "M", "M"]);
  });
});
