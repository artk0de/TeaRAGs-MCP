/**
 * `method-vocabulary` — the pure judgement of an untyped method name by the
 * project's own verb vocabulary (spec 2026-09-28 naming coverage, §D4): a noun
 * tail with a dominant verb makes a foreign verb a MISFIT, a verb the project
 * uses conforms, a verbless name is judged by its declaration and last word.
 */
import { describe, expect, it } from "vitest";

import {
  deriveMethodVerbLexicon,
  groupMethodsByTail,
  judgeUntypedMethodName,
  methodLastWordPattern,
  methodNounTail,
  methodTailPattern,
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
const none = { lexicon: LEXICON, headWords: [], tailNames: [], lastWordNames: [], declared: false };

describe("judgeUntypedMethodName", () => {
  it("MISFIT when the noun tail has a dominant verb the draft does not use", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user",
      casing: "snake",
      evidence: {
        ...none,
        tailNames: names([
          ["load_user", 7],
          ["fetch_user", 1],
        ]),
        headWords: verbs([["load", 30]]),
      },
    });
    expect(v).toEqual({ verdict: "MISFIT", suggestion: "load_user", holder: "load_user" });
  });
  it("keeps a trailing ! or ? on the suggestion", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user!",
      casing: "snake",
      evidence: { ...none, tailNames: names([["load_user!", 3]]) },
    });
    expect(v).toMatchObject({ verdict: "MISFIT", suggestion: "load_user!" });
  });
  it("no dominance (below 2 holders or 50 %) falls through to the verb vocabulary", () => {
    const v = judgeUntypedMethodName({
      name: "fetch_user",
      casing: "snake",
      evidence: { ...none, tailNames: names([["load_user", 1]]), headWords: verbs([["fetch", 4]]) },
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
  it("camelCase drafts get camelCase suggestions", () => {
    const v = judgeUntypedMethodName({
      name: "fetchUser",
      casing: "camel",
      evidence: { ...none, tailNames: names([["loadUser", 4]]) },
    });
    expect(v).toMatchObject({ verdict: "MISFIT", suggestion: "loadUser" });
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

  it("a verb outside NAMING_VERB_PREFIXES dominating a tail makes another verb a MISFIT", () => {
    const v = judgeUntypedMethodName({
      name: "sync_user",
      casing: "snake",
      evidence: { ...none, lexicon, headWords, tailNames: names([["update_user", 3]]) },
    });
    expect(v).toEqual({ verdict: "MISFIT", suggestion: "update_user", holder: "update_user" });
  });

  it("a predicate head the project uses conforms, marker and all", () => {
    const v = judgeUntypedMethodName({
      name: "can_resolve?",
      casing: "snake",
      evidence: { ...none, lexicon, headWords },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });

  it("a head outside the lexicon on a tail a lexicon verb dominates is a MISFIT — a new synonym verb", () => {
    const v = judgeUntypedMethodName({
      name: "modify_user",
      casing: "snake",
      evidence: { ...none, lexicon, headWords, tailNames: names([["update_user", 5]]) },
    });
    expect(v).toEqual({ verdict: "MISFIT", suggestion: "update_user", holder: "update_user" });
  });

  it("a noun head outside the lexicon is no synonym verb: a dominated tail stays verbless", () => {
    // `user` ends more names than it opens — a noun of the project, so `user_name` is not a verb + `name`.
    const v = judgeUntypedMethodName({
      name: "user_name",
      casing: "snake",
      evidence: {
        ...none,
        tailNames: names([["get_name", 5]]),
        headLastNames: names([["load_user", 3]]),
      },
    });
    expect(v).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });

  it("a head outside the lexicon on a tail no verb dominates is verbless", () => {
    const v = judgeUntypedMethodName({
      name: "modify_order",
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

describe("judgeUntypedMethodName with a value-naming head", () => {
  it("a head whose compounds name values is a project noun: a dominated tail stays verbless", () => {
    // `date_published` opens more names than `date` ends, but two `date_*` compounds name values.
    const v = judgeUntypedMethodName({
      name: "date_published",
      casing: "snake",
      evidence: {
        ...none,
        headWords: [{ head: "date", headHolders: 6, headTails: 4, lastHolders: 2, valueCompounds: 2 }],
        tailNames: names([["set_published", 5]]),
        headLastNames: names([["updated_date", 2]]),
        lexicon: new Set([...LEXICON, "set"]),
      },
    });
    expect(v).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });

  it("one value-naming compound keeps the head a candidate synonym verb", () => {
    const v = judgeUntypedMethodName({
      name: "date_published",
      casing: "snake",
      evidence: {
        ...none,
        headWords: [{ head: "date", headHolders: 6, headTails: 4, lastHolders: 2, valueCompounds: 1 }],
        tailNames: names([["set_published", 5]]),
        headLastNames: names([["updated_date", 2]]),
        lexicon: new Set([...LEXICON, "set"]),
      },
    });
    expect(v).toEqual({ verdict: "MISFIT", suggestion: "set_published", holder: "set_published" });
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
  it("the tail pattern matches both casings under any head word — it enumerates no verbs", () => {
    expect(methodTailPattern(["user"])).toBe("^[a-z][a-z0-9]*(?:_user|User)[!?]?$");
    const re = new RegExp(methodTailPattern(["user"]));
    for (const s of ["load_user", "fetch_user?", "findUser", "updateUser"]) expect(re.test(s)).toBe(true);
    for (const s of ["load_users", "user_load", "loadUserName"]) expect(re.test(s)).toBe(false);
  });
  it("a multi-word tail matches the whole tail in both casings", () => {
    const re = new RegExp(methodTailPattern(["user", "name"]));
    for (const s of ["load_user_name", "loadUserName"]) expect(re.test(s)).toBe(true);
    for (const s of ["load_user", "loadUser"]) expect(re.test(s)).toBe(false);
  });
  it("the last-word pattern matches suffix words only", () => {
    const re = new RegExp(methodLastWordPattern("payment"));
    for (const s of ["capture_payment", "payment", "capturePayment"]) expect(re.test(s)).toBe(true);
    for (const s of ["payments", "repayment"]) expect(re.test(s)).toBe(false);
  });
});
