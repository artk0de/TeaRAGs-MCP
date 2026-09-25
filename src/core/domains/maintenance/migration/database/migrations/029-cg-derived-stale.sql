
CREATE TABLE IF NOT EXISTS cg_derived_stale (
  marker     VARCHAR PRIMARY KEY,
  marked_at  TIMESTAMP NOT NULL DEFAULT current_timestamp
);
