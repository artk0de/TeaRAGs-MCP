/**
 * `relativePathExact` — the keyword-indexed twin of `relativePath` (bd
 * tea-rags-mcp-ejio7).
 *
 * `relativePath` carries a TEXT index (glob and substring path queries need
 * one), and Qdrant keeps one index per key, so an exact path-MEMBERSHIP filter
 * on it cannot be a single keyword MatchAny: the workarounds were a `should` of
 * text+value pairs or one scroll per path (`adapters/qdrant/filters/
 * text-indexed-exact.ts`). Every chunk point carries this second key with the
 * same value under a `keyword` index, and membership filters name it instead —
 * once the collection is known to carry it on EVERY point.
 *
 * Shared by the four layers that touch it: the static payload builder writes
 * it, the schema manager and the v20 migration index and backfill it, the
 * Qdrant adapter's capability gate reads the version, and the explore DTO
 * strips it from responses. It is not a payload signal descriptor — a declared
 * key would raise schema drift on every existing index; the migration owns its
 * arrival instead.
 */

/** The payload key; its value is byte-identical to `relativePath`. */
export const RELATIVE_PATH_EXACT_KEY = "relativePathExact";

/**
 * The schema version from which EVERY point of a collection carries
 * {@link RELATIVE_PATH_EXACT_KEY}: the version of the backfill migration
 * (`schema-v20-relative-path-exact-keyword`), and the version a fresh
 * collection is stamped at or above. The schema pipeline stamps a version only
 * after every migration up to it succeeded, so reaching it means the backfill
 * completed.
 */
export const RELATIVE_PATH_EXACT_SCHEMA_VERSION = 20;
