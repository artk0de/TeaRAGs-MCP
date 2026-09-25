
CREATE TABLE IF NOT EXISTS cg_identifiers (
  rel_path              VARCHAR NOT NULL,
  owner_symbol_id       VARCHAR NOT NULL,
  kind                  VARCHAR NOT NULL,
  name                  VARCHAR NOT NULL,
  type_name             VARCHAR,
  type_source           VARCHAR,
  line                  INTEGER NOT NULL,
  bound_member          VARCHAR,
  bound_receiver        VARCHAR,
  bound_call_expression VARCHAR
);
