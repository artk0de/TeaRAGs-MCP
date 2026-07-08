/**
 * ruby-walker DSL helper edges — the per-macro syntactic extractors that turn
 * Rails/Ruby convention calls into synthetic CallRefs (bd tea-rags-mcp-n2kpz /
 * y2z5 / mx9z). Each helper reads ONE macro's argument shape:
 *
 *   - `alias_method :new, :old`      → a CallRef to the aliased-target method.
 *   - `authorize :rec, :act`         → `<Rec>Policy#<act>?` (Pundit dispatch);
 *     the array form `[:ns, :rec]` namespaces the policy constant.
 *   - `get "/x", to: "posts#index"`  → `PostsController#index` (route action).
 *   - `delegate :a, to: :recv / Const` → per-symbol CallRef to the delegate
 *     target (a symbol receiver OR a constant receiver).
 *   - `list.map(&:upcase)`           → a bare CallRef to the symbol-to-proc method.
 *   - `require "foo"`                → an ImportRef (explicit require channel).
 *
 * These pin the branches the association/callback tests do not reach.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

type Chunk = { symbolId: string; scope: string[]; startLine: number; endLine: number };

function extract(src: string, chunks: Chunk[]): FileExtraction {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return extractFromRubyFile({ tree: parser.parse(src), code: src, relPath: "x.rb", language: "ruby", chunks });
}

function callsOf(src: string, chunks: Chunk[]): { receiver: string | null; member: string }[] {
  return extract(src, chunks)
    .chunks.flatMap((c) => c.calls)
    .map((c) => ({ receiver: c.receiver, member: c.member }));
}

const classChunk: Chunk[] = [{ symbolId: "K", scope: ["K"], startLine: 1, endLine: 9 }];
const methodChunk: Chunk[] = [{ symbolId: "K#act", scope: ["K", "act"], startLine: 2, endLine: 4 }];

describe("ruby-walker DSL helper edges — synthetic CallRefs", () => {
  it("`alias_method :new_name, :old_name` emits a CallRef to the aliased target", () => {
    const calls = callsOf("class K\n  alias_method :new_name, :old_name\nend\n", classChunk);
    expect(calls).toContainEqual({ receiver: null, member: "old_name" });
  });

  it("Pundit `authorize :relay, :update` → `RelayPolicy#update?`", () => {
    const calls = callsOf("class K\n  def act\n    authorize :relay, :update\n  end\nend\n", methodChunk);
    expect(calls).toContainEqual({ receiver: "RelayPolicy", member: "update?" });
  });

  it("Pundit array record `authorize [:admin, :status], :edit` namespaces the policy", () => {
    const calls = callsOf("class K\n  def act\n    authorize [:admin, :status], :edit\n  end\nend\n", methodChunk);
    expect(calls).toContainEqual({ receiver: "Admin::StatusPolicy", member: "edit?" });
  });

  it("route `get \"/x\", to: \"posts#index\"` → `PostsController#index`", () => {
    const calls = callsOf("Rails.application.routes.draw do\n  get '/x', to: 'posts#index'\nend\n", [
      { symbolId: "routes", scope: [], startLine: 1, endLine: 3 },
    ]);
    expect(calls).toContainEqual({ receiver: "PostsController", member: "index" });
  });

  it("`delegate :name, :email, to: :client` emits one CallRef per delegated symbol to the receiver", () => {
    const calls = callsOf("class K\n  delegate :name, :email, to: :client\nend\n", classChunk);
    expect(calls).toContainEqual({ receiver: "client", member: "name" });
    expect(calls).toContainEqual({ receiver: "client", member: "email" });
  });

  it("`delegate :cfg, to: Settings` uses a CONSTANT delegate target verbatim", () => {
    const calls = callsOf("class K\n  delegate :cfg, to: Settings\nend\n", classChunk);
    expect(calls).toContainEqual({ receiver: "Settings", member: "cfg" });
  });

  it("`list.map(&:upcase)` symbol-to-proc emits a bare CallRef to the proc method", () => {
    const calls = callsOf("class K\n  def act\n    list.map(&:upcase)\n  end\nend\n", methodChunk);
    expect(calls).toContainEqual({ receiver: null, member: "upcase" });
  });

  it("`require \"foo\"` emits an explicit-require ImportRef", () => {
    const r = extract("require 'foo'\n", [{ symbolId: "top", scope: [], startLine: 1, endLine: 1 }]);
    expect(r.imports.map((i) => i.importText)).toContain("foo");
  });
});
