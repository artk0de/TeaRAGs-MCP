
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS class_set VARCHAR;
CREATE TABLE IF NOT EXISTS cg_residual_class_sets (
  set_key       VARCHAR NOT NULL PRIMARY KEY,
  class_targets VARCHAR NOT NULL
);
