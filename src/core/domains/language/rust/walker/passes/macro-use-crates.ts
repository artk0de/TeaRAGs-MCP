/**
 * Rust `#[macro_use] extern crate` census (bd tea-rags-mcp-s3i8m.4 B2): every
 * `#[macro_use] extern crate <name> [as alias];` at the top level of a file, in
 * SOURCE ORDER, on `FileExtraction.rustMacroUseCrates`.
 *
 * Rust admits a macro-loading `extern crate` at the crate root only (E0468),
 * so a file that carries the list IS a crate root, and the list scopes every
 * file of that crate. A nested declaration cannot load macros and is not read;
 * `extern crate self` names the crate itself. `#[macro_use(a, b)]` imports the
 * listed macros only, so the list rides along.
 *
 * `#[macro_use] mod m;` is not recorded: the resolver already reaches a macro
 * the caller's own crate declares through the in-crate pick.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { RustMacroUseCrate } from "../../../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "../../../kernel/index.js";
import { rustOuterAttributeTexts } from "./declared-visibility.js";

const RUST_MACRO_USE_ATTRIBUTE = /^#\[\s*macro_use\s*(?:\(([^)]*)\))?\s*\]$/s;

/** The macro_use reading of one attribute: `null` when it is no macro_use, else its macro list (absent = all). */
function readMacroUse(attributeText: string): { macros?: string[] } | null {
  const match = RUST_MACRO_USE_ATTRIBUTE.exec(attributeText);
  if (match === null) return null;
  if (match[1] === undefined) return {};
  const macros = match[1]
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  return { macros };
}

function readMacroUseCrate(node: AstNode): RustMacroUseCrate | null {
  const crateName = node.childForFieldName("name")?.text;
  if (crateName === undefined || crateName === "self") return null;
  const macroUse = rustOuterAttributeTexts(node)
    .map(readMacroUse)
    .find((reading) => reading !== null);
  if (macroUse === undefined || macroUse === null) return null;
  const alias = node.childForFieldName("alias")?.text;
  return {
    crateName,
    ...(alias !== undefined ? { alias } : {}),
    ...(macroUse.macros !== undefined ? { macros: macroUse.macros } : {}),
    line: node.startPosition.row + 1,
  };
}

export const rustMacroUseCratesFacetPass: ExtractionFacetPass = {
  run: (root) => {
    const crates: RustMacroUseCrate[] = [];
    for (const node of root.namedChildren) {
      if (node.type !== "extern_crate_declaration") continue;
      const crate = readMacroUseCrate(node);
      if (crate !== null) crates.push(crate);
    }
    return crates.length > 0 ? { rustMacroUseCrates: crates } : {};
  },
};
