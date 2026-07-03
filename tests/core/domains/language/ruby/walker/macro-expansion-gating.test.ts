/**
 * Gem-gated DECLARES/nameOf path (bd tea-rags-mcp-o5kwh). The class-body macro
 * expander now threads a per-project `RubyDslCatalogue` (composed from the run's
 * Gemfile via `catalogueForGemfile`) so a gem-gated declaring macro synthesises
 * its methods ONLY when the gem is declared. Byte-neutral under the FULL default
 * (no Gemfile / no catalogue arg → every gated grammar active), mirroring the
 * walk-path gating (adx5p.1b).
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { catalogueForGemfile } from "../../../../../../src/core/domains/language/ruby/gemfile.js";
import { expandClassBodyMacros } from "../../../../../../src/core/domains/language/ruby/walker/macro-expansion.js";

function parse(src: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

/** First class/module body statement — the macro call node. */
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

const names = (node: Parser.SyntaxNode, gemfile?: string): string[] =>
  expandClassBodyMacros(node as never, catalogueForGemfile(gemfile)).map((m) => m.name);

const CARRIERWAVE_ACCESSORS = [
  "avatar",
  "avatar=",
  "avatar?",
  "remove_avatar",
  "remove_avatar=",
  "remove_avatar?",
  "avatar_cache",
  "avatar_cache=",
];

// ---------------------------------------------------------------------------
// Generic `declares` gating — carrierwave `mount_uploader`
// ---------------------------------------------------------------------------

describe("expandClassBodyMacros — generic declares gating (carrierwave mount_uploader)", () => {
  const src = "class Photo\n  mount_uploader :avatar, AvatarUploader\nend\n";

  it("synthesises the mounted accessor family ONLY when carrierwave is declared", () => {
    expect(names(firstStmt(src), "gem 'carrierwave'")).toEqual(CARRIERWAVE_ACCESSORS);
  });

  it("synthesises NOTHING when the project's Gemfile lacks carrierwave", () => {
    expect(names(firstStmt(src), "gem 'rails'")).toEqual([]);
  });

  it("FULL catalogue (no Gemfile / no catalogue arg) keeps the grammar active — byte-neutral", () => {
    expect(expandClassBodyMacros(firstStmt(src) as never).map((m) => m.name)).toEqual(CARRIERWAVE_ACCESSORS);
  });

  it("mount_uploaders (plural array column) mounts the same accessor family", () => {
    const pluralSrc = "class Album\n  mount_uploaders :avatar, AvatarUploader\nend\n";
    expect(names(firstStmt(pluralSrc), "gem 'carrierwave'")).toEqual(CARRIERWAVE_ACCESSORS);
  });
});

// ---------------------------------------------------------------------------
// Structured macro gating — aasm
// ---------------------------------------------------------------------------

describe("expandClassBodyMacros — structured macro gating (aasm)", () => {
  const src = "class Job\n  aasm do\n    state :sleeping\n    event :run\n  end\nend\n";

  it("dispatches the aasm structured expander ONLY when the aasm gem is declared", () => {
    expect(names(firstStmt(src), "gem 'aasm'")).toEqual(["sleeping?", "run", "run!"]);
  });

  it("synthesises NOTHING for an aasm-shaped block when the gem is absent", () => {
    expect(names(firstStmt(src), "gem 'rails'")).toEqual([]);
  });

  it("enum (unconditional Rails structured macro) stays active under a gated catalogue", () => {
    const enumSrc = "class M\n  enum :status, { active: 0 }\nend\n";
    expect(names(firstStmt(enumSrc), "gem 'rails'")).toEqual(["status", "status=", "active?", "active!"]);
  });

  it("FULL catalogue keeps aasm active — byte-neutral", () => {
    expect(expandClassBodyMacros(firstStmt(src) as never).map((m) => m.name)).toEqual(["sleeping?", "run", "run!"]);
  });
});
