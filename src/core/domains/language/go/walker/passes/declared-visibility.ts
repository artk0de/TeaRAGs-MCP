/**
 * Go declared visibility (bd tea-rags-mcp-jwjyr.1), read by the kernel's
 * declared-visibility facet for every declaration `goNameOf` names — a func, a
 * method, a type spec / alias. Go's only access rule is the identifier's first
 * letter:
 *
 *   | identifier            | visibility |
 *   | --------------------- | ---------- |
 *   | exported (upper case) | public     |
 *   | unexported            | private    |
 *
 * "private" here is PACKAGE-private: reachable from every file of the declaring
 * package, not only from the declaring type. An access rule reading this column
 * for Go must compare packages (directories), never classes or files.
 *
 * A method's `goNameOf` name is the composed `Recv#Method`; the exported test
 * reads the method's own segment.
 */

import {
  declaredVisibilityFacetPass,
  type DeclaredVisibilityReader,
  type ExtractionFacetPass,
} from "../../../kernel/index.js";
import { goNameOf } from "../name-of.js";

const EXPORTED = /^\p{Lu}/u;

export const readGoDeclaredVisibility: DeclaredVisibilityReader = (node) => {
  const named = goNameOf(node);
  if (named === null) return null;
  const ownName = named.name.split(/[#.]/).at(-1) ?? named.name;
  return { name: named.name, visibility: EXPORTED.test(ownName) ? "public" : "private" };
};

export const goDeclaredVisibilityFacetPass: ExtractionFacetPass = declaredVisibilityFacetPass(readGoDeclaredVisibility);
