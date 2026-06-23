/**
 * tea-rags-mcp-5os8y — Ruby CORE method set for the Ruby resolver's
 * `targetsExternalImport` classifier (bare-call branch). Mirrors the
 * `ECMASCRIPT_GLOBALS` set used by the js/ts resolvers.
 *
 * A bare call (`receiver === null`) whose member is one of these names
 * (`puts`, `raise`, `require`, …) targets a Ruby CORE method — a Kernel-module
 * private method or a universal Object/BasicObject method available with NO
 * `require`. There is no project symbol to resolve, so such a call is correctly
 * UNRESOLVED by the symbol-table resolver; this set lets the provider exclude it
 * from the `resolveSuccessRate` denominator (which measures project-INTERNAL
 * resolution capability) instead of counting it as a resolver miss.
 *
 * Scope is Ruby CORE ONLY — NOT Rails / ActiveSupport. Gem-provided methods
 * (`blank?`, `present?`, `try`, `presence`, …) are deliberately EXCLUDED; they
 * belong to a separate Rails layer that may be added later. When unsure whether
 * a name is core or a gem extension, it is EXCLUDED — a conservative set keeps
 * the denominator honest (a name omitted here merely stays in the
 * attempted-unresolved pool; it never over-shrinks the denominator).
 *
 * Consulted ONLY for an UNRESOLVED bare call. A project method that shadows a
 * core name (e.g. a `puts` defined in the project) resolves first via the
 * strategy chain and never reaches this hook, so it is never mis-marked
 * external.
 */
export const RUBY_KERNEL_BUILTINS: ReadonlySet<string> = new Set([
  // I/O — Kernel
  "puts",
  "print",
  "p",
  "pp",
  "warn",
  "printf",
  "sprintf",
  "format",
  "gets",
  // Control flow / exceptions — Kernel
  "raise",
  "fail",
  "throw",
  "catch",
  "loop",
  "exit",
  "exit!",
  "abort",
  "at_exit",
  // Blocks / procs — Kernel
  "proc",
  "lambda",
  "block_given?",
  "caller",
  "binding",
  "__method__",
  "__callee__",
  // Loading — Kernel
  "require",
  "require_relative",
  "load",
  "autoload",
  // Process / misc — Kernel
  "sleep",
  "rand",
  "srand",
  "system",
  "exec",
  // Conversion functions — Kernel
  "Integer",
  "Float",
  "String",
  "Array",
  "Hash",
  "Rational",
  "Complex",
  // Universal Object / BasicObject methods (no require)
  "freeze",
  "frozen?",
  "dup",
  "clone",
  "tap",
  "then",
  "itself",
  "object_id",
  "hash",
  "inspect",
  "to_s",
  "to_proc",
  "send",
  "public_send",
  "__send__",
  "respond_to?",
  "instance_variable_get",
  "instance_variable_set",
  "instance_variables",
  "instance_of?",
  "is_a?",
  "kind_of?",
  "nil?",
  "methods",
  "class",
  "singleton_class",
  "define_singleton_method",
  "extend",
  "display",
]);
