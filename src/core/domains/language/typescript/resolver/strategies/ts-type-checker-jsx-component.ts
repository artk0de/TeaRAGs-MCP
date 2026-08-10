/**
 * Resolve a JSX component tag to the component it names, via the type checker
 * (bd tea-rags-mcp-b4pvp).
 *
 * `<Foo prop={x} />` is a call. It desugars to `React.createElement(Foo, …)`,
 * or to the automatic runtime's `jsx(Foo, …)`, and either way `Foo`'s body runs
 * — so a React codebase's component-to-component edges are ordinary call edges
 * wearing angle brackets. The walker now emits a `CallRef` for each tag
 * (`jsx: true`, `member` = tag name, `receiver` = qualifier of a dotted tag),
 * which puts those sites through the same resolution chain as every other call.
 *
 * Most of them never reach here, by design. A component declared in the caller's
 * own file, imported under its real name, or named after its file is decided by
 * a tree-sitter pass that costs nothing. What those passes structurally cannot
 * do is follow a BINDING: `import { Chip as Tag }` then `<Tag />`, a default
 * import whose local name is arbitrary, or a barrel that re-exports a component
 * declared three files away. The tag text and the declaration's name are simply
 * different strings, and no amount of AST pattern-matching bridges them.
 *
 * `getSymbolAtLocation` on the tag name does bridge them, because the checker
 * already understands JSX natively — there is no `createElement` desugaring to
 * hand-roll. Following the alias chain lands on the real declaration, whatever
 * chain of re-exports and renames sits in between.
 *
 * Precision over recall, as in the sibling checker pass: the declaration
 * becomes an edge only after the run's `GlobalSymbolTable` confirms it, a
 * declaration outside the project yields `continue` for the external classifier
 * to bucket, and a declaration with no stable name (`export default () => …`)
 * degrades to a file-only edge rather than an invented id.
 */

import ts from "typescript";

import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";

export class TSTypeCheckerJsxComponentSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "typeCheckerJsxComponent";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.jsx !== true) return CONTINUE;

    const handle = this.programCache.acquire(ctx.callerFile);
    if (!handle) return CONTINUE;

    const tagName = findJsxTagName(handle.sourceFile, call.startLine, call.member);
    if (!tagName) return CONTINUE;

    const symbol = resolveAlias(handle.checker, handle.checker.getSymbolAtLocation(tagName));
    if (!symbol) return CONTINUE;

    for (const declaration of symbol.declarations ?? []) {
      const targetRelPath = this.programCache.toRelPath(declaration.getSourceFile().fileName);
      if (targetRelPath === null) continue;
      return resolved({ targetRelPath, targetSymbolId: this.pinSymbol(declaration, targetRelPath, ctx) });
    }
    return CONTINUE;
  }

  /**
   * Confirm the checker's declaration against the run's symbol table, which is
   * the vocabulary every other edge is phrased in. The lookup uses the
   * DECLARATION's own name, never the tag's — under a rename those differ, and
   * the declaration's name is the one the chunker recorded.
   *
   * Exact fq match first, then the short name narrowed to that one file, which
   * recovers a component the chunker filed under a composed id (nested in a
   * namespace, or exported from inside a block). Failing both, the FILE is
   * still certain, so a file-only edge is emitted — the contract allows a null
   * `targetSymbolId` for exactly that.
   */
  private pinSymbol(declaration: ts.Declaration, targetRelPath: string, ctx: CallContext): string | null {
    const name = declarationName(declaration);
    if (name === null) return null;

    const exact = ctx.symbolTable.lookup(name).filter((def) => def.relPath === targetRelPath);
    if (exact.length > 0) return exact[0].symbolId;

    const byShortName = ctx.symbolTable.lookupByShortName(name).filter((def) => def.relPath === targetRelPath);
    return pickSingleCandidate(byShortName, this.cfg.mode)?.symbolId ?? null;
  }
}

/**
 * Follow an import/export alias to what it really names. A tag in a `.tsx` file
 * almost always binds to an alias — that is what an import IS to the checker —
 * and the alias itself has no declaration worth an edge.
 *
 * `getAliasedSymbol` throws on a non-alias, so the flag check is the guard, not
 * an optimization. An alias whose target never resolved (a specifier pointing at
 * no file) yields a symbol with no declarations, which the caller treats as
 * unresolvable rather than guessing.
 */
function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (!symbol) return undefined;
  return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

/**
 * The declaration's own name, or `null` for shapes that carry none — an
 * `export default () => …`, an anonymous class expression. A variable
 * declaration (`export const Chip = (props) => …`, the dominant way a function
 * component is written) names the component through the const it is bound to.
 */
function declarationName(declaration: ts.Declaration): string | null {
  const named = declaration as ts.Declaration & { name?: ts.Node };
  const { name } = named;
  return name !== undefined && ts.isIdentifier(name) ? name.text : null;
}

/**
 * The tag name node of the first JSX component element starting on `startLine`
 * (1-based, matching `CallRef.startLine`) whose own name is `member`.
 *
 * Both coordinates are checked because one line routinely holds several tags —
 * matching on the line alone would resolve a sibling and emit its component.
 * Closing tags are not considered: `JsxClosingElement` is a different node kind
 * and never matches, which is the same one-usage-per-element accounting the
 * walker applies when it emits.
 */
function findJsxTagName(sourceFile: ts.SourceFile, startLine: number, member: string): ts.JsxTagNameExpression | null {
  let found: ts.JsxTagNameExpression | null = null;

  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (tagShortName(node.tagName) === member) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
        if (line === startLine) {
          found = node.tagName;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Rightmost identifier of a tag — `Panel` in `<UI.Panel />`, `Card` in `<Card>`. */
function tagShortName(tagName: ts.JsxTagNameExpression): string | null {
  if (ts.isPropertyAccessExpression(tagName) && ts.isIdentifier(tagName.name)) return tagName.name.text;
  if (ts.isIdentifier(tagName)) return tagName.text;
  return null;
}
