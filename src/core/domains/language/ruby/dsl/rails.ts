/**
 * Rails (ActiveRecord / ActiveModel / ActionController / ActiveStorage)
 * class-body declaration macros: associations, validations, callbacks, scopes,
 * enums, nested attributes, attachments, state machines.
 *
 * Composed into `RUBY_DSL` by `catalogue.ts`. Associations are GROUP-ONLY here
 * until Phase C adds their `declares` (synthesized accessors).
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import { singularizeAssociation } from "./inflection.js";
import { RAILS_RUNTIME_BUILTINS } from "./rails-runtime.js";
import type { DeclaredMethodSpec, RubyDslEntry } from "./types.js";

/**
 * Collection association (`has_many` / `has_and_belongs_to_many`) accessors:
 * the named reader/writer plus the `<singular>_ids` id-collection reader/writer
 * (`has_many :posts` → `posts`, `posts=`, `post_ids`, `post_ids=`).
 */
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
  // lands on them (the model-edge synthesis stays in the walker).
  has_many: { category: "association", declares: collectionAssoc },
  has_one: { category: "association", declares: singularAssoc },
  has_and_belongs_to_many: { category: "association", declares: collectionAssoc },
  belongs_to: {
    category: "association",
    // singular accessors + the foreign-key reader/writer (`user_id`/`user_id=`).
    declares: (b) => [
      ...singularAssoc(b),
      { name: `${b}_id`, kind: "instance" },
      { name: `${b}_id=`, kind: "instance" },
    ],
  },

  // group-only accessor-family
  attribute: { category: "accessor" },
  has_one_attached: { category: "accessor" },
  has_many_attached: { category: "accessor" },

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
  // first symbol arg (the engine takes only the first arg for scope).
  scope: { category: "scope", declares: (b) => [{ name: b, kind: "static" }] },

  // callbacks
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

  // nested attributes
  accepts_nested_attributes_for: { category: "nested-attrs" },

  // enums / state machine / misc
  enum: { category: "enum" },
  aasm: { category: "state-machine" },
  serialize: { category: "other" },
  store_accessor: { category: "other" },
};

/** Rails declaring macros + the controller/ActiveSupport runtime helpers (params/render/…). */
export const RAILS_VOCABULARY = defineFrameworkVocabulary("rails", RAILS_ENTRIES, RAILS_RUNTIME_BUILTINS);
