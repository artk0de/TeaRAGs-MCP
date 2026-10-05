/**
 * bd tea-rags-mcp-m99j1.1.42 — barrier-side candidate expansion of the
 * parameter family's known-target call sites.
 *
 * The walker names a constructor call's callee from ONE file's syntax, so two
 * shapes miss every indexed def: a class reached through a package that only
 * re-exports it, and a class that inherits its constructor. The barrier asks
 * the language's `KnownTargetCalleeLocator` where such a candidate really runs,
 * folds the call into THAT def, and — when the constructor is inherited —
 * hands the asking class the defining class's field links, because the fields
 * that constructor assigns become attributes of the asking class's instance.
 */

import { describe, expect, it } from "vitest";

import type {
  ClassFieldParamLink,
  KnownTargetCallArgs,
  KnownTargetCallee,
  KnownTargetCalleeLocator,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  foldKnownTargetParamTypes,
  inheritConstructorFieldLinks,
  redirectKnownTargetCallArgs,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/call-arg-param-types.js";

const REQUEST = { form: "instance", name: "HttpRequest" } as const;
const OTHER = { form: "instance", name: "Other" } as const;

const site = (targets: string[], argTypes: KnownTargetCallArgs["argTypes"]): KnownTargetCallArgs => ({
  targets,
  argTypes,
});

const locatorOf =
  (answers: Record<string, KnownTargetCallee>): KnownTargetCalleeLocator =>
  (coordinate) =>
    answers[coordinate] ?? null;

const PKG = "pkg/__init__.py::Response#__init__";
const DECL = "pkg/response.py::Response";
const BASE = "pkg/base.py::Base";
const CHILD = "pkg/child.py::Child";

describe("redirectKnownTargetCallArgs — re-exported class", () => {
  const paramNames = { [`${DECL}#__init__`]: ["content"] };
  const locate = locatorOf({ [PKG]: { definingClassKey: DECL, instanceClassKey: DECL } });

  it("folds a candidate the re-export names into the declaring file's def", () => {
    const out = redirectKnownTargetCallArgs([site([PKG], [REQUEST])], paramNames, () => locate);

    expect(foldKnownTargetParamTypes(out.records, out.paramNames)).toEqual({
      [`${DECL}#__init__`]: { content: REQUEST },
    });
    expect(out.inheritedConstructors.size).toBe(0);
  });

  it("joins nothing when the locator cannot name ONE declaring class (an ambiguous re-export)", () => {
    const out = redirectKnownTargetCallArgs([site([PKG], [REQUEST])], paramNames, () => () => null);

    expect(foldKnownTargetParamTypes(out.records, out.paramNames)).toEqual({});
  });

  it("joins nothing when two candidates locate two different classes", () => {
    const other = "pkg/http.py::Response#__init__";
    const locateTwo = locatorOf({
      [PKG]: { definingClassKey: DECL, instanceClassKey: DECL },
      [other]: { definingClassKey: "pkg/other.py::Response", instanceClassKey: "pkg/other.py::Response" },
    });
    const names = { ...paramNames, "pkg/other.py::Response#__init__": ["content"] };

    const out = redirectKnownTargetCallArgs([site([PKG, other], [REQUEST])], names, () => locateTwo);

    expect(foldKnownTargetParamTypes(out.records, out.paramNames)).toEqual({});
  });

  it("never asks the locator about a record a candidate already indexes", () => {
    const direct = `${DECL}#__init__`;
    let asked = 0;
    const counting: KnownTargetCalleeLocator = () => {
      asked++;
      return null;
    };
    const records = [site([PKG, direct], [REQUEST])];

    const out = redirectKnownTargetCallArgs(records, paramNames, () => counting);

    expect(asked).toBe(0);
    expect(out.records).toEqual(records);
    expect(out.paramNames).toBe(paramNames);
  });

  it("leaves a record whose language offers no locator untouched", () => {
    const records = [site(["Fq::Service#initialize"], [REQUEST])];

    const out = redirectKnownTargetCallArgs(records, paramNames, () => undefined);

    expect(out.records).toEqual(records);
    expect(out.paramNames).toBe(paramNames);
  });
});

describe("redirectKnownTargetCallArgs — inherited constructor", () => {
  const paramNames = { [`${BASE}#__init__`]: ["request"] };
  const locate = locatorOf({ [`${CHILD}#__init__`]: { definingClassKey: BASE, instanceClassKey: CHILD } });

  it("folds the call into the ancestor's def AND under the asking class's coordinate", () => {
    const out = redirectKnownTargetCallArgs([site([`${CHILD}#__init__`], [REQUEST])], paramNames, () => locate);

    expect(foldKnownTargetParamTypes(out.records, out.paramNames)).toEqual({
      [`${BASE}#__init__`]: { request: REQUEST },
      [`${CHILD}#__init__`]: { request: REQUEST },
    });
    expect(out.inheritedConstructors.get(CHILD)).toEqual({ definingClassKey: BASE, method: "__init__" });
  });

  it("keeps the asking class's own fold apart from a disagreeing direct construction of the ancestor", () => {
    const records = [site([`${CHILD}#__init__`], [REQUEST]), site([`${BASE}#__init__`], [OTHER])];

    const out = redirectKnownTargetCallArgs(records, paramNames, () => locate);

    expect(foldKnownTargetParamTypes(out.records, out.paramNames)).toEqual({
      [`${CHILD}#__init__`]: { request: REQUEST },
    });
  });

  it("joins nothing when the defining class's constructor names no parameters", () => {
    const out = redirectKnownTargetCallArgs([site([`${CHILD}#__init__`], [REQUEST])], {}, () => locate);

    expect(foldKnownTargetParamTypes(out.records, out.paramNames)).toEqual({});
    expect(out.inheritedConstructors.size).toBe(0);
  });
});

describe("inheritConstructorFieldLinks", () => {
  const baseLinks: Record<string, Record<string, ClassFieldParamLink>> = {
    [BASE]: {
      request: { method: "__init__", param: "request" },
      cache: { method: "setup", param: "cache" },
    },
  };
  const inherited = new Map([[CHILD, { definingClassKey: BASE, method: "__init__" }]]);

  it("hands the asking class the constructor's links — and only the constructor's", () => {
    const out = inheritConstructorFieldLinks(baseLinks, inherited);

    expect(out[CHILD]).toEqual({ request: { method: "__init__", param: "request" } });
    expect(out[BASE]).toEqual(baseLinks[BASE]);
  });

  it("keeps the asking class's own link at a shared field", () => {
    const own = { ...baseLinks, [CHILD]: { request: { method: "configure", param: "req" } } };

    const out = inheritConstructorFieldLinks(own, inherited);

    expect(out[CHILD]).toEqual({ request: { method: "configure", param: "req" } });
  });

  it("returns the links by identity when nothing is inherited", () => {
    expect(inheritConstructorFieldLinks(baseLinks, new Map())).toBe(baseLinks);
  });
});
