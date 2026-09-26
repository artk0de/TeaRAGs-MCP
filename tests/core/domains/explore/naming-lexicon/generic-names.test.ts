/**
 * `judgeGenericNames` — the one generic-name judgement behind both
 * `get_ontology_report`'s summary and `get_naming_lexicon`'s draft caveat
 * (bd tea-rags-mcp-4p3sb): a candidate stays generic only when the types it
 * does NOT spell still clear the generic bar.
 */
import { describe, expect, it } from "vitest";

import { judgeGenericNames } from "../../../../../src/core/domains/explore/naming-lexicon/index.js";

const BAR = { minTypes: 5, maxTopTypeShare: 0.5 };
const snake = () => "snake" as const;

function candidate(name: string, types: [string, number][]) {
  return {
    name,
    typeCount: types.length,
    n: types.reduce((s, [, n]) => s + n, 0),
    types: types.map(([typeName, n]) => ({ typeName, n, relPath: "app/x.rb" })),
  };
}

describe("judgeGenericNames", () => {
  it("keeps a name bound to many unrelated types, counting only those; most frequent first", () => {
    const unrelated = (n: number): [string, number][] =>
      ["TypeA", "TypeB", "TypeC", "TypeD", "TypeE"].map((t) => [t, n]);
    expect(
      judgeGenericNames(
        // `result` is TAIL of RunResult: that type is spelled, so its 40 rows neither count nor dominate.
        [candidate("data", unrelated(2)), candidate("result", [...unrelated(3), ["RunResult", 40]])],
        snake,
        BAR,
      ),
    ).toEqual([
      { name: "result", typeCount: 5, n: 15 },
      { name: "data", typeCount: 5, n: 10 },
    ]);
  });

  it("drops the role word of a type family: the types it spells are no evidence of genericity", () => {
    const forms = ["SignupForm", "ActionForm", "ClientForm", "InvoiceForm", "TaskForm"].map((t): [string, number] => [
      t,
      4,
    ]);
    expect(judgeGenericNames([candidate("form", forms)], snake, BAR)).toEqual([]);
  });

  it("drops a name whose remaining types hold a dominant one", () => {
    const skewed: [string, number][] = [
      ["TypeA", 20],
      ["TypeB", 1],
      ["TypeC", 1],
      ["TypeD", 1],
      ["TypeE", 1],
    ];
    expect(judgeGenericNames([candidate("item", skewed)], snake, BAR)).toEqual([]);
  });

  it("asks the casing of each type row's own file, so a mixed-language name is cased per row", () => {
    const seen: [string, string][] = [];
    const casingOf = (relPath: string, name: string) => {
      seen.push([relPath, name]);
      return relPath.endsWith(".ts") ? ("camel" as const) : ("snake" as const);
    };
    const mixed = {
      ...candidate("resultRow", []),
      types: [
        { typeName: "ResultRow", n: 1, relPath: "a.ts" },
        { typeName: "TypeA", n: 1, relPath: "b.rb" },
      ],
    };
    judgeGenericNames([mixed], casingOf, BAR);
    expect(seen).toEqual([
      ["a.ts", "resultRow"],
      ["b.rb", "resultRow"],
    ]);
  });
});
