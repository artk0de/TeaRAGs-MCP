
CREATE TABLE IF NOT EXISTS cg_type_declarations (
  rel_path     VARCHAR NOT NULL,
  language     VARCHAR NOT NULL,
  type_id      VARCHAR NOT NULL,
  short_name   VARCHAR NOT NULL,
  symbol_kind  VARCHAR,
  line         INTEGER NOT NULL,
  reopens      BOOLEAN NOT NULL,
  supertypes   VARCHAR[] NOT NULL
);
