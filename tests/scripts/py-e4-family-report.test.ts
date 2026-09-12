/**
 * The source-reading half of the family report — what an `import` statement
 * actually BINDS.
 *
 * `from polar.subscription.service import subscription as subscription_service`
 * binds ONE name, and the whitespace split bound two: an annotated parameter
 * spelled `subscription` then read as import-bound, and 8 polar rows landed in
 * `moduleAliasMember` that belong to E4.1's population (bd tea-rags-mcp-w205u,
 * E4.6a decision 1a). The classifier is only as honest as this set.
 */
import { describe, expect, it } from "vitest";

import { collectImportBindings, collectTypeVarNames } from "../../scripts/py-e4-family-report.js";

const bound = (...lines: string[]): string[] => [...collectImportBindings(lines)].sort();

describe("collectImportBindings", () => {
  it("binds ONLY the alias of a `from … import x as y`", () => {
    expect(bound("from polar.subscription.service import subscription as subscription_service")).toEqual([
      "subscription_service",
    ]);
  });

  it("binds an unaliased name under its own spelling", () => {
    expect(bound("from ..components import datatable, description_list")).toEqual(["datatable", "description_list"]);
  });

  it("mixes aliased and unaliased clauses in one statement", () => {
    expect(bound("from flask import current_app, g as ctx_globals")).toEqual(["ctx_globals", "current_app"]);
  });

  it("reads the parenthesised multi-line form polar writes", () => {
    expect(
      bound("from polar.models import (", "    Benefit,", "    Order as OrderModel,", "    Subscription,", ")"),
    ).toEqual(["Benefit", "OrderModel", "Subscription"]);
  });

  it("binds the top package of a plain `import a.b` and the alias of `import a.b as c`", () => {
    expect(bound("import os.path", "import numpy as np")).toEqual(["np", "os"]);
  });

  it("ignores a line that only mentions the word import", () => {
    expect(bound("# import subscription as subscription_service", "x = 1")).toEqual([]);
  });
});

describe("collectTypeVarNames", () => {
  it("reads a TypeVar binding", () => {
    expect([...collectTypeVarNames(['T = TypeVar("T")', "x = 1"])]).toEqual(["T"]);
  });
});
