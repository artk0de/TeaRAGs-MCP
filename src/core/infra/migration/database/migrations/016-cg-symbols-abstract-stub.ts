/**
 * Codegraph schema — persist the abstract-stub mark on cg_symbols
 * (bd tea-rags-mcp-eikry).
 *
 * The walker marks a method def `isAbstractStub` (bd bcdfe) for three
 * conservative shapes — empty body, single `raise NotImplementedError`, bare
 * `super` — and the self-dispatch probe treats such a def as NOT a concrete
 * definition of its member, which is what lets the REDIRECT terminal fire. The
 * flag rode the walker→provider→symbol-table channel but stopped at the DB, so
 * an INCREMENTAL run — which hydrates every unchanged file's defs from
 * `cg_symbols` instead of re-walking them — read those stubs as concrete:
 * REDIRECT-template discovery degraded to pre-flag behaviour, and in a
 * mixed-hydration run a stub-only override could pass the choke-point guard.
 * Persist it, same channel as arity/visibility/kwargs (bd tfepp/d9o7o, 012).
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
 * supported"); DEFAULT FALSE alone backfills existing rows, and the reader maps
 * only an explicit `true` onto `isAbstractStub` — so a pre-016 row (column NULL
 * because it was written before this migration ran) hydrates as non-stub, the
 * same under-coverage-never-wrong-target degradation it had before.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_016_CG_SYMBOLS_ABSTRACT_STUB = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS is_abstract_stub BOOLEAN DEFAULT FALSE;
`;
