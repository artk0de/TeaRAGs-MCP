/**
 * The forward import graph the batch planner packs over, and the PRELUDE every
 * batch Program carries (bd tea-rags-mcp-vtuu4).
 *
 * Built the way the compiler walks a Program, without building one:
 * `ts.preProcessFile` scans each file's specifiers (imports, export-from,
 * `require` in JavaScript, `/// <reference path|types|lib>`), and
 * `ts.resolveModuleName` / `ts.resolveTypeReferenceDirective` map them to files
 * through the SAME `TSModuleResolutionMemo` the batch Programs later resolve
 * through, so the planning walk warms the memo instead of duplicating it. The
 * graph can only UNDER-state a Program: a JSDoc `import("x")` type in a
 * JavaScript file is invisible to the scanner but not to the compiler. That
 * errs on the safe side — a batch's Program still holds every file its roots
 * reach, it merely holds a little more text than planned.
 *
 * **The prelude** is why batching keeps resolution identical to the whole
 * Program. A file's types depend on its own closure plus every declaration the
 * Program sees as GLOBAL — and a global can come from a file the closure never
 * reaches. The spike's parity run found exactly that class in 18 of 3,814
 * sampled calls, all overload picks between global declarations
 * (`lib.webworker.d.ts` vs `lib.dom.d.ts`, `@types/node` timers vs DOM
 * `setTimeout`). So every batch is rooted at:
 *
 * - the default lib and every lib a `/// <reference lib>` anywhere in the graph
 *   pulls in;
 * - project files that declare globals: scripts (no import/export — a
 *   CommonJS `.js` file is a module), `declare global` blocks, ambient
 *   `declare module "…"` declarations and module augmentations;
 * - dependency declarations that change GLOBAL resolution: dependency scripts
 *   and dependency `declare global` blocks (`@types/node`'s globals). NOT every
 *   ambient dependency file — on taxdome that set is 97 files / 13.5 MB, and a
 *   dependency's module augmentations only matter to files that import it.
 */

import { dirname, posix, resolve as resolvePath } from "node:path";

import ts from "typescript";

import type { TSModuleResolutionMemo } from "./ts-module-resolution-memo.js";

/** One file of the graph: project source, dependency declaration or lib. */
export interface TSProgramImportGraphNode {
  /** Compiler path — forward slashes, the form `ts.SourceFile.fileName` reports. */
  readonly fileName: string;
  /** Source text length — the unit the batch text budget counts. */
  readonly textBytes: number;
  /** Node indices this file pulls into a Program: imports, references, type references. */
  readonly imports: readonly number[];
}

export interface TSProgramImportGraph {
  readonly nodes: readonly TSProgramImportGraphNode[];
  /** Node indices every batch Program is rooted at besides its own roots — the prelude seeds. */
  readonly preludeSeeds: readonly number[];
}

export interface TSProgramImportGraphInput {
  /** Files the walk starts from — the project's claimed files and the run's corpus. */
  readonly rootNames: readonly string[];
  readonly compilerOptions: ts.CompilerOptions;
  /** The host the batch Programs use, so both see the same files and probe memos. */
  readonly host: ts.CompilerHost;
  /** Shared with the batch Programs' module resolution. */
  readonly moduleResolution: TSModuleResolutionMemo;
}

/** What classification found in one file, for the prelude decision. */
interface FileFacts {
  readonly declaresGlobals: boolean;
  readonly libReferences: readonly string[];
}

const JS_FILE = /\.(?:js|jsx|mjs|cjs)$/;
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;
/** `ts.ResolvedModuleFull.extension` values the compiler never loads from `node_modules`. */
const JS_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".jsx", ".mjs", ".cjs"]);
const JSON_EXTENSION = ".json";

export function buildTSProgramImportGraph(input: TSProgramImportGraphInput): TSProgramImportGraph {
  return new ImportGraphWalk(input).run();
}

class ImportGraphWalk {
  private readonly indexOf = new Map<string, number>();
  private readonly fileNames: string[] = [];
  private readonly textBytes: number[] = [];
  private readonly imports: number[][] = [];
  private readonly facts: FileFacts[] = [];
  private readonly pending: number[] = [];
  private readonly libDirectory: string;
  private readonly defaultLib: string;

  constructor(private readonly input: TSProgramImportGraphInput) {
    this.defaultLib = toCompilerPath(input.host.getDefaultLibFileName(input.compilerOptions));
    this.libDirectory = posix.dirname(this.defaultLib);
  }

  run(): TSProgramImportGraph {
    const libSeeds = new Set<number>();
    const defaultLibNode = this.nodeFor(this.defaultLib);
    if (defaultLibNode !== undefined) libSeeds.add(defaultLibNode);
    for (const root of this.input.rootNames) this.nodeFor(toCompilerPath(root));

    while (this.pending.length > 0) this.expand(this.pending.pop() as number);

    const preludeSeeds: number[] = [];
    for (let node = 0; node < this.fileNames.length; node++) {
      for (const lib of this.facts[node].libReferences) {
        const libNode = this.indexOf.get(lib);
        if (libNode !== undefined) libSeeds.add(libNode);
      }
    }
    for (let node = 0; node < this.fileNames.length; node++) {
      if (libSeeds.has(node)) preludeSeeds.push(node);
      else if (!this.isLib(node) && this.facts[node].declaresGlobals) preludeSeeds.push(node);
    }

    return {
      nodes: this.fileNames.map((fileName, node) => ({
        fileName,
        textBytes: this.textBytes[node],
        imports: this.imports[node],
      })),
      preludeSeeds,
    };
  }

  private isLib(node: number): boolean {
    return posix.dirname(this.fileNames[node]) === this.libDirectory;
  }

  /** The node for `fileName`, created (and queued for expansion) on first sight; `undefined` when unreadable. */
  private nodeFor(fileName: string): number | undefined {
    const known = this.indexOf.get(fileName);
    if (known !== undefined) return known;
    const text = this.input.host.readFile(fileName);
    if (text === undefined) return undefined;
    const node = this.fileNames.length;
    this.indexOf.set(fileName, node);
    this.fileNames.push(fileName);
    this.textBytes.push(text.length);
    this.imports.push([]);
    this.facts.push({ declaresGlobals: false, libReferences: [] });
    this.pending.push(node);
    this.texts.set(node, text);
    return node;
  }

  /** Source texts of queued nodes, dropped once the node is expanded. */
  private readonly texts = new Map<number, string>();

  private expand(node: number): void {
    const fileName = this.fileNames[node];
    const text = this.texts.get(node) ?? "";
    this.texts.delete(node);
    const isJs = JS_FILE.test(fileName);
    const scanned = ts.preProcessFile(text, true, isJs);
    const targets = new Set<number>();
    const add = (target: string | undefined): void => {
      if (target === undefined) return;
      const targetNode = this.nodeFor(toCompilerPath(target));
      if (targetNode !== undefined && targetNode !== node) targets.add(targetNode);
    };

    for (const ref of scanned.importedFiles) add(this.resolveModule(ref.fileName, fileName));
    for (const ref of scanned.referencedFiles) {
      const referenced = resolvePath(dirname(fileName), ref.fileName);
      if (this.input.host.fileExists(referenced)) add(referenced);
    }
    for (const ref of scanned.typeReferenceDirectives) add(this.resolveTypeReference(ref.fileName, fileName));
    const libReferences: string[] = [];
    for (const ref of scanned.libReferenceDirectives) {
      const lib = `${this.libDirectory}/lib.${ref.fileName.toLowerCase()}.d.ts`;
      add(lib);
      libReferences.push(lib);
    }

    this.imports[node] = [...targets];
    this.facts[node] = {
      declaresGlobals: this.isLib(node) ? false : declaresGlobals(fileName, text, isJs, scanned),
      libReferences,
    };
  }

  /**
   * Where `specifier` resolves from `containingFile`, as the compiler would take
   * it into a Program — or `undefined` when it would not. A JavaScript file
   * inside `node_modules` is never loaded (`maxNodeModuleJsDepth` is 0), and a
   * JSON module needs `resolveJsonModule`, which the resolver does not set.
   */
  private resolveModule(specifier: string, containingFile: string): string | undefined {
    const { resolvedModule } = this.input.moduleResolution.resolve(
      specifier,
      containingFile,
      undefined,
      this.input.compilerOptions,
    );
    if (resolvedModule === undefined) return undefined;
    const { extension, isExternalLibraryImport, resolvedFileName } = resolvedModule;
    if (extension === JSON_EXTENSION) return undefined;
    if (isExternalLibraryImport === true && JS_EXTENSIONS.has(extension)) return undefined;
    return resolvedFileName;
  }

  private resolveTypeReference(name: string, containingFile: string): string | undefined {
    const { resolvedTypeReferenceDirective } = ts.resolveTypeReferenceDirective(
      name,
      containingFile,
      this.input.compilerOptions,
      this.input.host,
    );
    return resolvedTypeReferenceDirective?.resolvedFileName;
  }
}

/**
 * Does this file belong in the prelude — does it contribute declarations the
 * whole Program sees as GLOBAL? The scope is the spec's (§2), split by origin:
 *
 * - a project file qualifies only as a DECLARATION file: a global script, a
 *   `declare global`, or an ambient `declare module`. A source file's
 *   `declare global` — a spec file augmenting `Window` — stays with its batch.
 * - a dependency file qualifies as a global script or a `declare global` only.
 *   Its ambient `declare module "x"` shapes imports of "x", which the importing
 *   file's closure reaches on its own; taking them all measured 799 prelude
 *   files and 16.1 MB on taxdome, most of it outside any global.
 *
 * Decided on a parse, not on the scanner: `ts.preProcessFile` cannot tell
 * `export const x` from no export at all, and a script is global precisely
 * because it has neither. The parse is transient — nothing retains it.
 */
function declaresGlobals(fileName: string, text: string, isJs: boolean, scanned: ts.PreProcessedFileInfo): boolean {
  const isDependency = fileName.includes("/node_modules/");
  if (!isDependency && !DECLARATION_FILE.test(fileName)) return false;
  const hasAmbientModules = scanned.ambientExternalModules !== undefined && scanned.ambientExternalModules.length > 0;
  if (!isDependency && hasAmbientModules) return true;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, false, scriptKindOf(fileName));
  if (sourceFile.statements.some(isGlobalAugmentation)) return true;
  if (!isDependency && sourceFile.statements.some(isAmbientModuleDeclaration)) return true;
  if (ts.isExternalModule(sourceFile)) return false;
  // A script of ambient module declarations only declares no globals.
  if (isDependency && hasAmbientModules && sourceFile.statements.every(isAmbientModuleDeclaration)) return false;
  // A JavaScript file with CommonJS exports or requires is bound as a module,
  // so its top-level names are file-local, not globals.
  if (isJs && (scanned.importedFiles.length > 0 || sourceFile.statements.some(isCommonJsExport))) return false;
  return true;
}

/** A top-level `module.exports = …` / `exports.name = …` assignment. */
function isCommonJsExport(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement)) return false;
  const { expression } = statement;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  let target: ts.Expression = expression.left;
  while (ts.isPropertyAccessExpression(target)) {
    const receiver: ts.Expression = target.expression;
    if (ts.isIdentifier(receiver) && (receiver.text === "exports" || receiver.text === "module")) return true;
    target = receiver;
  }
  return false;
}

/** `declare global { … }` at the top level. */
function isGlobalAugmentation(statement: ts.Statement): boolean {
  return ts.isModuleDeclaration(statement) && (statement.flags & ts.NodeFlags.GlobalAugmentation) !== 0;
}

/** `declare module "…" { … }` at the top level. */
function isAmbientModuleDeclaration(statement: ts.Statement): boolean {
  return ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name);
}

function scriptKindOf(fileName: string): ts.ScriptKind {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (JS_FILE.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function toCompilerPath(fileName: string): string {
  return fileName.split("\\").join("/");
}
