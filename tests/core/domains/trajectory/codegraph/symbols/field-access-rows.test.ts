/**
 * `buildFieldAccessRows` — a file's `fieldAccesses` facts as the
 * `cg_symbols_edges_field` rows (bd tea-rags-mcp-zy6hx, D0): one row per
 * (method, owner kind, owner type, receiver, field, access kind), with the
 * access count and the first line it happens on.
 */

import { describe, expect, it } from "vitest";

import type { FieldAccessFact, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { buildFieldAccessRows } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/field-access-rows.js";

function extraction(fieldAccesses?: readonly FieldAccessFact[]): FileExtraction {
  return {
    relPath: "app/models/order.rb",
    language: "ruby",
    imports: [],
    fileScope: [],
    chunks: [],
    ...(fieldAccesses === undefined ? {} : { fieldAccesses }),
  };
}

const self = (line: number, accessKind: FieldAccessFact["accessKind"], fieldName = "@total"): FieldAccessFact => ({
  symbolId: "Order#recalculate",
  ownerKind: "self",
  ownerType: "Order",
  fieldName,
  accessKind,
  line,
});

describe("buildFieldAccessRows", () => {
  it("builds no rows for a file whose extraction carries no facts", () => {
    expect(buildFieldAccessRows(extraction())).toEqual([]);
    expect(buildFieldAccessRows(extraction([]))).toEqual([]);
  });

  it("aggregates repeated accesses of one method into a counted row keeping the first line", () => {
    const rows = buildFieldAccessRows(extraction([self(12, "read"), self(7, "read"), self(9, "read")]));
    expect(rows).toEqual([
      {
        sourceSymbolId: "Order#recalculate",
        ownerKind: "self",
        ownerType: "Order",
        fieldName: "@total",
        accessKind: "read",
        accessCount: 3,
        firstLine: 7,
      },
    ]);
  });

  it("keeps a compound assignment's read and write as two rows", () => {
    const rows = buildFieldAccessRows(extraction([self(4, "read"), self(4, "write")]));
    expect(rows.map((r) => [r.accessKind, r.accessCount, r.firstLine])).toEqual([
      ["read", 1, 4],
      ["write", 1, 4],
    ]);
  });

  it("separates rows by method, owner, receiver and field, and omits absent owner type and receiver", () => {
    const rows = buildFieldAccessRows(
      extraction([
        self(3, "write", "@@count"),
        {
          symbolId: "Order#merge",
          ownerKind: "param",
          ownerType: "Order",
          receiver: "other",
          fieldName: "@total",
          accessKind: "read",
          line: 20,
        },
        {
          symbolId: "Order#merge",
          ownerKind: "unknown",
          receiver: "payload",
          fieldName: "amount",
          accessKind: "read",
          line: 21,
        },
        { symbolId: "Order#merge", ownerKind: "unknown", fieldName: "@cache", accessKind: "unknown", line: 22 },
        {
          symbolId: "Order#merge",
          ownerKind: "param",
          ownerType: "Order",
          receiver: "other",
          fieldName: "@total",
          accessKind: "read",
          line: 25,
        },
      ]),
    );
    expect(rows).toEqual([
      {
        sourceSymbolId: "Order#merge",
        ownerKind: "param",
        ownerType: "Order",
        receiver: "other",
        fieldName: "@total",
        accessKind: "read",
        accessCount: 2,
        firstLine: 20,
      },
      {
        sourceSymbolId: "Order#merge",
        ownerKind: "unknown",
        receiver: "payload",
        fieldName: "amount",
        accessKind: "read",
        accessCount: 1,
        firstLine: 21,
      },
      {
        sourceSymbolId: "Order#merge",
        ownerKind: "unknown",
        fieldName: "@cache",
        accessKind: "unknown",
        accessCount: 1,
        firstLine: 22,
      },
      {
        sourceSymbolId: "Order#recalculate",
        ownerKind: "self",
        ownerType: "Order",
        fieldName: "@@count",
        accessKind: "write",
        accessCount: 1,
        firstLine: 3,
      },
    ]);
  });

  it("does not merge an untyped owner into a typed one with the same field", () => {
    const rows = buildFieldAccessRows(
      extraction([
        { symbolId: "Order#a", ownerKind: "self", ownerType: "Order", fieldName: "@x", accessKind: "read", line: 1 },
        { symbolId: "Order#a", ownerKind: "self", fieldName: "@x", accessKind: "read", line: 2 },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});
