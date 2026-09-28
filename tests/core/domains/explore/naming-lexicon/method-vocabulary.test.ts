/**
 * `method-vocabulary` — the pure judgement of an untyped method name by the
 * project's own verb vocabulary (spec 2026-09-28 naming coverage, §D4): a noun
 * tail with a dominant verb makes a foreign verb a MISFIT, a verb the project
 * uses conforms, a verbless name is judged by its declaration and last word.
 */
import { describe, expect, it } from "vitest";

import {
  groupMethodsByTail,
  judgeUntypedMethodName,
  methodLastWordPattern,
  methodNounTail,
  methodTailPattern,
  methodVerbOf,
} from "../../../../../src/core/domains/explore/naming-lexicon/index.js";

const verbs = (entries: [string, number][]) => entries.map(([verb, holders]) => ({ verb, holders }));
const names = (entries: [string, number][]) => entries.map(([shortName, holders]) => ({ shortName, holders }));
const none = { verbs: [], tailNames: [], lastWordNames: [], declared: false };

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
        verbs: verbs([["load", 30]]),
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
      evidence: { ...none, tailNames: names([["load_user", 1]]), verbs: verbs([["fetch", 4]]) },
    });
    expect(v).toEqual({ verdict: "CONFORMS" });
  });
  it("NEW_TERM with the project's top verbs when the verb is foreign", () => {
    const v = judgeUntypedMethodName({
      name: "make_user",
      casing: "snake",
      evidence: {
        ...none,
        verbs: verbs([
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
        verbs: verbs([
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

describe("methodVerbOf / methodNounTail", () => {
  it("reads the lexicon verb of a multi-word name in either casing", () => {
    expect(methodVerbOf("load_user")).toBe("load");
    expect(methodVerbOf("loadUser")).toBe("load");
  });
  it("has no verb for a verbless name or a bare verb", () => {
    expect(methodVerbOf("total")).toBeUndefined();
    expect(methodVerbOf("load")).toBeUndefined();
  });
  it("the noun tail drops the verb and the trailing marker", () => {
    expect(methodNounTail("load_user!")).toEqual(["user"]);
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
  it("the tail pattern matches both casings under every lexicon verb", () => {
    const re = new RegExp(methodTailPattern(["user"]));
    for (const s of ["load_user", "fetch_user?", "findUser"]) expect(re.test(s)).toBe(true);
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
