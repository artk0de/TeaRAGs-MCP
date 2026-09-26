/**
 * bd tea-rags-mcp-emazx — walker half of the entry-narrowing ARGUMENT channel.
 *
 * Two call-level facts, both SILENT rather than approximate:
 *   - `CallRef.positionalArgAtoms` — per POSITION, an identifier-shaped Symbol /
 *     String literal (`:manage_datev`, `"read"`) or a bare identifier
 *     (`ability`); anything else is a `null` slot, the list stops at the first
 *     argument that breaks positional correspondence (splat, keyword pair,
 *     block-pass), trailing nulls are trimmed and an all-null list is absent;
 *   - `CallRef.sendNameTemplate` — on a `send` / `public_send` / `__send__`
 *     whose name is an interpolated string or symbol with EXACTLY ONE
 *     interpolation of a bare identifier: the text around the hole and the
 *     identifier that fills it. Anything computed yields no template.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

function callsIn(body: string[]): CallRef[] {
  const src = ["class A", "  def go(ability, x)", ...body.map((l) => `    ${l}`), "  end", "end", ""].join("\n");
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const tree = parser.parse(src);
  const ex = extractFromRubyFile({
    tree,
    code: src,
    relPath: "a.rb",
    language: "ruby",
    chunks: [{ symbolId: "A#go", startLine: 2, endLine: 3 + body.length, scope: ["A"] }],
  });
  return ex.chunks.find((c) => c.symbolId === "A#go")?.calls ?? [];
}

function callTo(calls: CallRef[], member: string): CallRef | undefined {
  return calls.find((c) => c.member === member);
}

describe("ruby walker — positional argument atoms (emazx)", () => {
  it("records literal Symbol/String names and bare identifiers by position", () => {
    const calls = callsIn(["FirmPolicy.authorize!(@user, @actor, :manage_datev, @firm)"]);
    expect(callTo(calls, "authorize!")?.positionalArgAtoms).toEqual([null, null, { literal: "manage_datev" }]);
  });

  it("reads a double-quoted string literal as a name literal", () => {
    const calls = callsIn(['Policy.authorize(user, "read")']);
    expect(callTo(calls, "authorize")?.positionalArgAtoms).toEqual([{ identifier: "user" }, { literal: "read" }]);
  });

  it("records a bare identifier forwarded through a self-instantiation", () => {
    const calls = callsIn(["new(a, b).authorize!(ability)"]);
    expect(callTo(calls, "authorize!")?.positionalArgAtoms).toEqual([{ identifier: "ability" }]);
  });

  it("stops at a keyword pair — later positions are not positional", () => {
    const calls = callsIn(["Policy.authorize!(u, ability: :read)"]);
    expect(callTo(calls, "authorize!")?.positionalArgAtoms).toEqual([{ identifier: "u" }]);
  });

  it("stops at a splat", () => {
    const calls = callsIn(["Policy.authorize!(*args, :read)"]);
    expect(callTo(calls, "authorize!")?.positionalArgAtoms).toBeUndefined();
  });

  it("is absent when no argument is a name literal or identifier", () => {
    const calls = callsIn(["Policy.authorize!(@u, 1, x.y)"]);
    expect(callTo(calls, "authorize!")?.positionalArgAtoms).toBeUndefined();
  });

  it("does not read a non-identifier-shaped string as a name", () => {
    const calls = callsIn(['I18n.t("some.key")']);
    expect(callTo(calls, "t")?.positionalArgAtoms).toBeUndefined();
  });
});

describe("ruby walker — send name template (emazx)", () => {
  it('captures `send("can_#{ability}?")` as prefix / hole / suffix', () => {
    const calls = callsIn(['send("can_#{ability}?")']);
    expect(callTo(calls, "send")?.sendNameTemplate).toEqual({ prefix: "can_", suffix: "?", identifier: "ability" });
  });

  it('captures the interpolated-symbol form `public_send(:"can_#{ability}?")`', () => {
    const calls = callsIn(['public_send(:"can_#{ability}?")']);
    expect(callTo(calls, "public_send")?.sendNameTemplate).toEqual({
      prefix: "can_",
      suffix: "?",
      identifier: "ability",
    });
  });

  it("keeps an interpolated name a dynamic send — never a phantom call to its first text fragment", () => {
    const calls = callsIn(['send("can_#{ability}?")']);
    expect(calls.map((c) => c.member)).not.toContain("can_");
    expect(callTo(calls, "send")?.dynamicSend).toBe(true);
  });

  it("declines two interpolations", () => {
    const calls = callsIn(['send("can_#{ability}_#{x}")']);
    expect(callTo(calls, "send")?.sendNameTemplate).toBeUndefined();
  });

  it("declines a computed interpolation", () => {
    const calls = callsIn(['send("can_#{ability.to_s}?")']);
    expect(callTo(calls, "send")?.sendNameTemplate).toBeUndefined();
  });

  it("declines an interpolation on a non-dispatch method", () => {
    const calls = callsIn(['log("can_#{ability}?")']);
    expect(callTo(calls, "log")?.sendNameTemplate).toBeUndefined();
  });
});
