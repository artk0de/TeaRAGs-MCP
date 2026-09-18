/**
 * Go struct-field addressing — the ONE place the shape of a Go struct's entry
 * in `classFieldTypesByClassKey` is defined. Written by the walker's
 * struct-field facet (`walker/passes/struct-field-types.ts`) and read by the
 * resolver's member selection (`resolver/struct-member-selection.ts`); keeping
 * both on these helpers is what stops the persisted shape and its reader from
 * drifting apart (bd tea-rags-mcp-e6xx).
 *
 * The channel is the run-global, hydrated `classFieldTypesByClassKey`, keyed by
 * `<relPath>::<Type>` — the same address Python's field facts use. The file
 * prefix is what keeps two namesake types apart run-global (`render.Context`
 * vs gin's `Context`), and what keeps a Go entry from ever answering a lookup
 * another language composes for its own class.
 *
 * A struct's map is `fieldName → typeName`:
 *   - a nominal type is recorded bare (`responseWriter`, `*Context` → `Context`,
 *     `Box[T]` → `Box`); a package-qualified one KEEPS its qualifier
 *     (`http.Request`), so it can never be mistaken for a project namesake;
 *   - a field whose type names no single type (`map[..]..`, `[]T`, `func(..)`)
 *     is recorded with an EMPTY type — the field exists and shadows any
 *     promoted namesake, but it types nothing;
 *   - an EMBEDDED field is recorded twice: under its implicit field name (the
 *     type's bare name — `engine.RouterGroup.X` is a legal field access) and
 *     under {@link goEmbeddedFieldKey}, which no Go identifier can spell. The
 *     marker is what makes it a PROMOTION source: a named field that happens to
 *     share its type's name (`Config Config`) promotes nothing, and only the
 *     walker can tell the two apart.
 *
 * A field-less struct still gets an EMPTY map: its presence is how the resolver
 * knows the type is a struct whose promotion sources are fully known, as
 * opposed to an interface or an external type it cannot see into.
 */

/** Prefix of the key marking an embedded field; `:` cannot appear in a Go identifier. */
const GO_EMBEDDED_FIELD_KEY_PREFIX = "embedded:";

/** The run-global class key of a Go struct declared in `relPath`. */
export function goStructClassKey(relPath: string, typeName: string): string {
  return `${relPath}::${typeName}`;
}

/** The key marking the embedded field whose implicit name is `fieldName`. */
export function goEmbeddedFieldKey(fieldName: string): string {
  return `${GO_EMBEDDED_FIELD_KEY_PREFIX}${fieldName}`;
}

/** The embedded field types of one struct's map, in declaration order. */
export function goEmbeddedFieldTypes(fields: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  for (const [key, type] of Object.entries(fields)) {
    if (key.startsWith(GO_EMBEDDED_FIELD_KEY_PREFIX)) out.push(type);
  }
  return out;
}

/**
 * The type of the NAMED field `fieldName` in one struct's map: the recorded type
 * (`""` for a non-nominal one), or `undefined` when the struct has no such
 * field. An embedded field answers under its implicit name.
 */
export function goDeclaredFieldType(fields: Readonly<Record<string, string>>, fieldName: string): string | undefined {
  if (fieldName.startsWith(GO_EMBEDDED_FIELD_KEY_PREFIX)) return undefined;
  return Object.prototype.hasOwnProperty.call(fields, fieldName) ? fields[fieldName] : undefined;
}
