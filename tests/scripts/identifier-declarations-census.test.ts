import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  IdentifierDeclarationsCensusAccumulator,
  runIdentifierDeclarationsCensus,
  type IdentifierDeclarationsCensus,
} from "../../scripts/identifier-declarations-census.js";

/**
 * The Phase 0 size census (bd tea-rags-mcp-4p3sb.7) decides whether untyped
 * declarations stay in `cg_identifiers`. It is only evidence if it walks the
 * corpus production walks and aggregates what the composed walkers emit.
 */
describe("identifier-declarations-census corpus walk", () => {
  let corpus: string;
  let census: IdentifierDeclarationsCensus;

  function write(relPath: string, content: string): void {
    const absolute = join(corpus, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }

  beforeEach(async () => {
    corpus = mkdtempSync(join(tmpdir(), "identifier-census-"));
    write(".contextignore", "app/vendored/\n");
    write(
      "app/service.ts",
      [
        "export class Service {",
        "  private readonly repo: Repository;",
        "  run(input: string, count: number): void {",
        "    const total = count + 1;",
        "    console.log(input, total);",
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    write("app/vendored/ignored.ts", "export function ignored(a: string): string {\n  return a;\n}\n");
    census = await runIdentifierDeclarationsCensus(corpus);
  });

  afterEach(() => {
    rmSync(corpus, { recursive: true, force: true });
  });

  it("walks only what production keeps", () => {
    expect(census.files).toBe(1);
    expect(census.byLanguage.typescript?.files).toBe(1);
    expect(census.parseFailures).toBe(0);
  });

  it("counts typescript params, locals and typed declarations", () => {
    const ts = census.byLanguage.typescript;
    expect(ts).toBeDefined();
    expect(ts?.param).toBe(2);
    expect(ts?.local).toBeGreaterThanOrEqual(1);
    expect(census.declarations).toBe((ts?.param ?? 0) + (ts?.local ?? 0) + (ts?.field ?? 0));
    expect(census.typed).toBe(ts?.typed);
    expect(ts?.byTypeSource.annotation).toBeGreaterThanOrEqual(2);
    expect(ts?.topTypeNames.map((t) => t.typeName)).toContain("string");
    expect(census.estimatedBytes).toBeGreaterThan(0);
  });
});

describe("IdentifierDeclarationsCensusAccumulator", () => {
  it("sums the naive byte estimate over every declaration", () => {
    const acc = new IdentifierDeclarationsCensusAccumulator();
    acc.addFile("a.rb", "ruby", [
      { name: "x", kind: "param", line: 1, ownerSymbolId: "A#b" },
      { name: "yy", kind: "local", line: 2, ownerSymbolId: "A#b", typeName: "Foo", typeSource: "constructor" },
    ]);
    const result = acc.result(0);
    // (4 + 3 + 1 + 0 + 24) + (4 + 3 + 2 + 3 + 24)
    expect(result.estimatedBytes).toBe(32 + 36);
    expect(result.byLanguage.ruby).toMatchObject({ param: 1, local: 1, field: 0, typed: 1, files: 1 });
    expect(result.byLanguage.ruby?.byTypeSource).toEqual({ constructor: 1 });
    expect(result.byLanguage.ruby?.topTypeNames).toEqual([{ typeName: "Foo", count: 1 }]);
  });

  it("counts a file with no declarations but still attributes it to its language", () => {
    const acc = new IdentifierDeclarationsCensusAccumulator();
    acc.addFile("a.py", "python", undefined);
    const result = acc.result(0);
    expect(result.files).toBe(1);
    expect(result.declarations).toBe(0);
    expect(result.byLanguage.python?.files).toBe(1);
  });

  it("records parse failures with a capped sample of reasons", () => {
    const acc = new IdentifierDeclarationsCensusAccumulator();
    for (let i = 0; i < 30; i++) acc.fail(`f${i}.ts`, "boom");
    const result = acc.result(0);
    expect(result.parseFailures).toBe(30);
    expect(result.failedFiles.length).toBeLessThanOrEqual(20);
    expect(result.failedFiles[0]).toEqual({ relPath: "f0.ts", reason: "boom" });
  });

  it("keeps only the ten most frequent type names, most frequent first", () => {
    const acc = new IdentifierDeclarationsCensusAccumulator();
    const decls = Array.from({ length: 12 }, (_, i) =>
      Array.from({ length: i + 1 }, () => ({
        name: "v",
        kind: "local" as const,
        line: 1,
        ownerSymbolId: "f",
        typeName: `T${i}`,
        typeSource: "annotation" as const,
      })),
    ).flat();
    acc.addFile("a.ts", "typescript", decls);
    const top = acc.result(0).byLanguage.typescript?.topTypeNames ?? [];
    expect(top).toHaveLength(10);
    expect(top[0]).toEqual({ typeName: "T11", count: 12 });
    expect(top.map((t) => t.typeName)).not.toContain("T0");
  });
});
