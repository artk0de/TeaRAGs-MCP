import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../src/core/contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../../../src/core/contracts/types/language.js";
import { ExternalCallClassifier } from "../../../../src/core/domains/language/external-classifier.js";

const ctx = {} as CallContext;
const fakeVocab: ExternalVocabulary = {
  isBareCallExternal: (m) => m === "render",
  isQualifiedReceiverExternal: (r) => r === "Net::HTTP",
};

describe("ExternalCallClassifier", () => {
  const classifier = new ExternalCallClassifier(fakeVocab);

  it("routes a bare call (receiver null) to isBareCallExternal", () => {
    const ext: CallRef = { callText: "render", receiver: null, member: "render", startLine: 1 };
    const proj: CallRef = { callText: "my_helper", receiver: null, member: "my_helper", startLine: 1 };
    expect(classifier.targetsExternal(ext, ctx)).toBe(true);
    expect(classifier.targetsExternal(proj, ctx)).toBe(false);
  });

  it("routes a qualified call (receiver set) to isQualifiedReceiverExternal", () => {
    const gem: CallRef = { callText: "Net::HTTP.get", receiver: "Net::HTTP", member: "get", startLine: 1 };
    const proj: CallRef = { callText: "User.find", receiver: "User", member: "find", startLine: 1 };
    expect(classifier.targetsExternal(gem, ctx)).toBe(true);
    expect(classifier.targetsExternal(proj, ctx)).toBe(false);
  });

  it("a qualified call to an external member is external even with an untyped receiver", () => {
    const vocab = {
      isBareCallExternal: () => false,
      isQualifiedReceiverExternal: () => false,
      isQualifiedMemberExternal: (m: string) => m === "update",
    };
    const classifier = new ExternalCallClassifier(vocab);
    const call = {
      callText: "agent.update",
      receiver: "agent",
      member: "update",
      startLine: 1,
    };
    expect(classifier.targetsExternal(call, ctx)).toBe(true);
  });

  it("a vocabulary WITHOUT isQualifiedMemberExternal still classifies exactly as before (no regression)", () => {
    const legacyVocab = {
      isBareCallExternal: () => false,
      isQualifiedReceiverExternal: () => false,
    };
    const classifier = new ExternalCallClassifier(legacyVocab);
    const call = {
      callText: "x.foo",
      receiver: "x",
      member: "foo",
      startLine: 1,
    };
    expect(classifier.targetsExternal(call, ctx)).toBe(false);
  });
});
