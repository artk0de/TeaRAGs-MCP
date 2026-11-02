import Parser from "tree-sitter";
import ObjcLang from "tree-sitter-objc";

import { materializeTree } from "../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { MaterializedTree } from "../../../../../src/core/contracts/types/ast.js";

/** Parse and materialize, the tree the walker and the chunker both see. */
export function parseObjc(code: string): MaterializedTree {
  const parser = new Parser();
  parser.setLanguage(ObjcLang);
  return { rootNode: materializeTree(parser.parse(code).rootNode, code) };
}
