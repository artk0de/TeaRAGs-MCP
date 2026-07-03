/**
 * Structural unit tests for the STRUCTURED_MACROS registry and its expanders.
 *
 * These tests assert the REGISTRY shape and the dispatch contract introduced by
 * Task B of pg5ya — they do NOT duplicate the behaviour oracle cases already in
 * `macro-expansion.test.ts` (which remain the byte-identical golden source for
 * enum/aasm/state_machine output correctness).
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { expandClassBodyMacros } from "../../../../../../src/core/domains/language/ruby/walker/macro-expansion.js";
import { aasmExpander } from "../../../../../../src/core/domains/language/ruby/walker/structured/aasm.js";
import { enumExpander } from "../../../../../../src/core/domains/language/ruby/walker/structured/enum.js";
import { STRUCTURED_MACROS } from "../../../../../../src/core/domains/language/ruby/walker/structured/index.js";
import { stateMachineExpander } from "../../../../../../src/core/domains/language/ruby/walker/structured/state_machine.js";

// ---------------------------------------------------------------------------
// Parse helpers (mirrors oracle helper pattern)
// ---------------------------------------------------------------------------

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/** First body statement of a class — the macro call node. */
function firstStmt(src: string): Parser.SyntaxNode {
  const tree = parse(src);
  const container = tree.rootNode.namedChildren.find((c) => c.type === "class" || c.type === "module");
  if (!container) throw new Error("no class/module");
  const body = container.childForFieldName("body");
  const stmts = body ? body.namedChildren : container.namedChildren;
  const stmt = stmts.find((s) => s.type === "call" || s.type === "method_call" || s.type === "alias");
  if (!stmt) throw new Error("no statement");
  return stmt;
}

// ---------------------------------------------------------------------------
// STRUCTURED_MACROS registry shape
// ---------------------------------------------------------------------------

describe("STRUCTURED_MACROS registry", () => {
  it("contains exactly three entries: enum, aasm and state_machine", () => {
    expect(STRUCTURED_MACROS).toHaveLength(3);
    expect(STRUCTURED_MACROS.map((e) => e.macroName)).toEqual(["enum", "aasm", "state_machine"]);
  });

  it("enumExpander.macroName is 'enum'", () => {
    expect(enumExpander.macroName).toBe("enum");
  });

  it("aasmExpander.macroName is 'aasm'", () => {
    expect(aasmExpander.macroName).toBe("aasm");
  });

  it("stateMachineExpander.macroName is 'state_machine'", () => {
    expect(stateMachineExpander.macroName).toBe("state_machine");
  });

  it("STRUCTURED_MACROS[0] is the enum expander", () => {
    expect(STRUCTURED_MACROS[0]).toBe(enumExpander);
  });

  it("STRUCTURED_MACROS[1] is the aasm expander", () => {
    expect(STRUCTURED_MACROS[1]).toBe(aasmExpander);
  });

  it("STRUCTURED_MACROS[2] is the state_machine expander", () => {
    expect(STRUCTURED_MACROS[2]).toBe(stateMachineExpander);
  });

  it("an unknown macro name finds no expander in STRUCTURED_MACROS", () => {
    expect(STRUCTURED_MACROS.find((e) => e.macroName === "has_many")).toBeUndefined();
    expect(STRUCTURED_MACROS.find((e) => e.macroName === "attr_accessor")).toBeUndefined();
    expect(STRUCTURED_MACROS.find((e) => e.macroName === "unknown_macro")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatch contract: structured macros take precedence over the operands path;
// unknown macros fall through to operands/empty.
// ---------------------------------------------------------------------------

describe("expandClassBodyMacros — structured dispatch integration", () => {
  it("enum dispatches to enumExpander (not generic operands path)", () => {
    // If enum fell through to the generic operands path it would return [] because
    // RUBY_DSL has no 'enum' catalogue entry — so a non-empty result proves dispatch.
    const out = expandClassBodyMacros(firstStmt("class M\n  enum :status, { active: 0 }\nend\n"));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((m) => m.category === "enum")).toBe(true);
  });

  it("aasm dispatches to aasmExpander (not generic operands path)", () => {
    const out = expandClassBodyMacros(firstStmt("class J\n  aasm do\n    state :sleeping\n  end\nend\n"));
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((m) => m.category === "state-machine")).toBe(true);
  });

  it("state_machine dispatches to stateMachineExpander (not generic operands path)", () => {
    const out = expandClassBodyMacros(
      firstStmt("class V\n  state_machine :status do\n    state :parked\n  end\nend\n"),
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((m) => m.category === "state-machine")).toBe(true);
  });

  it("has_many takes the operands path (not structured)", () => {
    const out = expandClassBodyMacros(firstStmt("class U\n  has_many :posts\nend\n"));
    expect(out.every((m) => m.category === "association")).toBe(true);
  });

  it("unknown_macro not in catalogue or STRUCTURED_MACROS → []", () => {
    expect(expandClassBodyMacros(firstStmt("class X\n  totally_unknown :x\nend\n"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Direct expander.expand calls — one per expander, asserting synthesised names.
// (Smoke tests; the full oracle lives in macro-expansion.test.ts.)
// ---------------------------------------------------------------------------

describe("enumExpander.expand — direct call", () => {
  it("synthesises accessor + per-value predicate/bang given a parsed enum node", () => {
    const node = firstStmt("class M\n  enum :role, { admin: 0, member: 1 }\nend\n");
    const out = enumExpander.expand(node, node.startPosition.row + 1, node.endPosition.row + 1);
    expect(out.map((m) => m.name)).toEqual(["role", "role=", "admin?", "admin!", "member?", "member!"]);
    expect(out.every((m) => m.category === "enum")).toBe(true);
    expect(out.every((m) => m.kind === "instance")).toBe(true);
  });
});

describe("aasmExpander.expand — direct call", () => {
  it("synthesises predicate per state and method/bang per event", () => {
    const src = "class J\n  aasm do\n    state :idle\n    event :start\n  end\nend\n";
    const node = firstStmt(src);
    const out = aasmExpander.expand(node, node.startPosition.row + 1, node.endPosition.row + 1);
    expect(out.map((m) => m.name)).toEqual(["idle?", "start", "start!"]);
    expect(out.every((m) => m.category === "state-machine")).toBe(true);
    expect(out.every((m) => m.kind === "instance")).toBe(true);
  });
});

describe("stateMachineExpander.expand — direct call", () => {
  it("synthesises predicate per state and method/bang per event (shared block-walk with aasm)", () => {
    const src = "class V\n  state_machine :status do\n    state :idle\n    event :start\n  end\nend\n";
    const node = firstStmt(src);
    const out = stateMachineExpander.expand(node, node.startPosition.row + 1, node.endPosition.row + 1);
    expect(out.map((m) => m.name)).toEqual(["idle?", "start", "start!"]);
    expect(out.every((m) => m.category === "state-machine")).toBe(true);
    expect(out.every((m) => m.kind === "instance")).toBe(true);
  });
});
