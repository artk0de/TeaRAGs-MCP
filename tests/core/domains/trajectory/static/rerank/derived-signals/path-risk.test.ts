import { describe, expect, it } from "vitest";

import { PathRiskSignal } from "../../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/path-risk.js";

describe("PathRiskSignal", () => {
  const signal = new PathRiskSignal();
  const risk = (relativePath: string): number => signal.extract({ relativePath });

  describe("true positives — real security paths", () => {
    it("boosts auth/security/acl segments", () => {
      expect(risk("src/auth/login.ts")).toBe(1);
      expect(risk("src/security/crypto.ts")).toBe(1);
      expect(risk("lib/acl/rules.ts")).toBe(1);
    });

    it("boosts token when an auth-ish sibling token is present", () => {
      expect(risk("auth/token-refresh.ts")).toBe(1);
    });

    it("regression: token-manager file still flagged (token is a real token)", () => {
      expect(risk("lib/token-manager.ts")).toBe(1);
    });
  });

  describe("false positives — substring matches that must NOT boost", () => {
    it("does not flag author-* files (auth substring)", () => {
      expect(risk("domains/trajectory/git/stats/author-counts.ts")).toBe(0);
    });

    it("does not flag accessibility files (access substring)", () => {
      expect(risk("ui/accessibility/helpers.ts")).toBe(0);
    });

    it("does not flag tokenizer/lexer files (token substring)", () => {
      expect(risk("ingest/chunker/tokenizer.ts")).toBe(0);
    });

    it("does not flag data-access files (access substring)", () => {
      expect(risk("data-access/repo.ts")).toBe(0);
    });

    it("does not flag AccessorUtils (camelCase access substring)", () => {
      expect(risk("src/utils/AccessorUtils.ts")).toBe(0);
    });
  });

  it("returns 0 when path missing", () => {
    expect(signal.extract({})).toBe(0);
  });

  it("has correct metadata", () => {
    expect(signal.name).toBe("pathRisk");
    expect(signal.sources).toEqual([]);
  });
});
