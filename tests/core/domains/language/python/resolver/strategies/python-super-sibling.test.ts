/**
 * `super()` answering from a SIBLING branch, because the legacy walk read a
 * namesake's hierarchy (bd tea-rags-mcp-w205u, E4.4c).
 *
 * `ctx.classExtends` is run-global and keyed by the class SHORT NAME, so polar's
 * eight `class *DoesNotExist` declarations share three map entries between them
 * and the last file walked wins. `checkout/service.py:178` declares
 * `class CheckoutDoesNotExist(CheckoutError)`; `checkout/tasks.py:20` declares
 * `class CheckoutDoesNotExist(CheckoutTaskError)`; the map holds the second, and
 * `resolveSuperViaClassExtends` walked it to `PolarTaskError#__init__` — a class
 * that is not on the caller's MRO at all. Three rows, all polar, measured.
 *
 * The MRO channel does not have the defect: `classAncestors` is keyed by the
 * FILE-QUALIFIED class key, and it recorded `CheckoutError` correctly. It loses
 * anyway because `PolarError(Exception)` leaves the closure `unknown` — polar's
 * exception bases are builtins the vocabulary does not carry — and on a
 * non-`closed` closure the legacy walk answers FIRST by design (netbox's
 * star-import truncation is why).
 *
 * So the fix is neither channel's order: it is that the legacy walk must not
 * start from a base the enclosing class does not actually have. Where the two
 * channels agree nothing moves, and a walker-v2 index carries no `classAncestors`
 * to disagree with.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonAncestorLinearizerCache } from "../../../../../../../src/core/domains/language/python/resolver/python-ancestor-policy.js";
import { PythonImportFileMapper } from "../../../../../../../src/core/domains/language/python/resolver/python-import-file-mapper.js";
import { PythonSuperSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/python/resolver/strategies/python-super.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const SERVICE = "polar/checkout/service.py";
const TASKS = "polar/checkout/tasks.py";
const EXCEPTIONS = "polar/exceptions.py";

function tableWith(files: Record<string, readonly string[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((symbolId) => ({
        symbolId,
        fqName: symbolId,
        shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
        relPath,
        scope: [],
      })),
    );
  }
  return table;
}

const TABLE: Record<string, readonly string[]> = {
  [EXCEPTIONS]: ["PolarError", "PolarError#__init__", "PolarTaskError", "PolarTaskError#__init__"],
  [SERVICE]: ["CheckoutError", "CheckoutDoesNotExist", "CheckoutDoesNotExist#__init__"],
  [TASKS]: ["CheckoutTaskError", "CheckoutDoesNotExist", "CheckoutDoesNotExist#__init__"],
};

/** The namesake in `tasks.py` won the run-global map — polar's measured state. */
const COLLIDED_EXTENDS: Record<string, string> = {
  CheckoutDoesNotExist: "CheckoutTaskError",
  CheckoutTaskError: "PolarTaskError",
  CheckoutError: "PolarError",
  PolarTaskError: "PolarError",
};

function ctxWith(spec: {
  readonly classAncestors?: Record<string, readonly string[]>;
  readonly classExtends?: Record<string, string>;
}): CallContext {
  return {
    callerFile: SERVICE,
    callerScope: ["CheckoutDoesNotExist", "__init__"],
    imports: [],
    symbolTable: tableWith(TABLE),
    classExtends: spec.classExtends ?? COLLIDED_EXTENDS,
    ...(spec.classAncestors === undefined ? {} : { classAncestors: spec.classAncestors }),
  };
}

/** `PolarError(Exception)` — a builtin base the vocabulary misses, so `unknown`. */
const REAL_ANCESTORS: Record<string, readonly string[]> = {
  [`${SERVICE}::CheckoutDoesNotExist`]: ["CheckoutError"],
  [`${SERVICE}::CheckoutError`]: ["polar.exceptions::PolarError"],
  [`${EXCEPTIONS}::PolarError`]: ["Exception"],
  [`${EXCEPTIONS}::PolarTaskError`]: ["PolarError"],
};

/** The base the run-global map names, recorded under the caller's OWN key — the channels agree. */
const TRUNCATED_ANCESTORS: Record<string, readonly string[]> = {
  [`${SERVICE}::CheckoutDoesNotExist`]: ["CheckoutTaskError"],
};

const superInit: CallRef = {
  callText: "super().__init__(message)",
  receiver: "super()",
  member: "__init__",
  startLine: 182,
};

function superStrategy(): PythonSuperSymbolResolutionStrategy {
  const mapper = new PythonImportFileMapper();
  return new PythonSuperSymbolResolutionStrategy(
    { mode: "strict" },
    new PythonAncestorLinearizerCache(mapper, "strict"),
  );
}

describe("PythonSuperSymbolResolutionStrategy — a namesake's hierarchy in `classExtends`", () => {
  it("answers the caller's OWN base, never the namesake's sibling branch", () => {
    expect(superStrategy().attempt(superInit, ctxWith({ classAncestors: REAL_ANCESTORS }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: EXCEPTIONS, targetSymbolId: "PolarError#__init__" },
    });
  });

  it("keeps the legacy walk where the two channels AGREE", () => {
    // netbox's shape: the MRO stops at a base no file pins, so the legacy walk
    // is the ONLY thing that can answer, and `PolarTaskError#__init__` here is
    // the answer it has always given. Nothing about this row may move.
    expect(superStrategy().attempt(superInit, ctxWith({ classAncestors: TRUNCATED_ANCESTORS }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: EXCEPTIONS, targetSymbolId: "PolarTaskError#__init__" },
    });
  });

  it("agrees through a QUALIFIED spelling — the class NAME is what is compared", () => {
    const ancestors = { [`${SERVICE}::CheckoutDoesNotExist`]: ["vendor.tasks::CheckoutTaskError"] };
    expect(superStrategy().attempt(superInit, ctxWith({ classAncestors: ancestors }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: EXCEPTIONS, targetSymbolId: "PolarTaskError#__init__" },
    });
  });

  it("agrees through a star-import DISJUNCTION — every alternative carries the name", () => {
    // `class ChangeLoggedModel(ChangeLoggingMixin, …)` under `from … import *`:
    // the walker writes the alternatives and no file pins one, which is exactly
    // the truncation the legacy walk exists to cover.
    const ancestors = {
      [`${SERVICE}::CheckoutDoesNotExist`]: ["CheckoutTaskError|vendor.tasks::CheckoutTaskError"],
    };
    expect(superStrategy().attempt(superInit, ctxWith({ classAncestors: ancestors }))).toEqual({
      kind: "resolved",
      target: { targetRelPath: EXCEPTIONS, targetSymbolId: "PolarTaskError#__init__" },
    });
  });

  it("keeps the legacy walk on a walker-v2 index, which records no ancestors to disagree with", () => {
    expect(superStrategy().attempt(superInit, ctxWith({}))).toEqual({
      kind: "resolved",
      target: { targetRelPath: EXCEPTIONS, targetSymbolId: "PolarTaskError#__init__" },
    });
  });
});
