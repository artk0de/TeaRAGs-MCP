/**
 * `collectRegistryConstantValueRefs` — the constant-registry reference channel
 * (bd tea-rags-mcp-ki9v): a `CONST = <array|hash>.freeze` assignment emits a
 * file→file reference CallRef for every constant / scope_resolution used as a
 * value, so the `constant` resolver can pin the registry to the declaring files.
 * These cases pin the outermost-only scope_resolution discipline (a namespaced
 * `A::B` emits ONE ref for the whole chain, not a bare `B`) and the bare-constant
 * branch, across both the array and hash literal shapes.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import { extractFromRubyFile } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";

type Chunk = { symbolId: string; scope: string[]; startLine: number; endLine: number };

function refsOf(src: string, chunks: Chunk[]): { receiver: string | null; member: string }[] {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  const tree = parser.parse(src);
  const r = extractFromRubyFile({ tree, code: src, relPath: "x.rb", language: "ruby", chunks });
  return r.chunks.flatMap((c) => c.calls).map((c) => ({ receiver: c.receiver, member: c.member }));
}

describe("collectRegistryConstantValueRefs — CONST = [...].freeze registry references", () => {
  it("emits one constant-ref per array element, namespaced constants outermost-only", () => {
    const refs = refsOf("REGISTRY = [Acme::Foo, Bar].freeze\n", [
      { symbolId: "REGISTRY", scope: [], startLine: 1, endLine: 1 },
    ]);
    // The namespaced element emits ONE ref for the full `Acme::Foo` chain
    // (receiver === member === the FQ constant), not a bare `Foo`.
    expect(refs).toContainEqual({ receiver: "Acme::Foo", member: "Acme::Foo" });
    expect(refs).toContainEqual({ receiver: "Bar", member: "Bar" });
    expect(refs).not.toContainEqual({ receiver: "Foo", member: "Foo" });
  });

  it("emits constant-refs for hash VALUES (bare + namespaced), ignoring keys", () => {
    const refs = refsOf("HANDLERS = { 'a' => Alpha, :b => Beta::Impl }.freeze\n", [
      { symbolId: "HANDLERS", scope: [], startLine: 1, endLine: 1 },
    ]);
    expect(refs).toContainEqual({ receiver: "Alpha", member: "Alpha" });
    expect(refs).toContainEqual({ receiver: "Beta::Impl", member: "Beta::Impl" });
  });
});
