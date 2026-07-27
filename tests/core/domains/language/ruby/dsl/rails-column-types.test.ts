/**
 * ActiveRecord column VALUE types (bd tea-rags-mcp-2a5oo).
 *
 * `db/schema.rb` declares each column's type (`t.string "name"`), so the accessor
 * ActiveRecord generates for it has a knowable return type. This pins the DATA
 * map (token → `RubyTypeRef`) and the accessor rule that consumes it: the READER
 * carries the value type, the writer and the query predicate carry nothing, and a
 * token with no honest Ruby class is SILENT.
 */
import { describe, expect, it } from "vitest";

import {
  ACTIVE_RECORD_COLUMN_VALUE_TYPES,
  ACTIVE_RECORD_SCHEMA_SNAPSHOT,
  columnValueAccessor,
} from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

/** The type a column of `token` reads as, or undefined when the token is silent. */
function typeOf(token: string): unknown {
  return columnValueAccessor("col", token)?.type;
}

describe("ACTIVE_RECORD_COLUMN_VALUE_TYPES (bd tea-rags-mcp-2a5oo)", () => {
  it("maps every text-shaped column token to String", () => {
    for (const token of ["string", "text", "citext", "uuid", "inet"]) {
      expect(typeOf(token)).toEqual({ form: "instance", name: "String" });
    }
  });

  it("maps every whole-number column token to Integer", () => {
    for (const token of ["integer", "bigint", "serial"]) {
      expect(typeOf(token)).toEqual({ form: "instance", name: "Integer" });
    }
  });

  it("maps float to Float and decimal to BigDecimal", () => {
    expect(typeOf("float")).toEqual({ form: "instance", name: "Float" });
    expect(typeOf("decimal")).toEqual({ form: "instance", name: "BigDecimal" });
  });

  it("maps every timestamp-shaped token to Time and date to Date", () => {
    for (const token of ["datetime", "timestamp", "timestamptz"]) {
      expect(typeOf(token)).toEqual({ form: "instance", name: "Time" });
    }
    expect(typeOf("date")).toEqual({ form: "instance", name: "Date" });
  });

  it("maps every document column token to Hash", () => {
    for (const token of ["json", "jsonb", "hstore"]) {
      expect(typeOf(token)).toEqual({ form: "instance", name: "Hash" });
    }
  });

  it("is SILENT for boolean — Ruby has no Boolean class and the project has no convention for one", () => {
    expect(columnValueAccessor("active", "boolean")).toBeUndefined();
  });

  it("is SILENT for an enum-backed or otherwise unknown token", () => {
    for (const token of ["enum", "tsvector", "ltree", "virtual", "geometry", ""]) {
      expect(columnValueAccessor("col", token)).toBeUndefined();
    }
  });

  it("exposes the token map as data keyed by the schema verb", () => {
    expect(ACTIVE_RECORD_COLUMN_VALUE_TYPES.string).toEqual({ form: "instance", name: "String" });
    expect(ACTIVE_RECORD_COLUMN_VALUE_TYPES.boolean).toBeUndefined();
  });
});

describe("columnValueAccessor (bd tea-rags-mcp-2a5oo)", () => {
  it("attaches the value type to the READER accessor, named exactly like the column", () => {
    expect(columnValueAccessor("name", "string")).toEqual({
      accessor: "name",
      type: { form: "instance", name: "String" },
    });
  });

  it("never names the writer or the query predicate", () => {
    const accessor = columnValueAccessor("name", "string")?.accessor;
    expect(accessor).not.toMatch(/[=?]$/);
  });

  it("wraps an array column in the container form", () => {
    expect(columnValueAccessor("tags", "string", true)).toEqual({
      accessor: "tags",
      type: { form: "container", element: { form: "instance", name: "String" } },
    });
  });

  it("stays silent for an array column whose element token is silent", () => {
    expect(columnValueAccessor("flags", "boolean", true)).toBeUndefined();
  });
});

describe("ACTIVE_RECORD_SCHEMA_SNAPSHOT column-type conventions (bd tea-rags-mcp-2a5oo)", () => {
  it("declares the implicit primary key's type and the timestamp columns' type", () => {
    expect(typeOf(ACTIVE_RECORD_SCHEMA_SNAPSHOT.implicitPrimaryKeyType)).toEqual({
      form: "instance",
      name: "Integer",
    });
    expect(typeOf(ACTIVE_RECORD_SCHEMA_SNAPSHOT.timestampColumnType)).toEqual({ form: "instance", name: "Time" });
  });
});
