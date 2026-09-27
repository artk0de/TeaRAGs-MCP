
CREATE TABLE IF NOT EXISTS cg_hierarchy_dependencies (
  source_rel_path  VARCHAR NOT NULL,
  type_name        VARCHAR NOT NULL,
  descendant_names VARCHAR NOT NULL,
  PRIMARY KEY (source_rel_path, type_name)
);
