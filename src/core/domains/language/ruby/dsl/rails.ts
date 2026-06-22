/**
 * Rails (ActiveRecord / ActiveModel / ActionController / ActiveStorage)
 * class-body declaration macros: associations, validations, callbacks, scopes,
 * enums, nested attributes, attachments, state machines.
 *
 * Composed into `RUBY_DSL` by `catalogue.ts`. Associations are GROUP-ONLY here
 * until Phase C adds their `declares` (synthesized accessors).
 */
import type { RubyDslModule } from "./types.js";

export const RAILS_DSL: RubyDslModule = {
  framework: "rails",
  entries: {
    // associations (group-only until Phase C)
    has_many: { category: "association" },
    has_one: { category: "association" },
    belongs_to: { category: "association" },
    has_and_belongs_to_many: { category: "association" },

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

    // scopes
    scope: { category: "scope" },

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
  },
};
