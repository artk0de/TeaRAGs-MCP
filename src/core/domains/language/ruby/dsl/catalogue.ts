/**
 * Ruby/Rails class-body declaration DSL catalogue — the SINGLE declarative
 * source of "this identifier is a class-body declaration of category X (and, if
 * method-declaring, synthesises these methods / redirects this alias)".
 *
 * THIS TABLE *IS* THE CATALOGUE — read it as documentation. Three consumers
 * project from it, each reading only the facet it needs (spec
 * `2026-05-27-ruby-dsl-descriptor-design.md`; the consumers re-target onto this
 * catalogue across the migration tasks — this file is step 1, the source):
 *   - `ruby/chunking/class-body-chunker.ts` — `category` → chunk group (via its
 *     own `CATEGORY_TO_GROUP`; the group name is the chunker's policy, not an
 *     intrinsic fact, so it lives there not here).
 *   - `ruby/walker/macros.ts` — `declares(base)` → synthetic `MacroSymbol[]`.
 *   - `ruby/walker/walker.ts` — `redirectTarget` → alias redirect `CallRef`.
 *
 * Add a keyword ONCE here and every consumer derives its behaviour. RSpec /
 * FactoryBot testing-DSL keywords are deliberately ABSENT — they are chunked by
 * the separate `rspec-scope-chunker` and must not enter this Rails catalogue.
 * AST argument extraction (which symbols a macro call declares, where the alias
 * target is) stays in each consumer — the catalogue hands an already-parsed
 * `base` / a `redirectTarget` strategy, never the parsing.
 */

import type { MethodKind, RubyDslEntry } from "./types.js";

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

export const RUBY_DSL: Record<string, RubyDslEntry> = {
  // ── method-declaring macros (declares / redirect) ──────────────────────────
  attr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "instance") },
  attr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "instance" }] },
  attr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "instance" }] },
  cattr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "static") },
  cattr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "static" }] },
  cattr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "static" }] },
  mattr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "static") },
  mattr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "static" }] },
  mattr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "static" }] },
  delegate: { category: "delegation", declares: (b) => [{ name: b, kind: "instance" }] },
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

  // ── group-only accessor-family keywords (category only, NOT synthesised) ────
  attribute: { category: "accessor" },
  class_attribute: { category: "accessor" },
  has_one_attached: { category: "accessor" },
  has_many_attached: { category: "accessor" },

  // ── associations ────────────────────────────────────────────────────────────
  has_many: { category: "association" },
  has_one: { category: "association" },
  belongs_to: { category: "association" },
  has_and_belongs_to_many: { category: "association" },

  // ── validations ──────────────────────────────────────────────────────────────
  validates: { category: "validation" },
  validates_with: { category: "validation" },
  validate: { category: "validation" },
  validates_each: { category: "validation" },
  validates_associated: { category: "validation" },
  validates_acceptance_of: { category: "validation" },
  validates_confirmation_of: { category: "validation" },
  validates_exclusion_of: { category: "validation" },
  validates_format_of: { category: "validation" },
  validates_inclusion_of: { category: "validation" },
  validates_length_of: { category: "validation" },
  validates_numericality_of: { category: "validation" },
  validates_presence_of: { category: "validation" },
  validates_uniqueness_of: { category: "validation" },

  // ── scopes ────────────────────────────────────────────────────────────────────
  scope: { category: "scope" },

  // ── callbacks ─────────────────────────────────────────────────────────────────
  before_validation: { category: "callback" },
  after_validation: { category: "callback" },
  before_save: { category: "callback" },
  after_save: { category: "callback" },
  around_save: { category: "callback" },
  before_create: { category: "callback" },
  after_create: { category: "callback" },
  around_create: { category: "callback" },
  before_update: { category: "callback" },
  after_update: { category: "callback" },
  around_update: { category: "callback" },
  before_destroy: { category: "callback" },
  after_destroy: { category: "callback" },
  around_destroy: { category: "callback" },
  after_commit: { category: "callback" },
  after_rollback: { category: "callback" },
  after_initialize: { category: "callback" },
  after_find: { category: "callback" },
  after_touch: { category: "callback" },
  before_action: { category: "callback" },
  after_action: { category: "callback" },
  around_action: { category: "callback" },
  before_filter: { category: "callback" },
  after_filter: { category: "callback" },
  around_filter: { category: "callback" },
  skip_before_action: { category: "callback" },
  skip_after_action: { category: "callback" },
  skip_around_action: { category: "callback" },

  // ── includes / mixins ───────────────────────────────────────────────────────
  include: { category: "include" },
  extend: { category: "include" },
  prepend: { category: "include" },

  // ── nested attributes ──────────────────────────────────────────────────────
  accepts_nested_attributes_for: { category: "nested-attrs" },

  // ── delegation (group-only sibling of `delegate`) ────────────────────────────
  delegate_missing_to: { category: "delegation" },

  // ── enums / state machine / concern hooks / misc ────────────────────────────
  enum: { category: "enum" },
  aasm: { category: "state-machine" },
  included: { category: "concern-hook" },
  extended: { category: "concern-hook" },
  class_methods: { category: "concern-hook" },
  serialize: { category: "other" },
  store_accessor: { category: "other" },
};
