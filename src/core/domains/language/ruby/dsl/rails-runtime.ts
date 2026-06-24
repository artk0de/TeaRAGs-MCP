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
