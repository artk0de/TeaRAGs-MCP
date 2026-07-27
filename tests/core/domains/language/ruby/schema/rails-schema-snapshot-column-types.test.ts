/**
 * Column VALUE types read off the Rails schema snapshot (bd tea-rags-mcp-2a5oo).
 *
 * The 8l5fo reader kept only column NAMES; a chain like `firm.name.strip` then
 * broke at the column hop. It now keeps the declared type token too and expands
 * it into the accessor→type map the codegraph pre-pass turns into structured
 * return facts. Silence rules are load-bearing: an unmapped token, a boolean, a
 * writer and a query predicate all carry NO type, because a wrong type is a
 * wrong edge and there is no way to tell one from a missing one afterwards.
 */
import { describe, expect, it } from "vitest";

import { parseRailsSchemaSnapshot } from "../../../../../../src/core/domains/language/ruby/schema/index.js";

/** The accessor→value-type map of one table in a snapshot. */
function returnTypesOf(source: string, table: string): Record<string, unknown> {
  const found = parseRailsSchemaSnapshot(source).find((t) => t.table === table);
  return { ...(found?.accessorReturnTypes ?? {}) };
}

const STRING = { form: "instance", name: "String" };
const INTEGER = { form: "instance", name: "Integer" };
const TIME = { form: "instance", name: "Time" };

describe("parseRailsSchemaSnapshot column value types (bd tea-rags-mcp-2a5oo)", () => {
  it("types the READER accessor of a declared column and nothing else", () => {
    const source = ['create_table "firms", id: false, force: :cascade do |t|', '  t.string "name"', "end", ""].join(
      "\n",
    );
    expect(returnTypesOf(source, "firms")).toEqual({ name: STRING });
  });

  it("types the implicit `id` primary key as Integer", () => {
    const source = ['create_table "firms", force: :cascade do |t|', "end", ""].join("\n");
    expect(returnTypesOf(source, "firms")).toEqual({ id: INTEGER });
  });

  it("honours an `id: :uuid` primary key over the bigint default", () => {
    const source = [
      'create_table "invoices", id: :uuid, default: -> { "x()" }, force: :cascade do |t|',
      "end",
      "",
    ].join("\n");
    expect(returnTypesOf(source, "invoices")).toEqual({ id: STRING });
  });

  it("stays silent for a RENAMED primary key with no declared id type", () => {
    const source = ['create_table "legacy", primary_key: "uuid", force: :cascade do |t|', "end", ""].join("\n");
    expect(returnTypesOf(source, "legacy")).toEqual({});
  });

  it("types a renamed primary key from its declared id type", () => {
    const source = [
      'create_table "data_migrations", primary_key: "version", id: :string, force: :cascade do |t|',
      "end",
      "",
    ].join("\n");
    expect(returnTypesOf(source, "data_migrations")).toEqual({ version: STRING });
  });

  it("types both timestamp columns as Time", () => {
    const source = ['create_table "firms", id: false, force: :cascade do |t|', "  t.timestamps", "end", ""].join("\n");
    expect(returnTypesOf(source, "firms")).toEqual({ created_at: TIME, updated_at: TIME });
  });

  it("wraps an `array: true` column in the container form", () => {
    const source = [
      'create_table "invoices", id: false, force: :cascade do |t|',
      '  t.string "hidden_columns", default: [], null: false, array: true',
      "end",
      "",
    ].join("\n");
    expect(returnTypesOf(source, "invoices")).toEqual({
      hidden_columns: { form: "container", element: STRING },
    });
  });

  it("stays silent for a boolean column while still declaring its accessors", () => {
    const source = ['create_table "firms", id: false, force: :cascade do |t|', '  t.boolean "active"', "end", ""].join(
      "\n",
    );
    const [firms] = parseRailsSchemaSnapshot(source);
    expect(firms?.accessors).toEqual(["active", "active=", "active?"]);
    expect(returnTypesOf(source, "firms")).toEqual({});
  });

  it("stays silent for an enum-backed column", () => {
    const source = [
      'create_table "firms", id: false, force: :cascade do |t|',
      '  t.enum "plan", enum_type: "plan"',
      "end",
      "",
    ].join("\n");
    expect(returnTypesOf(source, "firms")).toEqual({});
  });

  it("keeps a mixed table's typed columns and drops only the silent ones", () => {
    const source = [
      'create_table "firms", force: :cascade do |t|',
      '  t.string "name"',
      '  t.boolean "active"',
      '  t.jsonb "settings"',
      '  t.datetime "signed_at"',
      '  t.index ["name"], name: "index_firms_on_name"',
      "end",
      "",
    ].join("\n");
    expect(returnTypesOf(source, "firms")).toEqual({
      id: INTEGER,
      name: STRING,
      settings: { form: "instance", name: "Hash" },
      signed_at: TIME,
    });
  });

  it("keeps each table's value types separate", () => {
    const source = [
      'create_table "firms", id: false, force: :cascade do |t|',
      '  t.string "name"',
      "end",
      "",
      'create_table "users", id: false, force: :cascade do |t|',
      '  t.integer "age"',
      "end",
      "",
    ].join("\n");
    expect(returnTypesOf(source, "firms")).toEqual({ name: STRING });
    expect(returnTypesOf(source, "users")).toEqual({ age: INTEGER });
  });
});
