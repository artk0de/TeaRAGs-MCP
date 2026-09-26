/**
 * The Rust associated-constructor heuristic — the ONE place that decides when
 * `Type::f(...)` evaluates to a value of `Type`. Read by BOTH the walker (the
 * `let y = Worker::new()` local binding, bd tea-rags-mcp-q1pl) and the resolver
 * (a method on a constructor's result, `Parser::new().parse()`, bd
 * tea-rags-mcp-7266), so a binding and a chain receiver cannot disagree about
 * which assoc fns construct.
 *
 * The heuristic reads the NAME, never the declared return type: ripgrep's
 * `fn new() -> &'static Parser` still types its result as `Parser`, and a
 * `Worker::query()` whose return type the call alone cannot tell types nothing.
 */

/**
 * Associated functions conventionally used as constructors. `with_*` covers the
 * common `Foo::with_capacity(n)` builder shape. Any other assoc fn
 * (`Worker::query()`, `Config::load()`) returns a value whose type the call
 * does not show — recording it would fabricate a wrong binding.
 */
export function isRustConstructorAssocFn(name: string): boolean {
  return name === "new" || name === "from" || name === "default" || name.startsWith("with_");
}

/**
 * Rust types are UpperCamelCase (`Worker`, `HashMap`); modules are snake_case
 * (`mymod`). A lowercase path segment is a MODULE (`mymod::new()`), not a type.
 */
export function isCapWordsType(name: string): boolean {
  return /^[A-Z]/.test(name);
}
