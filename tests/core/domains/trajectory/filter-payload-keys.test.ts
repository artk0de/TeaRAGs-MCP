/**
 * The payload keys a filter can condition on (bd tea-rags-mcp-18xh5), learned
 * from the builders a query runs — `FilterDescriptor#toCondition` and the
 * filter-preset compiler — so the declared payload index set covers every key a
 * filter reads without a hand list beside them.
 */

import { describe, expect, it } from "vitest";

import type { FilterPresetDef } from "../../../../src/core/contracts/types/filter-preset.js";
import type { FilterDescriptor } from "../../../../src/core/contracts/types/provider.js";
import { filterPayloadKeys } from "../../../../src/core/domains/trajectory/filter-payload-keys.js";

function descriptor(overrides: Partial<FilterDescriptor> & Pick<FilterDescriptor, "toCondition">): FilterDescriptor {
  return { param: "p", description: "d", type: "string", ...overrides };
}

describe("filterPayloadKeys", () => {
  it("reports each key a descriptor matches, typed by the value it matches", () => {
    const keys = filterPayloadKeys(
      [
        descriptor({ toCondition: (v) => ({ must: [{ key: "owner", match: { value: v } }] }) }),
        descriptor({
          type: "boolean",
          toCondition: (v) => ({ must: [{ key: "flag", match: { value: v } }] }),
        }),
        descriptor({
          toCondition: (v) => ({ must: [{ key: "tags", match: { any: [v] } }] }),
        }),
      ],
      [],
    );

    expect(Object.fromEntries(keys)).toEqual({ owner: "string", flag: "boolean", tags: "string[]" });
  });

  // A range or text match does not say how the value is stored: a timestamp
  // and a count both range. The key is reported, its type left undecided.
  it("reports a range or text key without a matched type", () => {
    const keys = filterPayloadKeys(
      [
        descriptor({
          type: "number",
          toCondition: (v) => ({ must: [{ key: "count", range: { gte: v } }] }),
        }),
        descriptor({ toCondition: (v) => ({ must: [{ key: "path", match: { text: v } }] }) }),
      ],
      [],
    );

    expect(Object.fromEntries(keys)).toEqual({ count: undefined, path: undefined });
  });

  it("probes an enumerated descriptor with every value it declares", () => {
    const keys = filterPayloadKeys(
      [
        descriptor({
          values: ["only", "exclude", "include"],
          toCondition: (v) => {
            if (v === "only") return { must: [{ key: "isA", match: { value: true } }] };
            if (v === "exclude") return { must_not: [{ key: "isB", match: { value: true } }] };
            return {};
          },
        }),
      ],
      [],
    );

    expect([...keys.keys()].sort()).toEqual(["isA", "isB"]);
  });

  it("probes a level-aware descriptor at both payload levels", () => {
    const keys = filterPayloadKeys(
      [
        descriptor({
          type: "number",
          toCondition: (v, level = "file") => ({ must: [{ key: `x.${level}.n`, range: { gte: v } }] }),
        }),
      ],
      [],
    );

    expect([...keys.keys()].sort()).toEqual(["x.chunk.n", "x.file.n"]);
  });

  it("walks nested should groups and is_empty guards", () => {
    const keys = filterPayloadKeys(
      [
        descriptor({
          toCondition: (v) => ({
            must: [
              {
                should: [
                  { key: "a", match: { value: v } },
                  { key: "b", match: { value: v } },
                ],
              },
            ],
            must_not: [{ is_empty: { key: "c" } }],
          }),
        }),
      ],
      [],
    );

    expect([...keys.keys()].sort()).toEqual(["a", "b", "c"]);
  });

  // The compiler is the rule a preset query runs: the logical key maps to its
  // physical path, an ageDays range becomes a lastModifiedAt range, and the
  // isTest exclusion expands to the shared test-exclusion conditions.
  it("reports the keys a filter preset compiles to", () => {
    const preset: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [
        { signal: "git.file.ageDays", op: "gte", value: 30 },
        { signal: "isTest", op: "eq", value: true, occur: "must_not" },
        { signal: "codegraph.file.fanIn", op: "gte", value: 3, occur: "should" },
      ],
    };

    const keys = filterPayloadKeys([], [preset]);

    expect([...keys.keys()].sort()).toEqual([
      "codegraph.symbols.file.fanIn",
      "codegraph.symbols.file.skippedAs",
      "git.file.lastModifiedAt",
      "isTest",
    ]);
    expect(keys.get("isTest")).toBe("boolean");
  });
});
