/**
 * A memo whose entries live for ONE resolve run (bd tea-rags-mcp-39xca.6).
 *
 * Resolvers are cached by `LanguageFactory.create` for the factory's lifetime,
 * and `GraphDbClientPool` keeps one `GlobalSymbolTable` per collection for the
 * pool's lifetime. A memo held by a resolver and keyed by that table therefore
 * served run N's answers to run N+1 (bd tea-rags-mcp-11qqk, re-export
 * declarers; bd tea-rags-mcp-z99hp, ancestor linearizers). Keying on a
 * run-global CHANNEL's identity instead only moved the problem:
 * `CodegraphRunState#absorb` and `#seal` mutate those objects in place.
 *
 * This memo takes the run from `CallContext.runScope` and keys the caller's own
 * object BENEATH it, so the inner key keeps whatever meaning it had — the table
 * a membership answer was read from, the `classAncestors` a linearizer was
 * built over — while the outer key bounds its lifetime to the run. A scope that
 * is no longer referenced takes its whole entry set with it.
 *
 * `tests/core/domains/language/run-scoped-cache-keys.test.ts` forbids the
 * table-keyed and bare-object-keyed map declarations this replaces anywhere
 * under `domains/language`.
 */

import type { ResolveRunScope } from "../../../contracts/types/codegraph.js";

/**
 * The scope of every `CallContext` built outside a codegraph run — unit tests,
 * offline harnesses, anything that constructs a context by hand. Such a caller
 * has no run to scope to, so under this scope an entry lives as long as the
 * memo, keyed by the object handed in: exactly the lifetime these memos had
 * before the token existed.
 */
export const DETACHED_RESOLVE_RUN_SCOPE: ResolveRunScope = Object.freeze({ runSeq: 0 });

export class RunScopedMemo<K extends object, V> {
  private readonly byScope = new WeakMap<ResolveRunScope, WeakMap<K, V>>();

  get(runScope: ResolveRunScope | undefined, key: K): V | undefined {
    return this.byScope.get(runScope ?? DETACHED_RESOLVE_RUN_SCOPE)?.get(key);
  }

  set(runScope: ResolveRunScope | undefined, key: K, value: V): void {
    const scope = runScope ?? DETACHED_RESOLVE_RUN_SCOPE;
    let entries = this.byScope.get(scope);
    if (entries === undefined) {
      entries = new WeakMap<K, V>();
      this.byScope.set(scope, entries);
    }
    entries.set(key, value);
  }
}
