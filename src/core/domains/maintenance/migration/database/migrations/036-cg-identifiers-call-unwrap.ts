/**
 * Codegraph schema — the two facts the call-return join needs to tell
 * `let doc = load()?` from `let attempt = load()` on `cg_identifiers` (bd
 * tea-rags-mcp-bjzaf).
 *
 * A `return` row types its callers by the value they receive AFTER the wrapper
 * is consumed — a Rust `Result<T, E>` and an async TypeScript `Promise<T>` both
 * persist `T`, because `?` / `await` is how their callers consume them. A local
 * that binds the call without consuming it holds the wrapper instead, and only
 * the two sides together can say so:
 *
 *   - `bound_call_unwrapped` (caller): whether the local's bound call was
 *     consumed through `?` / `await`. Written for every row with a bound call.
 *   - `return_wrapper` (callee): the wrapper head a `return` row's type was
 *     read out of (`Result`, `Promise`).
 *
 * Two columns, not one: the facts belong to different rows and mean different
 * things. Nullable, no DEFAULT: a row written before the columns carries
 * neither fact, and the join reads NULL exactly as it read the row before —
 * typed by the target's `T`. The walker bumps of this release route
 * `--force-enrichments codegraph`, which rewrites the rows with the real value.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_036_CG_IDENTIFIERS_CALL_UNWRAP = `
ALTER TABLE cg_identifiers ADD COLUMN IF NOT EXISTS bound_call_unwrapped BOOLEAN;
ALTER TABLE cg_identifiers ADD COLUMN IF NOT EXISTS return_wrapper VARCHAR;
`;
