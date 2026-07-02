/**
 * Task 7 (mn00t epic): resolver-level integration coverage for the
 * container-binding pipeline landed by Tasks 3-5 — full walker
 * (`extractFromRubyFile`, which builds `RubyTypeFactStore` internally from
 * every inline type source) -> `RubyCallResolver.resolve` chain, end-to-end,
 * verifying EXACT resolved call-graph edges (not just intermediate type
 * facts).
 *
 * This is pure verification: no production code is touched here. If a
 * scenario below fails, Tasks 4-5 (F2 container fact / F3 element lift) or
 * Task 3 (ivar `||=` typing) have a real integration gap between the walker's
 * emitted facts and the resolver's consumption of them.
 *
 * Harness mirrors:
 *   - `type-propagation-container.test.ts` — tree-sitter parse setup.
 *   - `ruby-walker.test.ts` — driving `extractFromRubyFile` with a real
 *     `chunks[]` boundary and asserting on `chunks[].localBindings` /
 *     `classFieldTypes` (F2/F3/F1b sanity checks before resolving).
 *   - `ruby-resolver-file-edges.test.ts` — the `sym()` symbol-table stub and
 *     mapping a walker `FileExtraction`/`ChunkExtraction` into a resolver
 *     `CallContext` (`ctxFor`).
 *   - `ruby-resolver.test.ts` — the `resolver.resolve(call, ctx)` call shape
 *     and the `{ targetRelPath, targetSymbolId }` assertion shape.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  ChunkExtraction,
  FileExtraction,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import {
  extractFromRubyFile,
  type RubyExtractInput,
} from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function parse(src: string) {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  return parser.parse(src);
}

function extract(src: string, relPath: string, chunks: RubyExtractInput["chunks"]): FileExtraction {
  const tree = parse(src);
  return extractFromRubyFile({ tree, code: src, relPath, language: "ruby", chunks });
}

function sym(symbolId: string, fqName: string, relPath: string, scope: string[] = []) {
  return { symbolId, fqName, shortName: fqName.split(/[.#]/).pop() ?? fqName, relPath, scope };
}

/** Map a walker `FileExtraction` + one of its chunks into a resolver `CallContext`. */
function ctxFor(extraction: FileExtraction, chunk: ChunkExtraction, table: InMemoryGlobalSymbolTable): CallContext {
  return {
    callerFile: extraction.relPath,
    callerScope: chunk.scope,
    imports: extraction.imports,
    symbolTable: table,
    localBindings: chunk.localBindings,
    classFieldTypes: extraction.classFieldTypes,
    associationTypes: extraction.associationTypes,
  };
}

describe("Ruby container-binding end-to-end integration (mn00t Task 7)", () => {
  it("posts = Post.where(active: true); posts[0].title resolves exact Post#title (F2 container fact + index-receiver typed-container path)", () => {
    const src = [
      "class Digest",
      "  def run",
      "    posts = Post.where(active: true)",
      "    posts[0].title",
      "  end",
      "end",
    ].join("\n");
    const extraction = extract(src, "app/digest.rb", [
      { symbolId: "Digest#run", scope: ["Digest"], startLine: 2, endLine: 5 },
    ]);
    const chunk = extraction.chunks[0];

    // Sanity: F2 (mn00t Task 4) landed a CONTAINER binding for `posts`, not a
    // bare Post instance binding — this is the fact the resolver must consume.
    expect(chunk.localBindings?.["posts"]).toEqual([
      { line: 3, type: "Post", typeRef: { form: "container", element: { form: "instance", name: "Post" } } },
    ]);

    const call = chunk.calls.find((c) => c.receiver === "posts[0]" && c.member === "title");
    expect(call).toBeDefined();

    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/post.rb", [
      sym("Post", "Post", "app/models/post.rb"),
      sym("Post#title", "Post#title", "app/models/post.rb", ["Post"]),
    ]);

    const target = resolver.resolve(call!, ctxFor(extraction, chunk, table));
    expect(target).toEqual({ targetRelPath: "app/models/post.rb", targetSymbolId: "Post#title" });
  });

  it("posts = Post.where(active: true); posts.each { |p| p.title } resolves exact Post#title (block-param element binding)", () => {
    const src = [
      "class Digest",
      "  def run",
      "    posts = Post.where(active: true)",
      "    posts.each { |p| p.title }",
      "  end",
      "end",
    ].join("\n");
    const extraction = extract(src, "app/digest.rb", [
      { symbolId: "Digest#run", scope: ["Digest"], startLine: 2, endLine: 5 },
    ]);
    const chunk = extraction.chunks[0];

    // Sanity: the block param `p` inherits the ELEMENT type (Post) from the
    // container-bound `posts`, not the container itself.
    expect(chunk.localBindings?.["p"]).toEqual([{ line: 4, type: "Post" }]);

    const call = chunk.calls.find((c) => c.receiver === "p" && c.member === "title");
    expect(call).toBeDefined();

    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/post.rb", [
      sym("Post", "Post", "app/models/post.rb"),
      sym("Post#title", "Post#title", "app/models/post.rb", ["Post"]),
    ]);

    const target = resolver.resolve(call!, ctxFor(extraction, chunk, table));
    expect(target).toEqual({ targetRelPath: "app/models/post.rb", targetSymbolId: "Post#title" });
  });

  it("@user ||= User.find(1) in one method, @user.name in another method of the same class, resolves exact User#name via classFieldTypes", () => {
    const src = [
      "class SessionsController",
      "  def current_user",
      "    @user ||= User.find(1)",
      "  end",
      "",
      "  def greet",
      "    @user.name",
      "  end",
      "end",
    ].join("\n");
    const extraction = extract(src, "app/controllers/sessions_controller.rb", [
      { symbolId: "SessionsController#current_user", scope: ["SessionsController"], startLine: 2, endLine: 4 },
      { symbolId: "SessionsController#greet", scope: ["SessionsController"], startLine: 6, endLine: 8 },
    ]);

    // Sanity: the ivar's inferred type (Task 3 F1b, `||=`) is scoped to the
    // CLASS via `classFieldTypes`, independent of which method it was set in.
    expect(extraction.classFieldTypes).toEqual({ SessionsController: { "@user": "User" } });

    const greetChunk = extraction.chunks[1];
    const call = greetChunk.calls.find((c) => c.receiver === "@user" && c.member === "name");
    expect(call).toBeDefined();

    const resolver = new RubyCallResolver();
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      sym("User", "User", "app/models/user.rb"),
      sym("User#name", "User#name", "app/models/user.rb", ["User"]),
    ]);

    const target = resolver.resolve(call!, ctxFor(extraction, greetChunk, table));
    expect(target).toEqual({ targetRelPath: "app/models/user.rb", targetSymbolId: "User#name" });
  });
});
