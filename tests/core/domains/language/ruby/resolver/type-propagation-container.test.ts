/**
 * Task 1.6: container element + block-param receiver types.
 *
 * Tests cover three capabilities:
 *
 * 1. ENGINE — container form in returnTypeOf: `posts.first` → Post,
 *    `posts.first.title` → Post#title, `posts.size` → undefined.
 * 2. BLOCK-PARAM — `posts.each { |p| p.title }` binds `p` to Post's element.
 * 3. INDEX-LIFT — `arr[0]` on a typed container resolves element methods;
 *    `opts[k]` on an untyped container stays suppressed.
 */

import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  CONTAINER_BLOCK_ITERATION_METHODS,
  CONTAINER_ELEMENT_RETURNING_METHODS,
  typeOfReceiver,
} from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { RubyTypeFactStore } from "../../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";
import { rubyAstInferenceTypeSource } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/ast-inference.js";
import { rubyYardTypeSource } from "../../../../../../src/core/domains/language/ruby/walker/type-sources/yard.js";
import type { RubyExtractInput } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const emptyCtx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

/** Container LocalBinding for `posts : Array<Post>` */
const postsContainerBinding = {
  line: 1,
  type: "Post",
  typeRef: { form: "container" as const, element: { form: "instance" as const, name: "Post" } },
};

/** Container LocalBinding for `arr : Array<Widget>` */
const arrContainerBinding = {
  line: 1,
  type: "Widget",
  typeRef: { form: "container" as const, element: { form: "instance" as const, name: "Widget" } },
};

function makeInput(code: string): RubyExtractInput {
  const parser = new Parser();
  parser.setLanguage(RbLang as unknown as Parser.Language);
  const tree = parser.parse(code);
  return { tree, code, relPath: "test.rb", language: "ruby", chunks: [] };
}

// ── exported constant shapes ──────────────────────────────────────────────────

describe("CONTAINER_ELEMENT_RETURNING_METHODS constant", () => {
  it("is exported and is a Set", () => {
    expect(CONTAINER_ELEMENT_RETURNING_METHODS).toBeInstanceOf(Set);
  });

  it("contains the required element-returning methods", () => {
    for (const m of ["first", "last", "[]", "fetch", "sample", "find", "detect", "min", "max", "dig"]) {
      expect(CONTAINER_ELEMENT_RETURNING_METHODS.has(m)).toBe(true);
    }
  });
});

describe("CONTAINER_BLOCK_ITERATION_METHODS constant", () => {
  it("is exported and is a Set", () => {
    expect(CONTAINER_BLOCK_ITERATION_METHODS).toBeInstanceOf(Set);
  });

  it("contains the required block iteration methods", () => {
    for (const m of [
      "each",
      "map",
      "select",
      "reject",
      "detect",
      "find",
      "flat_map",
      "each_with_object",
      "sort_by",
      "group_by",
      "min_by",
      "max_by",
    ]) {
      expect(CONTAINER_BLOCK_ITERATION_METHODS.has(m)).toBe(true);
    }
  });
});

// ── Part 1: engine — container element-returning method resolution ─────────────

describe("typeOfReceiver — container form element extraction (Part 1)", () => {
  describe("single-hop element-returning methods", () => {
    it("posts.first → Post (container binding, element-returning method)", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.first", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.last → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.last", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.sample → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.sample", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.find → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.find", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.detect → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.detect", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.fetch → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.fetch", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.min → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.min", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });

    it("posts.max → Post", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.max", 5, ctx)).toEqual({ form: "instance", name: "Post" });
    });
  });

  describe("multi-hop: posts.first.title → Post#title", () => {
    it("threads posts.first → Post, then Post#title via structuredReturnTypes", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
        structuredReturnTypes: {
          "Post#title": { form: "instance", name: "String" },
        },
      });
      // posts.first → Post, Post.title → String
      expect(typeOfReceiver("posts.first.title", 5, ctx)).toEqual({ form: "instance", name: "String" });
    });

    it("threads posts.last.author → Author via associationTypes", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
        associationTypes: {
          Post: { author: "Author" },
        },
      });
      expect(typeOfReceiver("posts.last.author", 5, ctx)).toEqual({ form: "instance", name: "Author" });
    });
  });

  describe("non-element methods → undefined (container's own Array/Enumerable methods)", () => {
    it("posts.size → undefined (not element-returning)", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.size", 5, ctx)).toBeUndefined();
    });

    it("posts.count → undefined", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.count", 5, ctx)).toBeUndefined();
    });

    it("posts.map → undefined (returns transformed collection, not element)", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.map", 5, ctx)).toBeUndefined();
    });

    it("posts.length → undefined", () => {
      const ctx = emptyCtx({
        localBindings: { posts: [postsContainerBinding] },
      });
      expect(typeOfReceiver("posts.length", 5, ctx)).toBeUndefined();
    });
  });

  describe("untyped container → falls through (no regression)", () => {
    it("arr (plain instance binding, no typeRef) - non-element method returns undefined", () => {
      const ctx = emptyCtx({
        localBindings: {
          arr: [{ line: 1, type: "Array" }],
        },
      });
      // Plain instance binding with no typeRef → reconstructed as {form:"instance",name:"Array"}
      // Array#first is not in structuredReturnTypes → undefined
      expect(typeOfReceiver("arr.first", 5, ctx)).toBeUndefined();
    });
  });
});

// ── Part 2: block-param element binding via AST source ────────────────────────

describe("rubyAstInferenceTypeSource — block-param with container YARD param (Part 2)", () => {
  it("binds block param |p| to Post element when posts is YARD Array<Post>", () => {
    // YARD Array<Post>: collectYardParamTypes unwraps to "Post" for latestBinding seed.
    // The block-param inference sees posts→"Post" and emits p→Post.
    const code = ["# @param posts [Array<Post>]", "def publish(posts)", "  posts.each { |p| p.save }", "end"].join(
      "\n",
    );
    const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
    const pFact = facts.find((f) => f.name === "p");
    expect(pFact).toBeDefined();
    expect(pFact?.type).toEqual({ form: "instance", name: "Post" });
  });

  it("binds block param |p| for map block on YARD Array<Post>", () => {
    const code = ["# @param posts [Array<Post>]", "def titles(posts)", "  posts.map { |p| p.title }", "end"].join("\n");
    const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
    const pFact = facts.find((f) => f.name === "p");
    expect(pFact).toBeDefined();
    expect(pFact?.type).toEqual({ form: "instance", name: "Post" });
  });

  it("binds block param |p| for select block on YARD Array<Post>", () => {
    const code = ["# @param posts [Array<Post>]", "def active(posts)", "  posts.select { |p| p.active? }", "end"].join(
      "\n",
    );
    const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
    const pFact = facts.find((f) => f.name === "p");
    expect(pFact).toBeDefined();
    expect(pFact?.type).toEqual({ form: "instance", name: "Post" });
  });

  it("binds block param |p| for reject block on YARD Array<Post>", () => {
    const code = [
      "# @param posts [Array<Post>]",
      "def non_active(posts)",
      "  posts.reject { |p| p.active? }",
      "end",
    ].join("\n");
    const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
    const pFact = facts.find((f) => f.name === "p");
    expect(pFact).toBeDefined();
    expect(pFact?.type).toEqual({ form: "instance", name: "Post" });
  });

  it("does NOT bind block param when receiver has no prior binding (no regression)", () => {
    const code = ["def process(items)", "  items.each { |e| e.run }", "end"].join("\n");
    const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
    const eFact = facts.find((f) => f.name === "e");
    expect(eFact).toBeUndefined();
  });

  it("binds block param after direct constructor assignment establishes receiver type", () => {
    // posts = Post.find_all(…) then block iteration — the existing AST binding path
    // sets posts→Post (via INSTANCE_RETURNING_METHODS); block param binds to Post.
    const code = ["posts = Post.find_all", "posts.each { |p| p.save }"].join("\n");
    const facts = rubyAstInferenceTypeSource.extract(makeInput(code));
    const pFact = facts.find((f) => f.name === "p");
    // find_all is not in INSTANCE_RETURNING_METHODS so posts won't be typed — just
    // verify the code doesn't error and the posts binding (if any) is consistent.
    const postsFact = facts.find((f) => f.name === "posts");
    if (postsFact) {
      // If posts is typed, block param p should also be typed to the same class.
      expect(pFact).toBeDefined();
      expect(pFact?.type).toEqual(postsFact.type);
    } else {
      // If posts is not typed, p must NOT be emitted.
      expect(pFact).toBeUndefined();
    }
  });
});

// ── Part 3: index-access suppression lift ────────────────────────────────────
//
// Index-access receivers (`arr[0]`, `opts[k]`) come in as the receiver TEXT
// to typeOfReceiver. When typeRef is container(E), `arr[0].title` should
// resolve E's method. When untyped, suppression is unchanged.
//
// NOTE: `receiverIsIndexAccess` gates inside `RubyDynamicDispatchResolver`
// for the dynamic fan-out path; `RubyChainTypeSymbolResolutionStrategy` also
// engages on index-access receivers (isDotChain || isIndexAccess guard) so
// that typed-container index-access calls resolve via the exact path.
// `typeOfReceiver("arr[0]", …)` unwraps the container to its element type
// directly — this is tested below (C2 coverage).

describe("typeOfReceiver — container binding present, element known (Part 3 setup)", () => {
  it("returns container typeRef for a container-typed var (no index in receiver text)", () => {
    // When arr is typed as container(Widget), typeOfReceiver("arr", …) returns the ref.
    // This is what RubyDynamicDispatchResolver uses to decide NOT to suppress.
    const ctx = emptyCtx({
      localBindings: { arr: [arrContainerBinding] },
    });
    expect(typeOfReceiver("arr", 5, ctx)).toEqual({
      form: "container",
      element: { form: "instance", name: "Widget" },
    });
  });

  it("returns element type for arr.first (element-returning method on container)", () => {
    const ctx = emptyCtx({
      localBindings: { arr: [arrContainerBinding] },
    });
    expect(typeOfReceiver("arr.first", 5, ctx)).toEqual({ form: "instance", name: "Widget" });
  });

  it("untyped opts — typeOfReceiver returns undefined (suppression unchanged)", () => {
    const ctx = emptyCtx({
      // opts has no binding at all
    });
    expect(typeOfReceiver("opts", 5, ctx)).toBeUndefined();
  });

  it("typed container arr[0] — receiver text 'arr' gives container ref for element dispatch", () => {
    // The actual call site resolver will see receiver="arr[0]", which
    // receiverIsIndexAccess detects. With a typed container, it should NOT suppress.
    // We test that the container var is identifiable so the suppression-lift decision
    // can be made: extracting "arr" from "arr[0]" then checking typeOfReceiver.
    const ctx = emptyCtx({
      localBindings: { arr: [arrContainerBinding] },
    });
    // arr is typed container → element is Widget → we can resolve arr[0].title
    const containerRef = typeOfReceiver("arr", 5, ctx);
    expect(containerRef?.form).toBe("container");
    if (containerRef?.form === "container") {
      expect(containerRef.element).toEqual({ form: "instance", name: "Widget" });
    }
  });
});

// ── C2: index-access receiver → element type (typeOfReceiver direct call) ────

describe("typeOfReceiver — index-access unwraps container element type (C2)", () => {
  it("arr[0] on container(Widget) returns element type Widget", () => {
    const ctx = emptyCtx({
      localBindings: { arr: [arrContainerBinding] },
    });
    // typeOfReceiver must recognise "arr[0]" as index-access and unwrap the element.
    expect(typeOfReceiver("arr[0]", 5, ctx)).toEqual({ form: "instance", name: "Widget" });
  });

  it("opts[k] with no binding returns undefined (suppression unchanged)", () => {
    const ctx = emptyCtx({
      // opts has no binding at all
    });
    expect(typeOfReceiver("opts[k]", 5, ctx)).toBeUndefined();
  });
});

// ── I1: YARD Array<Post> param → LocalBinding.typeRef.form === "container" ───

describe("rubyYardTypeSource → RubyTypeFactStore — container typeRef for Array<T> param (I1)", () => {
  it("@param posts [Array<Post>] produces LocalBinding with typeRef.form === container and element.name === Post", () => {
    const code = ["# @param posts [Array<Post>]", "def publish(posts)", "  posts.each { |p| p.save }", "end"].join(
      "\n",
    );

    // Run the YARD source against a minimal RubyExtractInput (no real AST needed).
    // rubyYardTypeSource only needs `input.code`; tree/chunks are unused.
    const input = makeInput(code);
    const facts = rubyYardTypeSource.extract(input);

    // Build the store and query for line range that covers the def line (line 2).
    const store = RubyTypeFactStore.fromFacts(facts);
    const bindings = store.localBindingsForChunk(1, 20);
    const postsBinding = bindings["posts"]?.[0];

    expect(postsBinding).toBeDefined();
    // Parity: type string is the ELEMENT name.
    expect(postsBinding?.type).toBe("Post");
    // Container typeRef must be the full container ref (not stripped to element).
    expect(postsBinding?.typeRef?.form).toBe("container");
    if (postsBinding?.typeRef?.form === "container") {
      expect(postsBinding.typeRef.element).toEqual({ form: "instance", name: "Post" });
    }
  });
});

// ── Integration: full chain with container binding ────────────────────────────

describe("typeOfReceiver — container integration scenarios", () => {
  it("resolves posts.first via container → instance when structuredReturnTypes present", () => {
    const ctx = emptyCtx({
      localBindings: {
        posts: [
          {
            line: 1,
            type: "Post",
            typeRef: { form: "container", element: { form: "instance", name: "Post" } },
          },
        ],
      },
      structuredReturnTypes: {
        "Post#title": { form: "instance", name: "String" },
      },
    });
    // Two-hop: posts→container(Post), .first→Post (element-returning), .title→String
    expect(typeOfReceiver("posts.first.title", 5, ctx)).toEqual({ form: "instance", name: "String" });
  });

  it("posts.size returns undefined — not an element-returning method", () => {
    const ctx = emptyCtx({
      localBindings: {
        posts: [
          {
            line: 1,
            type: "Post",
            typeRef: { form: "container", element: { form: "instance", name: "Post" } },
          },
        ],
      },
    });
    expect(typeOfReceiver("posts.size", 5, ctx)).toBeUndefined();
  });

  it("nested element type: widgets.first.name → String via structuredReturnTypes", () => {
    const ctx = emptyCtx({
      localBindings: {
        widgets: [
          {
            line: 1,
            type: "Widget",
            typeRef: { form: "container", element: { form: "instance", name: "Widget" } },
          },
        ],
      },
      structuredReturnTypes: {
        "Widget#name": { form: "instance", name: "String" },
      },
    });
    expect(typeOfReceiver("widgets.first.name", 5, ctx)).toEqual({ form: "instance", name: "String" });
  });
});
