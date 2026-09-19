/**
 * A small Go corpus on disk, walked and resolved the way production runs it —
 * the shape of the re-validators' `go-sites` probe, as a unit-test fixture.
 *
 * Pass 1 walks every `.go` file outside `vendor/` (codegraph excludes it) into
 * one symbol table and folds the run-global channels in walk order; pass 2
 * resolves every call site of every chunk against them, with the corpus as
 * `projectRoot`, so the resolver reads the corpus's own `go.mod` files (and
 * whatever else of the package tree it reads from disk). A site is keyed
 * `<relPath>:<line> <receiver>.<member>` — `null` for a bare call's receiver —
 * and answers `<symbolId> @ <relPath>`, or `null` when unresolved.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import Parser from "tree-sitter";
import GoLang from "tree-sitter-go";

import type { CallContext, FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoLanguage } from "../../../../../../src/core/domains/language/go/index.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/index.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** Write `files` (relPath → source) under a fresh temp directory and return it. */
export function writeGoCorpus(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "tea-rags-go-corpus-"));
  for (const [relPath, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), content, "utf8");
  }
  return root;
}

export function removeGoCorpus(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function goSourceFiles(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relPath = dir === "" ? entry.name : posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "vendor") out.push(...goSourceFiles(root, relPath));
    } else if (entry.name.endsWith(".go")) {
      out.push(relPath);
    }
  }
  return out.sort();
}

/** Every call site of the corpus at `root`, resolved. */
export function resolveGoCorpus(root: string): Map<string, string | null> {
  const go = new GoLanguage();
  const composer = new DefaultSymbolIdComposer();
  const parser = new Parser();
  parser.setLanguage(GoLang);
  const table = new InMemoryGlobalSymbolTable();
  const functionReturnTypes: Record<string, string> = {};
  const classFieldTypesByClassKey: Record<string, Record<string, string>> = {};
  const buildConstraintsByFile: Record<string, string> = {};
  const extractions: FileExtraction[] = [];

  for (const relPath of goSourceFiles(root)) {
    const code = readFileSync(join(root, relPath), "utf8");
    const tree = { rootNode: materializeTree(parser.parse(code).rootNode, code) };
    const chunks = collectSymbols(tree, (node) => go.walker.nameOf(node), ".", false, composer);
    const extraction = go.walker.walk({ tree, code, relPath, language: "go", chunks });
    table.upsertFile(
      relPath,
      extraction.chunks.map((chunk) => ({
        symbolId: chunk.symbolId,
        fqName: chunk.symbolId,
        shortName: chunk.symbolId.split(/[#.]/).pop() ?? chunk.symbolId,
        relPath,
        scope: chunk.scope,
      })),
    );
    Object.assign(functionReturnTypes, extraction.functionReturnTypes ?? {});
    for (const [classKey, fields] of Object.entries(extraction.classFieldTypesByClassKey ?? {})) {
      classFieldTypesByClassKey[classKey] = { ...classFieldTypesByClassKey[classKey], ...fields };
    }
    if (extraction.buildConstraint !== undefined) {
      buildConstraintsByFile[extraction.relPath] = extraction.buildConstraint;
    }
    extractions.push(extraction);
  }

  go.resolver.prepareResolvePass?.({ expectedFileCount: extractions.length, projectRoot: root });
  const out = new Map<string, string | null>();
  for (const extraction of extractions) {
    for (const chunk of extraction.chunks) {
      const ctx: CallContext = {
        callerFile: extraction.relPath,
        callerScope: chunk.scope,
        callerSymbolId: chunk.symbolId,
        imports: extraction.imports,
        symbolTable: table,
        projectRoot: root,
        localBindings: chunk.localBindings,
        localCallBindings: chunk.localCallBindings,
        callResultBindings: chunk.callResultBindings,
        functionReturnTypes,
        classFieldTypesByClassKey,
        buildConstraintsByFile,
      };
      for (const call of chunk.calls) {
        const target = go.resolver.resolve(call, ctx);
        out.set(
          `${extraction.relPath}:${call.startLine} ${String(call.receiver)}.${call.member}`,
          target ? `${target.targetSymbolId} @ ${target.targetRelPath}` : null,
        );
      }
    }
  }
  return out;
}

/** Write `files`, resolve every call site, and clean up. */
export function resolveGoFiles(files: Readonly<Record<string, string>>): Map<string, string | null> {
  const root = writeGoCorpus(files);
  try {
    return resolveGoCorpus(root);
  } finally {
    removeGoCorpus(root);
  }
}
