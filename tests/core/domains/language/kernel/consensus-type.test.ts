/** The kernel's consensus over an ambiguous member's candidates (bd tea-rags-mcp-2m83f.42). */

import { describe, expect, it } from "vitest";

import { consensusType } from "../../../../../src/core/domains/language/kernel/consensus-type.js";

const RETURNS: Record<string, string | undefined> = {
  "Client#firm": "Firm",
  "Invoice#firm": "Firm",
  "Task#firm": "Firm",
  "Branch#firm": "Office",
  "Legacy#firm": undefined,
};
const typeOf = (candidate: string): string | undefined => RETURNS[candidate];
const equals = (a: string, b: string): boolean => a === b;

describe("consensusType", () => {
  it("answers the type every candidate agrees on", () => {
    expect(consensusType(["Client#firm", "Invoice#firm", "Task#firm"], typeOf, equals)).toBe("Firm");
  });

  it("refuses when one candidate disagrees", () => {
    expect(consensusType(["Client#firm", "Branch#firm", "Task#firm"], typeOf, equals)).toBeUndefined();
  });

  it("refuses when one candidate's type is unknown", () => {
    expect(consensusType(["Client#firm", "Legacy#firm"], typeOf, equals)).toBeUndefined();
  });

  it("refuses a single candidate — a namesake, not an agreement", () => {
    expect(consensusType(["Client#firm"], typeOf, equals)).toBeUndefined();
    expect(consensusType([], typeOf, equals)).toBeUndefined();
  });

  it("honours a caller-supplied candidate floor", () => {
    expect(consensusType(["Client#firm"], typeOf, equals, 1)).toBe("Firm");
    expect(consensusType(["Client#firm", "Invoice#firm"], typeOf, equals, 3)).toBeUndefined();
  });
});
