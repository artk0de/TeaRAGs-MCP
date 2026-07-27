/**
 * Rails (ActiveRecord / ActiveModel / ActionController / ActiveStorage)
 * class-body declaration macros: associations, validations, callbacks, scopes,
 * enums, nested attributes, attachments, state machines.
 *
 * Composed into `RUBY_DSL` by `catalogue.ts`. Associations are GROUP-ONLY here
 * until Phase C adds their `declares` (synthesized accessors).
 */
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { defineFrameworkVocabulary } from "./framework-module.js";
import { singularizeAssociation } from "./inflection.js";
import { RAILS_RUNTIME_BUILTINS } from "./rails-runtime.js";
import type { DeclaredMethodSpec, RubyDslEntry } from "./types.js";

/**
 * Collection association (`has_many` / `has_and_belongs_to_many`) accessors:
 * the named reader/writer plus the `<singular>_ids` id-collection reader/writer
 * (`has_many :posts` → `posts`, `posts=`, `post_ids`, `post_ids=`).
 */
/** Plain reader/writer accessor pair (`attribute`, `has_one_attached`, …). */
const attrPair = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" },
  { name: `${b}=`, kind: "instance" },
];

/**
 * Accessors ActiveRecord generates for ONE persisted column: reader, writer and
 * query predicate (`name` → `name`, `name=`, `name?`). Same shape as
 * {@link attrPair} one row up — a column IS an attribute, it just happens to be
 * declared in `db/schema.rb` instead of in the class body, which is why it has
 * no `def` anywhere in source (bd tea-rags-mcp-8l5fo).
 *
 * Dirty-tracking (`name_was`, `name_changed?`, `name_before_last_save`, …) is
 * deliberately NOT synthesized: it would triple an already-large member family
 * for shapes that are rare at call sites, and every extra name is another
 * chance to shadow a real def.
 */
export const columnAccessors = (b: string): DeclaredMethodSpec[] => [
  ...attrPair(b),
  { name: `${b}?`, kind: "instance" },
];

/**
 * The Rails schema-snapshot conventions the column reader interprets. Pure DATA
 * (this file imports no tree-sitter and no AST): WHERE the snapshot lives, what
 * the implicit primary key is called, which columns `t.timestamps` stands for,
 * and which `t.<verb>` calls declare no column at all.
 */
export const ACTIVE_RECORD_SCHEMA_SNAPSHOT: {
  readonly relPath: string;
  readonly implicitPrimaryKey: string;
  readonly implicitPrimaryKeyType: string;
  readonly timestampColumns: readonly string[];
  readonly timestampColumnType: string;
  readonly nonColumnVerbs: ReadonlySet<string>;
} = {
  relPath: "db/schema.rb",
  implicitPrimaryKey: "id",
  // Rails 5+ dumps a bigint primary key; a table declaring another key type says
  // so inline (`id: :uuid`), which the reader honours over this default.
  implicitPrimaryKeyType: "bigint",
  timestampColumns: ["created_at", "updated_at"],
  timestampColumnType: "datetime",
  nonColumnVerbs: new Set(["index", "check_constraint", "constraint", "exclusion_constraint", "unique_constraint"]),
};

/**
 * The Ruby class a persisted column's value carries, per schema type token
 * (bd tea-rags-mcp-2a5oo). Pure DATA — the reader turns a `t.<token> "col"` line
 * into the reader accessor's return type through {@link columnValueAccessor}.
 *
 * ABSENT means SILENT, deliberately, and absence is the default: a token with no
 * single honest Ruby class contributes nothing rather than an approximation.
 * Two families are absent on purpose:
 *
 *   - `boolean` — Ruby has no `Boolean` class (`true.class` is `TrueClass`), and
 *     this project has no union convention standing in for one. Naming a
 *     fabricated `Boolean` would make every follow-up member resolve against a
 *     class that exists nowhere.
 *   - `enum` (PG enum-backed), `tsvector`, `ltree`, `virtual`, and anything else
 *     unlisted — either database-adapter specific or type-erased in the dump.
 */
export const ACTIVE_RECORD_COLUMN_VALUE_TYPES: Readonly<Record<string, RubyTypeRef>> = {
  string: { form: "instance", name: "String" },
  text: { form: "instance", name: "String" },
  citext: { form: "instance", name: "String" },
  uuid: { form: "instance", name: "String" },
  inet: { form: "instance", name: "String" },
  integer: { form: "instance", name: "Integer" },
  bigint: { form: "instance", name: "Integer" },
  serial: { form: "instance", name: "Integer" },
  float: { form: "instance", name: "Float" },
  decimal: { form: "instance", name: "BigDecimal" },
  datetime: { form: "instance", name: "Time" },
  timestamp: { form: "instance", name: "Time" },
  timestamptz: { form: "instance", name: "Time" },
  date: { form: "instance", name: "Date" },
  json: { form: "instance", name: "Hash" },
  jsonb: { form: "instance", name: "Hash" },
  hstore: { form: "instance", name: "Hash" },
};

/**
 * The ONE accessor of a column that carries a VALUE type, and that type
 * (bd tea-rags-mcp-2a5oo). Reader only, named exactly like the column:
 *
 *   - the writer (`name=`) evaluates to its ARGUMENT at every call site, not to
 *     the column, so typing it would describe the wrong value;
 *   - the query predicate (`name?`) yields a boolean, which
 *     {@link ACTIVE_RECORD_COLUMN_VALUE_TYPES} deliberately cannot express.
 *
 * `isArray` lifts the element type into the container form — a PG array column
 * (`t.string "tags", array: true`) reads as an Array of the element class, and
 * the container form is what the propagation engine already unwraps for
 * element-returning members. An array of a SILENT element stays silent: a
 * container of nothing is nothing.
 */
export const columnValueAccessor = (
  column: string,
  columnType: string,
  isArray = false,
): { accessor: string; type: RubyTypeRef } | undefined => {
  const element = ACTIVE_RECORD_COLUMN_VALUE_TYPES[columnType];
  if (element === undefined) return undefined;
  return { accessor: column, type: isArray ? { form: "container", element } : element };
};

const collectionAssoc = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" },
  { name: `${b}=`, kind: "instance" },
  { name: `${singularizeAssociation(b)}_ids`, kind: "instance" },
  { name: `${singularizeAssociation(b)}_ids=`, kind: "instance" },
];

/**
 * Singular association (`has_one` / `belongs_to`) accessors: reader/writer plus
 * the `build_<name>` / `create_<name>` constructors
 * (`has_one :profile` → `profile`, `profile=`, `build_profile`, `create_profile`).
 */
const singularAssoc = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" },
  { name: `${b}=`, kind: "instance" },
  { name: `build_${b}`, kind: "instance" },
  { name: `create_${b}`, kind: "instance" },
];

const RAILS_ENTRIES: Record<string, RubyDslEntry> = {
  // associations — synthesise the convention accessors so bare-call resolution
  // lands on them (the model-edge synthesis stays in the walker). `returnShape`
  // additionally types the accessor's return value (G1a): collection macros
  // return a relation (`container(model)`), singular macros an instance.
  has_many: {
    category: "association",
    emits: "model-constant-ref",
    declares: collectionAssoc,
    returnShape: "association-collection",
  },
  has_one: {
    category: "association",
    emits: "model-constant-ref",
    declares: singularAssoc,
    returnShape: "association-singular",
  },
  has_and_belongs_to_many: {
    category: "association",
    emits: "model-constant-ref",
    declares: collectionAssoc,
    returnShape: "association-collection",
  },
  belongs_to: {
    category: "association",
    emits: "model-constant-ref",
    returnShape: "association-singular",
    // singular accessors + the foreign-key reader/writer (`user_id`/`user_id=`).
    declares: (b) => [
      ...singularAssoc(b),
      { name: `${b}_id`, kind: "instance" },
      { name: `${b}_id=`, kind: "instance" },
    ],
  },

  // accessor-family — reader/writer per field. `attribute` is first-symbol-only
  // (the engine takes only the first symbol; the 2nd positional arg is the cast
  // type, not another attribute name). The attachments take each symbol independently.
  attribute: { category: "accessor", declares: (b) => attrPair(b), operands: "first-symbol" },
  has_one_attached: { category: "accessor", declares: (b) => attrPair(b) },
  has_many_attached: { category: "accessor", declares: (b) => attrPair(b) },

  // validations
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

  // scopes — `scope :active, -> { ... }` adds a class method named by the
  // first symbol arg (the lambda is not a name; `operands: 'first-symbol'` takes
  // only the first simple_symbol arg). `returnShape` types it as a relation over
  // the enclosing model (`Post.active` → `container(Post)`).
  scope: {
    category: "scope",
    declares: (b) => [{ name: b, kind: "static" }],
    operands: "first-symbol",
    returnShape: "scope-relation",
  },

  // callbacks
  before_validation: { category: "callback", emits: "self-instance" },
  after_validation: { category: "callback", emits: "self-instance" },
  before_save: { category: "callback", emits: "self-instance" },
  after_save: { category: "callback", emits: "self-instance" },
  around_save: { category: "callback", emits: "self-instance" },
  before_create: { category: "callback", emits: "self-instance" },
  after_create: { category: "callback", emits: "self-instance" },
  around_create: { category: "callback", emits: "self-instance" },
  before_update: { category: "callback", emits: "self-instance" },
  after_update: { category: "callback", emits: "self-instance" },
  around_update: { category: "callback", emits: "self-instance" },
  before_destroy: { category: "callback", emits: "self-instance" },
  after_destroy: { category: "callback", emits: "self-instance" },
  around_destroy: { category: "callback", emits: "self-instance" },
  after_commit: { category: "callback", emits: "self-instance" },
  after_rollback: { category: "callback", emits: "self-instance" },
  after_initialize: { category: "callback", emits: "self-instance" },
  after_find: { category: "callback", emits: "self-instance" },
  after_touch: { category: "callback", emits: "self-instance" },
  before_action: { category: "callback", emits: "self-instance" },
  after_action: { category: "callback", emits: "self-instance" },
  around_action: { category: "callback", emits: "self-instance" },
  before_filter: { category: "callback", emits: "self-instance" },
  after_filter: { category: "callback", emits: "self-instance" },
  around_filter: { category: "callback", emits: "self-instance" },
  skip_before_action: { category: "callback", emits: "self-instance" },
  skip_after_action: { category: "callback", emits: "self-instance" },
  skip_around_action: { category: "callback", emits: "self-instance" },

  // nested attributes — `accepts_nested_attributes_for :posts` → `posts_attributes=`.
  accepts_nested_attributes_for: {
    category: "nested-attrs",
    declares: (b) => [{ name: `${b}_attributes=`, kind: "instance" }],
  },

  // enums / state machine / misc
  enum: { category: "enum" },
  serialize: { category: "other" },
  // store_accessor — the FIRST symbol is the JSON store column; remaining symbols
  // are the accessor keys (each gets a reader/writer pair via `attrPair`).
  // `operands: 'skip-first'` drives the walker to drop that first symbol before
  // projecting through `declares`.
  store_accessor: { category: "accessor", declares: (b) => attrPair(b), operands: "skip-first" },
};

/** Rails declaring macros + the controller/ActiveSupport runtime helpers (params/render/…). */
export const RAILS_VOCABULARY = defineFrameworkVocabulary("rails", RAILS_ENTRIES, RAILS_RUNTIME_BUILTINS, {
  instanceReturning: new Set([
    "find",
    "find!",
    "find_by",
    "find_by!",
    "find_or_create_by",
    "find_or_create_by!",
    "find_or_initialize_by",
    "find_sole_by",
    "create",
    "create!",
    "create_or_find_by",
    "create_or_find_by!",
    "build",
    "first",
    "first!",
    "last",
    "last!",
    "take",
    "take!",
    "sole",
  ]),
  relationReturning: new Set([
    "where",
    "rewhere",
    "not",
    "or",
    "and",
    "order",
    "in_order_of",
    "joins",
    "left_joins",
    "left_outer_joins",
    "includes",
    "eager_load",
    "preload",
    "references",
    "group",
    "regroup",
    "having",
    "limit",
    "offset",
    "distinct",
    "select",
    "reselect",
    "reorder",
    "unscope",
    "unscoped",
    "except",
    "only",
    "excluding",
    "without",
    "all",
    "readonly",
    "lock",
    "none",
    "merge",
    "strict_loading",
    "from",
    "extending",
    "annotate",
    "optimizer_hints",
  ]),
  enqueueDispatch: { perform_later: "perform", perform_now: "perform" },
  // enum is an unconditional (always-active) ActiveRecord structured macro; its
  // expander lives in walker/structured/enum.ts. aasm's structured macro is
  // gem-gated (dsl/aasm.ts) so it moved out of this vocab (bd tea-rags-mcp-o5kwh).
  structuredMacros: new Set(["enum"]),
});

/**
 * ActiveRecord query-interface fallback DATA consulted by the resolver's
 * `returnTypeOf` AR-model rule (G1b). The instance-returning vs relation-returning
 * METHOD categorisation is the framework vocabulary's `instanceReturning` /
 * `relationReturning` sets above (reused via the composed catalogue — NOT
 * duplicated here); this const carries only what that categorisation does not:
 *
 *   - `modelBaseClasses` — the AR-model gate: a receiver is an AR model iff its
 *     transitive ancestry reaches one of these (`class Firm < ApplicationRecord`,
 *     `class Firm < ActiveRecord::Base`). Gates the fallback so a non-model class
 *     that happens to define `find` is never typed by the vocabulary.
 *   - `dynamicFinderPrefix` — Rails synthesises `find_by_<attr>` /
 *     `find_by_<attr>!` per column; they are instance-returning but not
 *     enumerable, so a prefix rule stands in for a Set membership check.
 */
export const ACTIVE_RECORD_QUERY_INTERFACE: {
  readonly modelBaseClasses: ReadonlySet<string>;
  readonly dynamicFinderPrefix: string;
} = {
  modelBaseClasses: new Set(["ApplicationRecord", "ActiveRecord::Base"]),
  dynamicFinderPrefix: "find_by_",
};
