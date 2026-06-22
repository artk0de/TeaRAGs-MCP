/**
 * Ruby-core class-body declaration macros — built into the language itself, no
 * framework required: `attr_*` accessors, `define_method`, the two `alias`
 * forms, and the `include`/`extend`/`prepend` mixin keywords.
 *
 * Composed into `RUBY_DSL` by `catalogue.ts`. Add a ruby-core keyword here; the
 * dup-key guard forbids it living in another framework module too.
 */
import type { MethodKind, RubyDslModule } from "./types.js";

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

export const RUBY_CORE_DSL: RubyDslModule = {
  framework: "ruby-core",
  entries: {
    // method-declaring
    attr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "instance") },
    attr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "instance" }] },
    attr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "instance" }] },
    define_method: { category: "dynamic-method", declares: (b) => [{ name: b, kind: "instance" }] },
    alias_method: {
      category: "alias",
      declares: (b) => [{ name: b, kind: "instance" }],
      redirectTarget: "second-symbol",
    },
    alias: {
      category: "alias",
      declares: (b) => [{ name: b, kind: "instance" }],
      redirectTarget: "alias-keyword-old",
    },
    // includes / mixins
    include: { category: "include" },
    extend: { category: "include" },
    prepend: { category: "include" },
  },
};
