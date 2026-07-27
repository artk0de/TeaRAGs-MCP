-- Codegraph schema — persist the abstract-stub mark on cg_symbols (bd eikry).
-- The walker's `isAbstractStub` (bd bcdfe) stopped at the DB, so an incremental
-- run hydrating an unchanged file read its stubs as concrete definitions and
-- REDIRECT-template discovery degraded to pre-flag behaviour. Nullable (DuckDB
-- rejects NOT NULL on ALTER ADD COLUMN); DEFAULT FALSE backfills existing rows,
-- and the reader marks a def only on an explicit TRUE.
-- Mirrors 016-cg-symbols-abstract-stub.ts — keep in sync.
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS is_abstract_stub BOOLEAN DEFAULT FALSE;
