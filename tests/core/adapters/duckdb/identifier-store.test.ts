/**
 * `cg_identifiers` — the persisted identifier declarations behind the naming
 * lexicon (bd tea-rags-mcp-4p3sb.8).
 *
 * Invariants under test:
 *   - a replace makes a file's rows EQUAL the entry's rows (last-wins per file),
 *     and an empty entry clears the file;
 *   - `removeFile` drops the file's identifiers with the rest of its graph;
 *   - the type aggregate groups by (type, kind, name, typeSource), counts, and
 *     names an example owner; `pathPrefixes` scopes it by rel_path prefix;
 *   - an untyped row bound to a call gets the callee's `return` type through an
 *     `exact` single-target edge, reported as `call-return` — and gets nothing
 *     when the call fans out to two targets;
 *   - the callee aggregate groups untyped-or-typed rows by the bound callee;
 *   - homonymy, anchor types, short-name collisions and scope counts read what
 *     the table (and `cg_symbols`) hold.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function row(partial: Partial<IdentifierRow> & Pick<IdentifierRow, "name">): IdentifierRow {
  return { ownerSymbolId: "Svc#run", kind: "local", line: 1, ...partial };
}

describe("DuckDbGraphClient — cg_identifiers", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-identifiers-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function allRows(): Promise<{ rel_path: string; name: string }[]> {
    return db.queryAll<{ rel_path: string; name: string }>(
      "SELECT rel_path, name FROM cg_identifiers ORDER BY rel_path, name",
    );
  }

  it("a second replace for the same relPath leaves only the second call's rows", async () => {
    await db.replaceIdentifiersBulk([{ relPath: "a.rb", rows: [row({ name: "old" }), row({ name: "gone" })] }]);
    await db.replaceIdentifiersBulk([{ relPath: "a.rb", rows: [row({ name: "fresh" })] }]);
    expect(await allRows()).toEqual([{ rel_path: "a.rb", name: "fresh" }]);
  });

  it("is last-wins per relPath within one call and leaves unnamed files alone", async () => {
    await db.replaceIdentifiersBulk([{ relPath: "b.rb", rows: [row({ name: "kept" })] }]);
    await db.replaceIdentifiersBulk([
      { relPath: "a.rb", rows: [row({ name: "first" })] },
      { relPath: "a.rb", rows: [row({ name: "second" })] },
    ]);
    expect(await allRows()).toEqual([
      { rel_path: "a.rb", name: "second" },
      { rel_path: "b.rb", name: "kept" },
    ]);
  });

  it("an entry with no rows clears its file", async () => {
    await db.replaceIdentifiersBulk([{ relPath: "a.rb", rows: [row({ name: "x" })] }]);
    await db.replaceIdentifiersBulk([{ relPath: "a.rb", rows: [] }]);
    expect(await allRows()).toEqual([]);
  });

  it("round-trips every column, NULL for the absent optional ones", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "a.rb",
        rows: [
          row({
            name: "doc",
            line: 7,
            typeName: "Doc",
            typeSource: "finder",
            boundMember: "find",
            boundReceiver: "Doc",
            boundCallExpression: "Doc.find(id)",
          }),
          row({ name: "bare", kind: "param", line: 3 }),
        ],
      },
    ]);
    const rows = await db.queryAll(
      `SELECT owner_symbol_id, kind, name, type_name, type_source, line, bound_member, bound_receiver,
              bound_call_expression FROM cg_identifiers ORDER BY name`,
    );
    expect(rows).toEqual([
      {
        owner_symbol_id: "Svc#run",
        kind: "param",
        name: "bare",
        type_name: null,
        type_source: null,
        line: 3,
        bound_member: null,
        bound_receiver: null,
        bound_call_expression: null,
      },
      {
        owner_symbol_id: "Svc#run",
        kind: "local",
        name: "doc",
        type_name: "Doc",
        type_source: "finder",
        line: 7,
        bound_member: "find",
        bound_receiver: "Doc",
        bound_call_expression: "Doc.find(id)",
      },
    ]);
  });

  it("removeFile drops the file's identifiers", async () => {
    await db.replaceIdentifiersBulk([
      { relPath: "a.rb", rows: [row({ name: "x" })] },
      { relPath: "b.rb", rows: [row({ name: "y" })] },
    ]);
    await db.removeFile("a.rb");
    expect(await allRows()).toEqual([{ rel_path: "b.rb", name: "y" }]);
  });

  describe("aggregateIdentifiersByType", () => {
    beforeEach(async () => {
      await db.replaceIdentifiersBulk([
        {
          relPath: "app/services/a.rb",
          rows: [
            row({ ownerSymbolId: "A#run", name: "doc", typeName: "Doc", typeSource: "binding" }),
            row({ ownerSymbolId: "A#other", name: "doc", typeName: "Doc", typeSource: "binding" }),
            row({ ownerSymbolId: "A#run", kind: "param", name: "document", typeName: "Doc", typeSource: "annotation" }),
            row({ ownerSymbolId: "A#run", name: "user", typeName: "User", typeSource: "binding" }),
          ],
        },
        {
          relPath: "lib/b.rb",
          rows: [row({ ownerSymbolId: "B#run", name: "record", typeName: "Doc", typeSource: "constructor" })],
        },
      ]);
    });

    it("groups by type, kind, name and typeSource, counts, and names an example owner", async () => {
      const rows = await db.aggregateIdentifiersByType({ types: ["Doc"] });
      const sorted = [...rows].sort((x, y) => `${x.kind}${x.name}`.localeCompare(`${y.kind}${y.name}`));
      expect(sorted).toEqual([
        { typeName: "Doc", kind: "local", name: "doc", typeSource: "binding", n: 2, exampleOwner: "A#other" },
        { typeName: "Doc", kind: "local", name: "record", typeSource: "constructor", n: 1, exampleOwner: "B#run" },
        { typeName: "Doc", kind: "param", name: "document", typeSource: "annotation", n: 1, exampleOwner: "A#run" },
      ]);
    });

    it("filters by rel_path prefix", async () => {
      const rows = await db.aggregateIdentifiersByType({ types: ["Doc"], pathPrefixes: ["lib/"] });
      expect(rows.map((r) => r.name)).toEqual(["record"]);
    });

    it("treats a LIKE wildcard in a prefix as a literal", async () => {
      expect(await db.aggregateIdentifiersByType({ types: ["Doc"], pathPrefixes: ["%"] })).toEqual([]);
    });

    it("returns nothing for an empty type list", async () => {
      expect(await db.aggregateIdentifiersByType({ types: [] })).toEqual([]);
    });

    it("countIdentifiers counts the rows of the scope", async () => {
      expect(await db.countIdentifiers({ types: ["Doc"] })).toBe(4);
      expect(await db.countIdentifiers({ types: ["Doc", "User"], pathPrefixes: ["app/"] })).toBe(4);
      expect(await db.countIdentifiers({ types: ["Nope"] })).toBe(0);
    });
  });

  describe("call-return typing through an exact single-target edge", () => {
    async function insertEdge(target: { relPath: string; symbolId: string }, callExpression: string): Promise<void> {
      await db.run(
        `INSERT INTO cg_symbols_edges_method
           (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key,
            target_symbol_id, edge_kind, confidence)
         VALUES (?, ?, ?, ?, ?, ?, 'exact', 1.0)`,
        ["Job#perform", "app/jobs/job.rb", target.relPath, callExpression, target.symbolId, target.symbolId],
      );
    }

    beforeEach(async () => {
      await db.replaceIdentifiersBulk([
        {
          relPath: "app/services/finder.rb",
          rows: [
            row({
              ownerSymbolId: "Finder#find_doc!",
              kind: "return",
              name: "find_doc!",
              typeName: "TaxDocument",
              typeSource: "return-type",
            }),
          ],
        },
        {
          relPath: "app/jobs/job.rb",
          rows: [
            row({
              ownerSymbolId: "Job#perform",
              name: "document",
              line: 4,
              boundMember: "find_doc!",
              boundCallExpression: "find_doc!(id)",
            }),
          ],
        },
      ]);
    });

    it("fills the type from the target's return row and reports it as call-return", async () => {
      await insertEdge({ relPath: "app/services/finder.rb", symbolId: "Finder#find_doc!" }, "find_doc!(id)");
      const rows = await db.aggregateIdentifiersByType({ types: ["TaxDocument"] });
      const locals = rows.filter((r) => r.kind === "local");
      expect(locals).toEqual([
        {
          typeName: "TaxDocument",
          kind: "local",
          name: "document",
          typeSource: "call-return",
          n: 1,
          exampleOwner: "Job#perform",
        },
      ]);
      expect(await db.identifierNameTypes(["document"])).toEqual([{ name: "document", typeName: "TaxDocument", n: 1 }]);
    });

    it("types nothing when the call has two exact targets", async () => {
      await insertEdge({ relPath: "app/services/finder.rb", symbolId: "Finder#find_doc!" }, "find_doc!(id)");
      await insertEdge({ relPath: "app/services/other.rb", symbolId: "Other#find_doc!" }, "find_doc!(id)");
      const rows = await db.aggregateIdentifiersByType({ types: ["TaxDocument"] });
      expect(rows.filter((r) => r.kind === "local")).toEqual([]);
      expect(await db.identifierNameTypes(["document"])).toEqual([{ name: "document", typeName: null, n: 1 }]);
    });

    it("does not override a row that already has a type", async () => {
      await db.replaceIdentifiersBulk([
        {
          relPath: "app/jobs/job.rb",
          rows: [
            row({
              ownerSymbolId: "Job#perform",
              name: "document",
              typeName: "Draft",
              typeSource: "binding",
              boundMember: "find_doc!",
              boundCallExpression: "find_doc!(id)",
            }),
          ],
        },
      ]);
      await insertEdge({ relPath: "app/services/finder.rb", symbolId: "Finder#find_doc!" }, "find_doc!(id)");
      expect(await db.identifierNameTypes(["document"])).toEqual([{ name: "document", typeName: "Draft", n: 1 }]);
    });
  });

  it("aggregateIdentifiersByCallee groups by callee, receiver-less queries matching any receiver", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/a.rb",
        rows: [
          row({ ownerSymbolId: "A#x", name: "doc", boundMember: "find", boundReceiver: "Doc" }),
          row({ ownerSymbolId: "A#y", name: "doc", boundMember: "find", boundReceiver: "Doc" }),
          row({ ownerSymbolId: "A#z", name: "user", boundMember: "find", boundReceiver: "User" }),
          row({ ownerSymbolId: "A#w", name: "item", boundMember: "fetch_item" }),
        ],
      },
    ]);
    const byReceiver = await db.aggregateIdentifiersByCallee({ callees: [{ member: "find", receiver: "Doc" }] });
    expect(byReceiver).toEqual([
      { member: "find", receiver: "Doc", kind: "local", name: "doc", n: 2, exampleOwner: "A#x" },
    ]);

    const anyReceiver = await db.aggregateIdentifiersByCallee({ callees: [{ member: "find" }] });
    expect(anyReceiver.map((r) => `${r.receiver}:${r.name}:${r.n}`).sort()).toEqual(["Doc:doc:2", "User:user:1"]);

    const receiverless = await db.aggregateIdentifiersByCallee({
      callees: [{ member: "fetch_item" }],
      pathPrefixes: ["app/"],
    });
    expect(receiverless).toEqual([
      { member: "fetch_item", receiver: null, kind: "local", name: "item", n: 1, exampleOwner: "A#w" },
    ]);
    expect(await db.aggregateIdentifiersByCallee({ callees: [] })).toEqual([]);
  });

  it("aggregateIdentifiersByCallee carries the rows' persisted type, grouping typed and untyped apart", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/a.rb",
        rows: [
          row({
            ownerSymbolId: "A#x",
            name: "doc",
            typeName: "Doc",
            typeSource: "finder",
            boundMember: "find",
            boundReceiver: "Doc",
          }),
          row({ ownerSymbolId: "A#y", name: "doc", boundMember: "find", boundReceiver: "Doc" }),
        ],
      },
    ]);
    expect(await db.aggregateIdentifiersByCallee({ callees: [{ member: "find", receiver: "Doc" }] })).toEqual([
      { member: "find", receiver: "Doc", kind: "local", name: "doc", n: 1, exampleOwner: "A#y" },
      { member: "find", receiver: "Doc", kind: "local", name: "doc", n: 1, exampleOwner: "A#x", typeName: "Doc" },
    ]);
  });

  it("identifierNameTypes returns one entry per distinct type, null for untyped", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "a.rb",
        rows: [
          row({ name: "row", typeName: "Doc", typeSource: "binding" }),
          row({ name: "row", typeName: "Doc", typeSource: "binding", ownerSymbolId: "Svc#other" }),
          row({ name: "row", typeName: "CSV::Row", typeSource: "constructor" }),
          row({ name: "row" }),
          row({ name: "unrelated", typeName: "X", typeSource: "binding" }),
        ],
      },
    ]);
    const rows = await db.identifierNameTypes(["row"]);
    const sorted = [...rows].sort((x, y) => String(x.typeName).localeCompare(String(y.typeName)));
    expect(sorted).toEqual([
      { name: "row", typeName: "CSV::Row", n: 1 },
      { name: "row", typeName: "Doc", n: 2 },
      { name: "row", typeName: null, n: 1 },
    ]);
    expect(await db.identifierNameTypes([])).toEqual([]);
  });

  it("anchorIdentifierTypes returns the typed param and return rows of the anchors", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "a.rb",
        rows: [
          row({ ownerSymbolId: "A#run", kind: "param", name: "doc", typeName: "Doc", typeSource: "annotation" }),
          row({ ownerSymbolId: "A#run", kind: "param", name: "untyped" }),
          row({ ownerSymbolId: "A#run", kind: "return", name: "run", typeName: "Result", typeSource: "return-type" }),
          row({ ownerSymbolId: "A#run", kind: "local", name: "tmp", typeName: "Tmp", typeSource: "binding" }),
          row({ ownerSymbolId: "B#run", kind: "param", name: "x", typeName: "X", typeSource: "annotation" }),
        ],
      },
    ]);
    const rows = await db.anchorIdentifierTypes(["A#run"]);
    expect([...rows].sort((x, y) => x.kind.localeCompare(y.kind))).toEqual([
      { ownerSymbolId: "A#run", kind: "param", typeName: "Doc" },
      { ownerSymbolId: "A#run", kind: "return", typeName: "Result" },
    ]);
    expect(await db.anchorIdentifierTypes([])).toEqual([]);
  });

  it("existingSymbolShortNames reads cg_symbols.short_name", async () => {
    await db.upsertSymbols("a.rb", [
      { symbolId: "A#document", fqName: "A#document", shortName: "document", relPath: "a.rb", scope: [] },
    ]);
    expect(await db.existingSymbolShortNames(["document", "doc"])).toEqual(["document"]);
    expect(await db.existingSymbolShortNames([])).toEqual([]);
  });

  // bd tea-rags-mcp-4p3sb.11: the reads behind the lexicon's name-inferred stage,
  // language inference / drift check, and project shape prior.
  describe("naming-lexicon scope reads", () => {
    beforeEach(async () => {
      await db.replaceIdentifiersBulk([
        {
          relPath: "app/a.rb",
          rows: [
            row({ ownerSymbolId: "A#one", name: "doc", typeName: "Doc", typeSource: "binding" }),
            row({ ownerSymbolId: "A#two", name: "doc" }),
            row({ ownerSymbolId: "A#three", kind: "param", name: "doc" }),
            row({ ownerSymbolId: "A#four", name: "row", boundMember: "find", boundReceiver: "Doc" }),
            row({ ownerSymbolId: "A#five", name: "plain" }),
          ],
        },
        {
          relPath: "lib/b.ts",
          rows: [row({ ownerSymbolId: "B#one", name: "doc", typeName: "Doc", typeSource: "annotation" })],
        },
      ]);
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?), (?, ?)", [
        "app/a.rb",
        "ruby",
        "lib/b.ts",
        "typescript",
      ]);
    });

    it("aggregateIdentifiersByName groups by name, kind and effective type, untyped rows as null", async () => {
      expect(await db.aggregateIdentifiersByName({ names: ["doc"], pathPrefixes: ["app/"] })).toEqual([
        { name: "doc", kind: "local", typeName: "Doc", n: 1, exampleOwner: "A#one" },
        { name: "doc", kind: "local", typeName: null, n: 1, exampleOwner: "A#two" },
        { name: "doc", kind: "param", typeName: null, n: 1, exampleOwner: "A#three" },
      ]);
      expect(await db.aggregateIdentifiersByName({ names: ["doc"] })).toContainEqual({
        name: "doc",
        kind: "local",
        typeName: "Doc",
        n: 2,
        exampleOwner: "A#one",
      });
      expect(await db.aggregateIdentifiersByName({ names: [] })).toEqual([]);
    });

    it("identifierLanguageCounts counts scoped rows per file language, largest first", async () => {
      expect(await db.identifierLanguageCounts({})).toEqual([
        { language: "ruby", n: 5 },
        { language: "typescript", n: 1 },
      ]);
      expect(await db.identifierLanguageCounts({ pathPrefixes: ["lib/"] })).toEqual([{ language: "typescript", n: 1 }]);
      expect(await db.identifierLanguageCounts({ pathPrefixes: ["nowhere/"] })).toEqual([]);
    });

    it("identifierLanguageCounts narrows to rel_paths ending in any of `pathSuffixes`, with the prefix", async () => {
      expect(await db.identifierLanguageCounts({ pathSuffixes: [".ts"] })).toEqual([{ language: "typescript", n: 1 }]);
      expect(await db.identifierLanguageCounts({ pathSuffixes: [".rb", ".ts"] })).toEqual([
        { language: "ruby", n: 5 },
        { language: "typescript", n: 1 },
      ]);
      expect(await db.identifierLanguageCounts({ pathPrefixes: ["app/"], pathSuffixes: [".ts"] })).toEqual([]);
      // `%` and `_` in a suffix match literally.
      expect(await db.identifierLanguageCounts({ pathSuffixes: ["_ts"] })).toEqual([]);
      expect(await db.identifierLanguageCounts({ pathSuffixes: [] })).toHaveLength(2);
    });

    it("sampleIdentifierShapes reads only rows carrying a persisted type or a bound callee", async () => {
      const sample = await db.sampleIdentifierShapes({ pathPrefixes: ["app/"], limit: 100 });
      expect(sample).toHaveLength(2);
      expect(sample).toEqual(
        expect.arrayContaining([
          { kind: "local", name: "doc", typeName: "Doc", boundMember: null, boundReceiver: null, n: 1 },
          { kind: "local", name: "row", typeName: null, boundMember: "find", boundReceiver: "Doc", n: 1 },
        ]),
      );
      const bounded = await db.sampleIdentifierShapes({ limit: 1 });
      expect(bounded.reduce((sum, r) => sum + r.n, 0)).toBe(1);
    });

    // A mixed-language project cases each row in its own file's language.
    describe("groupByLanguage splits each group by file language and reports it per row", () => {
      beforeEach(async () => {
        await db.replaceIdentifiersBulk([
          {
            relPath: "vendor/c.kt",
            rows: [row({ ownerSymbolId: "C#one", name: "doc", typeName: "Doc", typeSource: "annotation" })],
          },
        ]);
      });

      it("aggregateIdentifiersByType", async () => {
        const rows = await db.aggregateIdentifiersByType({ types: ["Doc"], groupByLanguage: true });
        expect([...rows].sort((x, y) => String(x.language).localeCompare(String(y.language)))).toEqual([
          {
            typeName: "Doc",
            kind: "local",
            name: "doc",
            typeSource: "annotation",
            n: 1,
            exampleOwner: "C#one",
            language: null,
          },
          {
            typeName: "Doc",
            kind: "local",
            name: "doc",
            typeSource: "binding",
            n: 1,
            exampleOwner: "A#one",
            language: "ruby",
          },
          {
            typeName: "Doc",
            kind: "local",
            name: "doc",
            typeSource: "annotation",
            n: 1,
            exampleOwner: "B#one",
            language: "typescript",
          },
        ]);
      });

      it("aggregateIdentifiersByCallee", async () => {
        expect(
          await db.aggregateIdentifiersByCallee({
            callees: [{ member: "find", receiver: "Doc" }],
            groupByLanguage: true,
          }),
        ).toEqual([
          {
            member: "find",
            receiver: "Doc",
            kind: "local",
            name: "row",
            n: 1,
            exampleOwner: "A#four",
            language: "ruby",
          },
        ]);
      });

      it("aggregateIdentifiersByName", async () => {
        const rows = await db.aggregateIdentifiersByName({ names: ["doc"], groupByLanguage: true });
        expect(rows.filter((r) => r.typeName === "Doc" && r.kind === "local")).toEqual(
          expect.arrayContaining([
            { name: "doc", kind: "local", typeName: "Doc", n: 1, exampleOwner: "A#one", language: "ruby" },
            { name: "doc", kind: "local", typeName: "Doc", n: 1, exampleOwner: "B#one", language: "typescript" },
            { name: "doc", kind: "local", typeName: "Doc", n: 1, exampleOwner: "C#one", language: null },
          ]),
        );
        expect(rows.filter((r) => r.typeName === "Doc" && r.kind === "local")).toHaveLength(3);
      });

      it("sampleIdentifierShapes", async () => {
        const sample = await db.sampleIdentifierShapes({ limit: 100, groupByLanguage: true });
        expect(sample).toEqual(
          expect.arrayContaining([
            {
              kind: "local",
              name: "doc",
              typeName: "Doc",
              boundMember: null,
              boundReceiver: null,
              n: 1,
              language: "ruby",
            },
            {
              kind: "local",
              name: "doc",
              typeName: "Doc",
              boundMember: null,
              boundReceiver: null,
              n: 1,
              language: "typescript",
            },
            {
              kind: "local",
              name: "doc",
              typeName: "Doc",
              boundMember: null,
              boundReceiver: null,
              n: 1,
              language: null,
            },
          ]),
        );
      });
    });
  });

  it("an empty replace batch leaves stored rows alone, and a count over no types is zero", async () => {
    await db.replaceIdentifiersBulk([
      { relPath: "a.rb", rows: [row({ name: "doc", typeName: "Doc", typeSource: "binding" })] },
    ]);
    await db.replaceIdentifiersBulk([]);
    expect(await allRows()).toEqual([{ rel_path: "a.rb", name: "doc" }]);
    expect(await db.countIdentifiers({ types: [] })).toBe(0);
    expect(await db.countIdentifiers({ types: ["Doc"] })).toBe(1);
  });
});
