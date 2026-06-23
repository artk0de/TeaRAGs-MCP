/**
 * Ruby-core class-body declaration macros — built into the language itself, no
 * framework required: `attr_*` accessors, `define_method`, the two `alias`
 * forms, and the `include`/`extend`/`prepend` mixin keywords.
 *
 * Composed into `RUBY_DSL` by `catalogue.ts`. Add a ruby-core keyword here; the
 * dup-key guard forbids it living in another framework module too.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import { RUBY_KERNEL_BUILTINS } from "./kernel-builtins.js";
import type { MethodKind, RubyDslEntry } from "./types.js";

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

const RUBY_CORE_ENTRIES: Record<string, RubyDslEntry> = {
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
};

/** Ruby-core declaring macros + the Kernel/Object runtime builtins (puts/raise/require/…). */
export const RUBY_CORE_VOCABULARY = defineFrameworkVocabulary("ruby-core", RUBY_CORE_ENTRIES, RUBY_KERNEL_BUILTINS);
