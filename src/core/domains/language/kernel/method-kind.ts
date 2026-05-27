/**
 * `methodKindFromClassify` — the cross-language method-kind adapter at the
 * kernel of the language domain. Bridges `classifyMethod` (in `infra/symbolid`,
 * which returns `"instance" | "static" | null`) to the `NamedSymbol.methodKind`
 * shape walkers emit (`"instance" | "static" | undefined`). A non-method node
 * yields `null` from `classifyMethod`, mapped to `undefined` here so the walker
 * emits a top-level / unscoped symbol with no instance hint.
 *
 * Relocated from `domains/trajectory/codegraph/symbols/provider.ts` (where the
 * inline helper still lives for the still-legacy `rustNameOf`) into the kernel
 * so the native per-language walkers (`javaNameOf`, …) read it from their own
 * domain rather than the trajectory provider they may not import
 * (domain-boundaries.md). `infra/symbolid` is foundation — importable by
 * `domains/language` — so the helper sits cleanly in the kernel. bd
 * tea-rags-mcp-cen6.
 */

import type Parser from "tree-sitter";

import { classifyMethod } from "../../../infra/symbolid/index.js";

export function methodKindFromClassify(node: Parser.SyntaxNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}
