/**
 * `buildMethodVerbGroups` — the ontology report's `verbs` section as pure
 * domain logic (spec 2026-09-28 naming coverage, §D5).
 */
import { describe, expect, it } from "vitest";

import {
  buildMethodVerbGroups,
  methodVerbHeadPattern,
  NAMING_VERB_PREFIXES,
} from "../../../../../src/core/domains/explore/naming-lexicon/index.js";

const options = {
  namespaceOf: (language: string) => (language === "ruby" ? { key: "ruby", casing: "snake" as const } : undefined),
  limit: 10,
  namesPerGroup: 6,
};

describe("buildMethodVerbGroups", () => {
  it("drops rows with no file language, no profiled namespace, or no lexicon verb", () => {
    const groups = buildMethodVerbGroups(
      [
        { shortName: "load_user", holders: 2, language: "ruby" },
        { shortName: "load_user", holders: 5, language: null },
        { shortName: "load_user", holders: 5, language: "cobol" },
        { shortName: "user_count", holders: 5, language: "ruby" },
      ],
      options,
    );
    expect(groups).toEqual([
      { tail: "user", language: "ruby", holders: 2, verbs: [{ verb: "load", holders: 2 }], deviants: [] },
    ]);
  });

  it("keeps a deviant's trailing marker in its suggestion and caps verbs and deviants per group", () => {
    const groups = buildMethodVerbGroups(
      [
        { shortName: "load_user", holders: 8, language: "ruby" },
        { shortName: "fetch_user!", holders: 1, language: "ruby" },
        { shortName: "get_user", holders: 1, language: "ruby" },
      ],
      { ...options, namesPerGroup: 1 },
    );
    expect(groups[0].verbs).toEqual([{ verb: "load", holders: 8 }]);
    expect(groups[0].deviants).toEqual([{ name: "fetch_user!", holders: 1, suggestion: "load_user!" }]);
  });
});

describe("methodVerbHeadPattern", () => {
  it("anchors every lexicon verb before a snake or camel word boundary", () => {
    const pattern = new RegExp(methodVerbHeadPattern());
    expect(methodVerbHeadPattern()).toBe(`^(?:${NAMING_VERB_PREFIXES.join("|")})(?:_|[A-Z])`);
    expect(pattern.test("load_user")).toBe(true);
    expect(pattern.test("loadUser")).toBe(true);
    expect(pattern.test("loader")).toBe(false);
    expect(pattern.test("load")).toBe(false);
  });
});
