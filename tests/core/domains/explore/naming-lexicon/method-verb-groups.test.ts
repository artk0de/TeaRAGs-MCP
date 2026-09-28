/**
 * `buildMethodVerbGroups` — the ontology report's `verbs` section as pure
 * domain logic (spec 2026-09-28 naming coverage, §D5).
 */
import { describe, expect, it } from "vitest";

import {
  buildMethodVerbGroups,
  methodVerbLexicons,
} from "../../../../../src/core/domains/explore/naming-lexicon/index.js";

const namespaceOf = (language: string) => (language === "ruby" ? { key: "ruby", casing: "snake" as const } : undefined);
const options = {
  namespaceOf,
  lexicons: new Map([["ruby", new Set(["load", "fetch", "get"])]]),
  limit: 10,
  namesPerGroup: 6,
};
/** A readMethodTailVerbs row spelled by `name` (`load_user` → head `load`, tail `user`). */
const pair = (name: string, holders: number, language: string | null) => {
  const [head, ...tail] = name.replace(/[!?]+$/, "").split("_");
  return { tail: tail.join(""), head, name, holders, language };
};

describe("buildMethodVerbGroups", () => {
  it("drops rows with no file language, no profiled namespace, or no lexicon verb", () => {
    const groups = buildMethodVerbGroups(
      [
        pair("load_user", 2, "ruby"),
        pair("load_user", 5, null),
        pair("load_user", 5, "cobol"),
        pair("user_count", 5, "ruby"),
      ],
      options,
    );
    expect(groups).toEqual([
      { tail: "user", language: "ruby", holders: 2, verbs: [{ verb: "load", holders: 2 }], deviants: [] },
    ]);
  });

  it("keeps a deviant's trailing marker in its suggestion and caps verbs and deviants per group", () => {
    const groups = buildMethodVerbGroups(
      [pair("load_user", 8, "ruby"), pair("fetch_user!", 1, "ruby"), pair("get_user", 1, "ruby")],
      { ...options, namesPerGroup: 1 },
    );
    expect(groups[0].verbs).toEqual([{ verb: "load", holders: 8 }]);
    expect(groups[0].deviants).toEqual([{ name: "fetch_user!", holders: 1, suggestion: "load_user!" }]);
  });
});

describe("methodVerbLexicons", () => {
  it("derives one lexicon per namespace from its languages' head-word rows; unprofiled languages drop", () => {
    const lexicons = methodVerbLexicons(
      [
        { head: "update", headHolders: 2, headTails: 2, lastHolders: 0, language: "ruby" },
        { head: "user", headHolders: 2, headTails: 2, lastHolders: 5, language: "ruby" },
        { head: "sync", headHolders: 9, headTails: 9, lastHolders: 0, language: "cobol" },
        { head: "sync", headHolders: 9, headTails: 9, lastHolders: 0, language: null },
      ],
      namespaceOf,
    );
    expect([...lexicons]).toEqual([["ruby", new Set(["update"])]]);
  });
});
