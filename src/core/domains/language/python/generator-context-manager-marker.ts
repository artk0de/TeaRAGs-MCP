/**
 * The walker ↔ resolver marker for a `@contextmanager` generator's CALL
 * result (bd tea-rags-mcp-m99j1.1.87). Zero imports on purpose: both halves
 * import it from here, never one from the other.
 *
 * `@contextlib.contextmanager def f() -> Iterator[T]` makes `f(...)` return a
 * `contextlib._GeneratorContextManager[T]` (typeshed's spelling), whose
 * `__enter__` yields `T` — so `with f() as x` binds `x` to `T`, never to the
 * declared `Iterator[T]`. The walker records that return as an `instance` of
 * the manager class carrying `T` as its one generic argument; the resolver's
 * `contextEnter` fold reads the argument back. The names are the library's
 * own, so any other reader sees an honest external class rather than a
 * container the call never produces.
 */

/** Qualified decorator spelling → the manager class its decorated def's call returns. */
export const PYTHON_GENERATOR_CONTEXT_MANAGERS: ReadonlyMap<string, string> = new Map([
  ["contextlib.contextmanager", "contextlib._GeneratorContextManager"],
  ["contextlib.asynccontextmanager", "contextlib._AsyncGeneratorContextManager"],
]);

const MANAGER_CLASSES: ReadonlySet<string> = new Set(PYTHON_GENERATOR_CONTEXT_MANAGERS.values());

/** Is `name` a manager class {@link PYTHON_GENERATOR_CONTEXT_MANAGERS} records? */
export function isPythonGeneratorContextManager(name: string): boolean {
  return MANAGER_CLASSES.has(name);
}
