/**
 * `method-vocabulary` — the pure judgement of an untyped method name by the
 * project's own verb vocabulary (spec 2026-09-28 naming coverage, §D4, revised
 * after live validation): a verb the project uses conforms, a rare one is a
 * NEW_TERM, a verbless name is judged by its declaration and last word. No verb
 * is a MISFIT for another verb of its noun tail — `find_user` and `build_user`
 * are distinct operations, not synonyms.
 */
import { describe, expect, it } from "vitest";

import {
  deriveMethodVerbLexicon,
  groupMethodsByTail,
  judgeUntypedMethodName,
  methodLastWordPattern,
  methodNounTail,
  methodVerbOf,
} from "../../../../../src/core/domains/explore/naming-lexicon/index.js";

/** Every verb the fixtures below use — the lexicon the judgement reads verbs by. */
const LEXICON: ReadonlySet<string> = new Set([
  "load",
  "fetch",
  "find",
  "get",
  "read",
  "build",
  "create",
  "new",
  "make",
]);
/** Head-word rows: `holders` names opened, two tails each, never a last word. */
const verbs = (entries: [string, number][]) =>
  entries.map(([head, headHolders]) => ({ head, headHolders, headTails: 2, lastHolders: 0, valueCompounds: 0 }));
const names = (entries: [string, number][]) => entries.map(([shortName, holders]) => ({ shortName, holders }));
const none = { lexicon: LEXICON, headWords: [], lastWordNames: [], declared: false };

describe("judgeUntypedMethodName", () => {
  it("a lexicon verb the project holds too rarely is a NEW_TERM, whatever verb its tail favours", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user",
      casing: "snake",
      evidence: { ...none, headWords: verbs([["load", 30]]) },
    });
    expect(v).toEqual({ verdict: "NEW_TERM", topTerms: ["load"] });
  });
  it("a trailing ! or ? does not change the verb's verdict", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user!",
      casing: "snake",
      evidence: { ...none, headWords: verbs([["fetch", 3]]) },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });
  it("a verb the project holds conforms, whatever verb its tail's other names use", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user",
      casing: "snake",
      evidence: { ...none, headWords: verbs([["fetch", 4]]) },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });
  it("a verb other names of its tail never use conforms — no synonym MISFIT", () => {
    // `find_user` ×7 beside `build_user`: finding and building are distinct operations.
    const v = judgeUntypedMethodName({
      name: "build_user",
      casing: "snake",
      evidence: {
        ...none,
        headWords: verbs([
          ["find", 7],
          ["build", 5],
        ]),
      },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });
  it("NEW_TERM with the project's top verbs when the verb is foreign", () => {
    const v = judgeUntypedMethodName({
      name: "make_user",
      casing: "snake",
      evidence: {
        ...none,
        headWords: verbs([
          ["load", 9],
          ["build", 3],
          ["make", 1],
        ]),
      },
    });
    expect(v).toEqual({ verdict: "NEW_TERM", topTerms: ["load", "build"] });
  });
  it("a camelCase draft is read by the same lexicon", () => {
    const v = judgeUntypedMethodName({
      name: "fetchUser",
      casing: "camel",
      evidence: { ...none, headWords: verbs([["fetch", 4]]) },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });
  it("a verbless name declared elsewhere conforms", () => {
    expect(judgeUntypedMethodName({ name: "total", casing: "snake", evidence: { ...none, declared: true } })).toEqual({
      verdict: "CONFORMS",
    });
  });
  it("a verbless new name gets analogues sharing its last word", () => {
    const v = judgeUntypedMethodName({
      name: "process_payment",
      casing: "snake",
      evidence: {
        ...none,
        lastWordNames: names([
          ["capture_payment", 3],
          ["refund_payment", 2],
        ]),
      },
    });
    expect(v).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: ["capture_payment", "refund_payment"] } });
  });
  it("NO_CONVENTION analogues exclude the draft's own name and cap at 5, heaviest first", () => {
    const v = judgeUntypedMethodName({
      name: "process_payment",
      casing: "snake",
      evidence: {
        ...none,
        lastWordNames: names([
          ["a_payment", 1],
          ["process_payment", 50],
          ["b_payment", 6],
          ["c_payment", 5],
          ["d_payment", 4],
          ["e_payment", 3],
          ["f_payment", 2],
        ]),
      },
    });
    expect(v).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { analogous: ["b_payment", "c_payment", "d_payment", "e_payment", "f_payment"] },
    });
  });
  it("NEW_TERM caps at 5 verbs and excludes the draft's own verb", () => {
    const v = judgeUntypedMethodName({
      name: "new_user",
      casing: "snake",
      evidence: {
        ...none,
        headWords: verbs([
          ["find", 2],
          ["get", 8],
          ["new", 1],
          ["fetch", 7],
          ["load", 6],
          ["read", 5],
          ["build", 4],
          ["create", 3],
        ]),
      },
    });
    expect(v).toEqual({ verdict: "NEW_TERM", topTerms: ["get", "fetch", "load", "read", "build"] });
  });
});

describe("judgeUntypedMethodName with a derived lexicon", () => {
  const lexicon = deriveMethodVerbLexicon([
    { head: "update", headHolders: 4, headTails: 2, lastHolders: 0, valueCompounds: 0 },
    { head: "sync", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
    { head: "can", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
    { head: "user", headHolders: 1, headTails: 2, lastHolders: 6, valueCompounds: 0 },
  ]);
  const headWords = [
    { head: "update", headHolders: 4, headTails: 2, lastHolders: 0, valueCompounds: 0 },
    { head: "sync", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
    { head: "can", headHolders: 2, headTails: 2, lastHolders: 0, valueCompounds: 0 },
  ];

  it("a verb outside NAMING_VERB_PREFIXES the project holds conforms beside another verb of its tail", () => {
    const v = judgeUntypedMethodName({
      name: "sync_user",
      casing: "snake",
      evidence: { ...none, lexicon, headWords },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });

  it("a predicate head the project uses conforms, marker and all", () => {
    const v = judgeUntypedMethodName({
      name: "can_resolve?",
      casing: "snake",
      evidence: { ...none, lexicon, headWords },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });

  it("a head outside the lexicon is verbless, however many lexicon verbs its tail carries", () => {
    const v = judgeUntypedMethodName({
      name: "modify_user",
      casing: "snake",
      evidence: { ...none, lexicon, headWords },
    });
    expect(v).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });

  it("a head the lexicon does not hold is verbless", () => {
    const v = judgeUntypedMethodName({
      name: "user_name",
      casing: "snake",
      evidence: { ...none, lexicon, headWords, lastWordNames: names([["full_name", 2]]) },
    });
    expect(v).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: ["full_name"] } });
  });
});
describe("deriveMethodVerbLexicon", () => {
  it("keeps a head opening two tails more often than it ends names", () => {
    const lexicon = deriveMethodVerbLexicon([
      { head: "update", headHolders: 5, headTails: 3, lastHolders: 0, valueCompounds: 0 },
      { head: "user", headHolders: 1, headTails: 2, lastHolders: 7, valueCompounds: 0 },
      { head: "load", headHolders: 3, headTails: 1, lastHolders: 0, valueCompounds: 0 },
      { head: "sync", headHolders: 2, headTails: 2, lastHolders: 2, valueCompounds: 0 },
    ]);
    expect([...lexicon]).toEqual(["update"]);
  });

  it("sums the language rows of one namespace before applying the criterion", () => {
    const lexicon = deriveMethodVerbLexicon([
      { head: "update", headHolders: 1, headTails: 1, lastHolders: 0, valueCompounds: 0, language: "typescript" },
      { head: "update", headHolders: 1, headTails: 1, lastHolders: 0, valueCompounds: 0, language: "javascript" },
      { head: "order", headHolders: 2, headTails: 2, lastHolders: 1, valueCompounds: 0, language: "typescript" },
      { head: "order", headHolders: 0, headTails: 0, lastHolders: 3, valueCompounds: 0, language: "javascript" },
    ]);
    expect([...lexicon]).toEqual(["update"]);
  });

  it("drops a head whose compounds name two values — a noun modifier, not a verb", () => {
    // `pagination_collection` and `pagination_params` are also names of values: `pagination` modifies nouns.
    const lexicon = deriveMethodVerbLexicon([
      { head: "build", headHolders: 126, headTails: 90, lastHolders: 0, valueCompounds: 0 },
      { head: "fetch", headHolders: 21, headTails: 15, lastHolders: 0, valueCompounds: 1 },
      { head: "pagination", headHolders: 51, headTails: 4, lastHolders: 0, valueCompounds: 2 },
    ]);
    expect([...lexicon]).toEqual(["build", "fetch"]);
  });

  it("sums valueCompounds across the language rows of one namespace", () => {
    const lexicon = deriveMethodVerbLexicon([
      { head: "media", headHolders: 30, headTails: 5, lastHolders: 10, valueCompounds: 1, language: "typescript" },
      { head: "media", headHolders: 12, headTails: 3, lastHolders: 6, valueCompounds: 1, language: "javascript" },
      { head: "update", headHolders: 4, headTails: 2, lastHolders: 0, valueCompounds: 1, language: "typescript" },
    ]);
    expect([...lexicon]).toEqual(["update"]);
  });
});
describe("methodVerbOf / methodNounTail", () => {
  it("reads the lexicon verb of a multi-word name in either casing", () => {
    expect(methodVerbOf("load_user", LEXICON)).toBe("load");
    expect(methodVerbOf("loadUser", LEXICON)).toBe("load");
  });
  it("has no verb for a verbless name, a bare verb, or a head outside the lexicon", () => {
    expect(methodVerbOf("total", LEXICON)).toBeUndefined();
    expect(methodVerbOf("load", LEXICON)).toBeUndefined();
    expect(methodVerbOf("update_user", LEXICON)).toBeUndefined();
    expect(methodVerbOf("update_user", new Set(["update"]))).toBe("update");
  });
  it("the noun tail drops the verb and the trailing marker", () => {
    expect(methodNounTail("load_user!", LEXICON)).toEqual(["user"]);
  });
});

describe("groupMethodsByTail", () => {
  it("groups verbed names by noun tail, verbs heaviest first, verbless names dropped", () => {
    const groups = groupMethodsByTail(
      names([
        ["load_user", 3],
        ["loadUser", 2],
        ["fetch_user", 1],
        ["find_user_name", 4],
        ["total", 9],
      ]),
      LEXICON,
    );
    expect([...groups.keys()].sort()).toEqual(["user", "user_name"]);
    expect(groups.get("user")).toEqual([
      { verb: "load", holders: 5, name: "load_user" },
      { verb: "fetch", holders: 1, name: "fetch_user" },
    ]);
    expect(groups.get("user_name")).toEqual([{ verb: "find", holders: 4, name: "find_user_name" }]);
  });
});

describe("method name patterns", () => {
  it("the last-word pattern matches suffix words only", () => {
    const re = new RegExp(methodLastWordPattern("payment"));
    for (const s of ["capture_payment", "payment", "capturePayment"]) expect(re.test(s)).toBe(true);
    for (const s of ["payments", "repayment"]) expect(re.test(s)).toBe(false);
  });
});
