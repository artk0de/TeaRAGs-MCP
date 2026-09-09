/**
 * Core-homonym members — the Python twin of Ruby's `each` / `to_s` / `first`
 * (bd tea-rags-mcp-83cl7, applied to Python by mmckn).
 *
 * These names are defined on dict / list / str / set / bytes / file objects, so
 * `row.get(key)` on an UNTYPED receiver almost never means the project class
 * that also happens to define `get`. The classifier consults this only after a
 * call failed resolution AND the receiver was proven untyped, so a typed
 * receiver whose class genuinely defines `get` stays a real miss.
 *
 * Precision runs in REVERSE here: every name added hides a possible recall
 * hole, so add one only when the corpus shows it dominating. `save`, `create`
 * and `delete` are deliberately ABSENT — they are Django model methods, which
 * E3's framework vocabulary owns, and putting them here would silently excuse
 * the exact misses that epic exists to fix.
 */
export const PYTHON_CORE_MEMBERS: ReadonlySet<string> = new Set([
  "append",
  "clear",
  "copy",
  "count",
  "extend",
  "get",
  "index",
  "insert",
  "items",
  "join",
  "keys",
  "pop",
  "read",
  "remove",
  "replace",
  "reverse",
  "setdefault",
  "sort",
  "split",
  "startswith",
  "endswith",
  "strip",
  "lstrip",
  "rstrip",
  "update",
  "upper",
  "lower",
  "values",
  "write",
  "close",
  "format",
  "encode",
  "decode",
  "add",
  "discard",
]);
