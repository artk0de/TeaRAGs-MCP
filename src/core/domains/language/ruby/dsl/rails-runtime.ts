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
