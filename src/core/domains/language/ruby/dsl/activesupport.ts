/**
 * ActiveSupport class-body declaration macros — class/module-level accessors
 * (`cattr_*`/`mattr_*`), `delegate` / `delegate_missing_to`, `class_attribute`,
 * and the ActiveSupport::Concern hook methods (`included`/`extended`/
 * `class_methods`).
 *
 * Composed into `RUBY_DSL` by `catalogue.ts`. The `cattr_*`/`mattr_*` accessors
 * emit CLASS-level methods (`Class.x`, `static` kind).
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import type { MethodKind, RubyDslEntry } from "./types.js";

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

const ACTIVESUPPORT_ENTRIES: Record<string, RubyDslEntry> = {
  // class/module-level accessors (static)
  cattr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "static") },
  cattr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "static" }] },
  cattr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "static" }] },
  mattr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "static") },
  mattr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "static" }] },
  mattr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "static" }] },
  // delegation
  delegate: { category: "delegation", declares: (b) => [{ name: b, kind: "instance" }] },
  delegate_missing_to: { category: "delegation" },
  // `class_attribute :foo` → instance reader/writer + predicate (`foo`/`foo=`/`foo?`);
  // also class-level, but bare calls inside instance methods hit the instance form.
  class_attribute: {
    category: "accessor",
    declares: (b) => [...accessorPair(b, "instance"), { name: `${b}?`, kind: "instance" }],
  },
  // ActiveSupport::Concern hooks
  included: { category: "concern-hook" },
  extended: { category: "concern-hook" },
  class_methods: { category: "concern-hook" },
};

export const ACTIVESUPPORT_VOCABULARY = defineFrameworkVocabulary("activesupport", ACTIVESUPPORT_ENTRIES);
