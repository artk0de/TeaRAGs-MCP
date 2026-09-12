/**
 * Python framework-vocabulary activation (bd tea-rags-mcp-w205u.1).
 *
 * The Ruby rule, transplanted: a framework's grammar is composed only when the
 * project DECLARES the framework, and a project with no manifest at all gets the
 * full catalogue rather than an empty one. Absence of a manifest is absence of
 * evidence — silence there must not switch a vocabulary off, or every fixture,
 * spike and un-packaged script would silently lose its typing.
 *
 * The gate is data on the vocabulary module (`activatedBy`), never a branch at
 * the call site, so the next arm declares its own family and nothing else moves.
 */
import { describe, expect, it } from "vitest";

import {
  filterActivePythonFrameworks,
  PYTHON_FRAMEWORKS,
  pythonVocabularyFor,
} from "../../../../../src/core/domains/language/python/vocabulary/frameworks/index.js";

describe("pythonVocabularyFor", () => {
  it("keeps the Django manager-factory facet active when NO manifest was found", () => {
    expect(pythonVocabularyFor(undefined).hasFacet("classBodyManagerFactory")).toBe(true);
    expect(pythonVocabularyFor(null).hasFacet("classBodyManagerFactory")).toBe(true);
  });

  it("keeps it active when the declared set names django", () => {
    expect(pythonVocabularyFor(new Set(["django", "psycopg"])).hasFacet("classBodyManagerFactory")).toBe(true);
  });

  it("switches it off when a manifest exists and does not name django", () => {
    expect(pythonVocabularyFor(new Set(["flask", "httpx"])).hasFacet("classBodyManagerFactory")).toBe(false);
  });

  it("switches it off for a manifest that declares nothing at all", () => {
    expect(pythonVocabularyFor(new Set<string>()).hasFacet("classBodyManagerFactory")).toBe(false);
  });

  it("matches the activation family EXACTLY — django-filter is not django", () => {
    expect(
      pythonVocabularyFor(new Set(["django-filter", "djangorestframework"])).hasFacet("classBodyManagerFactory"),
    ).toBe(false);
  });

  it("memoises the catalogue per declared-set instance", () => {
    const declared = new Set(["django"]);
    expect(pythonVocabularyFor(declared)).toBe(pythonVocabularyFor(declared));
  });
});

describe("filterActivePythonFrameworks", () => {
  it("returns every framework when the declared set is null (gating off)", () => {
    expect(filterActivePythonFrameworks(PYTHON_FRAMEWORKS, null)).toEqual(PYTHON_FRAMEWORKS);
  });

  it("drops a gated framework whose activation family the project does not declare", () => {
    const active = filterActivePythonFrameworks(PYTHON_FRAMEWORKS, new Set(["flask"]));
    expect(active.map((f) => f.framework)).not.toContain("django");
  });

  it("keeps every UNCONDITIONAL framework — one with no activatedBy is never gated", () => {
    const unconditional = PYTHON_FRAMEWORKS.filter((f) => f.activatedBy === undefined).map((f) => f.framework);
    const active = filterActivePythonFrameworks(PYTHON_FRAMEWORKS, new Set(["flask"])).map((f) => f.framework);
    for (const name of unconditional) expect(active).toContain(name);
  });
});
