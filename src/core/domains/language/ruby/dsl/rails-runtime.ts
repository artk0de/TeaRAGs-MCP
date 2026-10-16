/**
 * Rails controller / ActiveSupport INSTANCE helper methods that exist on a
 * framework base class (ActionController::Base, ActiveSupport) with NO project
 * `def` — a no-receiver call to one of these is a framework runtime call, not a
 * project-internal miss. Consumed by `ruby-resolver.ts:targetsExternalImport`
 * to exclude such calls from the resolveSuccessRate denominator (bd cai0,
 * mirrors the ykj7 `RUBY_KERNEL_BUILTINS` pattern). DSL class-body MACROS
 * (`has_many`/`validates`/…) are classified separately via the `RUBY_DSL`
 * catalogue — they are NOT listed here.
 *
 * Chain-order safety: a project method that shadows one of these names resolves
 * first via the strategy chain and never reaches the external classifier, so
 * this set never mis-marks a real project method (bd 5os8y).
 */
export const RAILS_RUNTIME_BUILTINS: ReadonlySet<string> = new Set<string>([
  // ActionController request/response surface
  "params",
  "render",
  "redirect_to",
  "redirect_back",
  "head",
  "respond_to",
  "respond_with",
  "flash",
  "session",
  "cookies",
  "request",
  "response",
  "url_for",
  "polymorphic_url",
  "send_data",
  "send_file",
  // ActionController::ConditionalGet — cache-header runtime helpers. Leaf calls
  // with NO in-project dispatch target, so there is no grammar to model (unlike
  // routing/Pundit): a bare call in a controller targets ActionController, so it
  // is a genuine external name (bd tea-rags-mcp-n2kpz #3). A unique in-project
  // `expires_in` (e.g. a model including `Expireable`) still resolves first via
  // the chain and never reaches this classifier (5os8y invariant).
  "expires_in",
  "expires_now",
  "fresh_when",
  "stale?",
  "http_cache_forever",
  // ActionController class-config callable as instance (rare) + view helpers
  "helper_method",
  "layout",
  "rescue_from",
  // ActiveSupport / i18n runtime
  "t",
  "l",
  "logger",
]);

/**
 * ActiveRecord / ActiveModel CORE INSTANCE members that exist on a framework
 * base class (`ActiveRecord::Base`, `ActiveModel`) and that the Rails idiom
 * does NOT override on a domain object as a public instance method invoked via
 * an explicit untyped receiver. A call `untyped_receiver.member` whose member
 * is one of these targets the external base class — fanning out to a
 * coincidental in-project def of the same name is wrong-type noise.
 *
 * This is the QUALIFIED-untyped-receiver axis (`agent.update`), distinct from
 * `RAILS_RUNTIME_BUILTINS` which is the BARE-call axis (`params`/`render`).
 * Consumed by `dsl/catalogue.ts:isExternalQualifiedMember` → the dynamic-dispatch
 * guard + the external classifier arm (bd tea-rags-mcp-i9id8).
 *
 * Chain-order safety: a project method that shadows one of these names resolves
 * first via the strategy chain and never reaches the guard, so this set never
 * mis-marks a real project method (same invariant as RAILS_RUNTIME_BUILTINS, bd
 * 5os8y). DELIBERATELY EXCLUDED: save/save!/present?/valid? (idiomatically
 * overridden) and to_s/each/map/select/first/last/size/class/count
 * (Object/Enumerable universals — need receiver-type discrimination).
 */
export const ACTIVE_RECORD_INSTANCE_BUILTINS: ReadonlySet<string> = new Set<string>([
  // identity / introspection
  "id",
  "to_param",
  "persisted?",
  "new_record?",
  "destroyed?",
  "attributes",
  "attribute_names",
  "errors",
  // persistence-write (non-`save`)
  "update",
  "update!",
  "update_attribute",
  "update_attributes",
  "update_column",
  "update_columns",
  "destroy",
  "destroy!",
  "delete",
  "touch",
  "increment!",
  "decrement!",
  "reload",
  "becomes",
  // serialization
  "to_json",
  "to_xml",
]);

/**
 * Rails framework INSTANCE members whose namesakes in a project are incidental
 * (bd tea-rags-mcp-2m83f.24): ActiveRecord / ActiveModel persistence, dirty
 * tracking and connection queries, and the ActiveSupport core extensions on
 * Object, Numeric, String, Time and Hash. Read only under `railsVocabularyActive`,
 * only on an untyped receiver, and only while no namesake lives in the
 * ActiveRecord model hierarchy — a model's `def save!` is an override the call
 * may reach (`resolver/rails-untyped-receiver-member.ts`).
 *
 * Disjoint from {@link ACTIVE_RECORD_INSTANCE_BUILTINS} (claimed external on any
 * receiver) and from `RUBY_CORE_MEMBERS` (the `coreAmbiguous` axis). Left out:
 * names a project idiomatically defines for its own protocol — `call`,
 * `execute`, `as_json`, `serializable_hash`, `perform`.
 */
export const RAILS_UNTYPED_RECEIVER_MEMBERS: ReadonlySet<string> = new Set<string>([
  // ActiveRecord persistence / locking
  "save",
  "save!",
  "with_lock",
  "lock!",
  "increment",
  "decrement",
  "toggle",
  "toggle!",
  "assign_attributes",
  "read_attribute",
  "write_attribute",
  "has_attribute?",
  "attribute_present?",
  "mark_for_destruction",
  "marked_for_destruction?",
  "previously_new_record?",
  "readonly?",
  // ActiveModel validation / dirty tracking
  "valid?",
  "invalid?",
  "validate!",
  "changed?",
  "changed",
  "changes",
  "changed_attributes",
  "saved_changes",
  "saved_changes?",
  "previous_changes",
  "attribute_changed?",
  "attribute_was",
  "saved_change_to_attribute?",
  "will_save_change_to_attribute?",
  "restore_attributes",
  "clear_changes_information",
  // ActiveRecord connection queries
  "select_all",
  "select_one",
  "select_value",
  "select_values",
  "select_rows",
  "exec_query",
  "quote",
  "quote_column_name",
  "quote_table_name",
  // ActiveSupport Object
  "presence",
  "present?",
  "blank?",
  "try",
  "try!",
  "in?",
  "presence_in",
  "deep_dup",
  "duplicable?",
  "to_query",
  "instance_values",
  "acts_like?",
  "html_safe?",
  // ActiveSupport Numeric / Integer
  "second",
  "seconds",
  "minute",
  "minutes",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "weeks",
  "fortnight",
  "fortnights",
  "month",
  "months",
  "year",
  "years",
  "ago",
  "from_now",
  "since",
  "kilobytes",
  "megabytes",
  "gigabytes",
  "multiple_of?",
  "ordinalize",
  "ordinal",
  // ActiveSupport String
  "underscore",
  "camelize",
  "classify",
  "constantize",
  "safe_constantize",
  "pluralize",
  "singularize",
  "titleize",
  "humanize",
  "dasherize",
  "demodulize",
  "deconstantize",
  "tableize",
  "foreign_key",
  "parameterize",
  "squish",
  "squish!",
  "truncate_words",
  "html_safe",
  "strip_heredoc",
  "inquiry",
  "to_date",
  "to_time",
  "to_datetime",
  "exclude?",
  // ActiveSupport Date / Time
  "beginning_of_day",
  "end_of_day",
  "beginning_of_week",
  "end_of_week",
  "beginning_of_month",
  "end_of_month",
  "beginning_of_quarter",
  "end_of_quarter",
  "beginning_of_year",
  "end_of_year",
  "all_day",
  "all_week",
  "all_month",
  "all_year",
  "next_day",
  "prev_day",
  "next_month",
  "prev_month",
  "in_time_zone",
  "to_fs",
  "to_formatted_s",
  "advance",
  // ActiveSupport Enumerable / Hash
  "index_by",
  "index_with",
  "many?",
  "in_groups_of",
  "to_sentence",
  "compact_blank",
  "symbolize_keys",
  "stringify_keys",
  "deep_symbolize_keys",
  "deep_stringify_keys",
  "deep_transform_keys",
  "with_indifferent_access",
  "deep_merge",
  "reverse_merge",
  "extract!",
  "assert_valid_keys",
]);
