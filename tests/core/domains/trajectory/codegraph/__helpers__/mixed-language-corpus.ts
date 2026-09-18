import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ChunkLookupEntry } from "../../../../../../src/core/contracts/types/provider.js";

/**
 * A small Rails + React shaped corpus — TypeScript, Ruby and JavaScript in one
 * repository — built to exercise what a per-language partition of the codegraph
 * pass could get wrong (bd tea-rags-mcp-sgo8v):
 *
 *  - CROSS-LANGUAGE NAMESAKES. A TypeScript `User` class and a Ruby `User`
 *    model; `create` / `save` / `call` defined in both languages. The symbol
 *    table and the run-global maps are language-blind, so what one language's
 *    resolver sees depends on what the OTHER language contributed.
 *  - A THIRD LANGUAGE that shares a partition with another: JavaScript rides
 *    with Ruby when TypeScript is the largest language.
 *  - CYCLES in both scopes (a TypeScript import cycle, a Ruby method
 *    recursion) so SCC and PageRank have something to compute — and a
 *    collection-wide fan-in p95, which every file's `isHub` is read against
 *    whichever partition wrote the edges behind it.
 */
export const MIXED_LANGUAGE_CORPUS: Readonly<Record<string, string>> = {
  "web/api.ts": [
    'import { renderAll } from "./view";',
    "export class Client {",
    "  fetch(): number {",
    "    return renderAll();",
    "  }",
    "}",
    "export function update(): number {",
    "  return new Client().fetch();",
    "}",
    "",
  ].join("\n"),
  "web/view.ts": [
    'import { update } from "./api";',
    "export function renderAll(): number {",
    "  return 1;",
    "}",
    "export function refresh(): number {",
    "  return update();",
    "}",
    "",
  ].join("\n"),
  "web/user.ts": [
    "export class Base {",
    "  save(): void {}",
    "}",
    "export class User extends Base {",
    "  create(): void {",
    "    this.save();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "web/main.ts": [
    'import { Client, update } from "./api";',
    'import { User } from "./user";',
    'import { legacyInit } from "./legacy.js";',
    "export function main(): number {",
    "  legacyInit();",
    "  new User().create();",
    "  create();",
    "  call();",
    "  return new Client().fetch() + update();",
    "}",
    "function create(): void {}",
    "",
  ].join("\n"),
  "web/legacy.js": [
    "export function legacyInit() {",
    "  return helper();",
    "}",
    "function helper() {",
    "  return 1;",
    "}",
    "",
  ].join("\n"),
  "app/models/application_record.rb": ["class ApplicationRecord", "  def save", "    true", "  end", "end", ""].join(
    "\n",
  ),
  "app/models/user.rb": [
    "class User < ApplicationRecord",
    "  def create",
    "    save",
    "  end",
    "",
    "  def self.find_all",
    "    [new]",
    "  end",
    "end",
    "",
  ].join("\n"),
  "app/services/sync_service.rb": [
    "class SyncService",
    "  def call",
    "    User.find_all.each { |u| u.create }",
    "    retry_later(3)",
    "  end",
    "",
    "  def retry_later(n)",
    "    retry_later(n - 1) if n > 0",
    "  end",
    "end",
    "",
  ].join("\n"),
  "README.md": "# mixed corpus\n",
};

/** Write the corpus under `root`; returns its relPaths in a stable order. */
export function writeMixedLanguageCorpus(root: string): string[] {
  const relPaths = Object.keys(MIXED_LANGUAGE_CORPUS).sort();
  for (const relPath of relPaths) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, MIXED_LANGUAGE_CORPUS[relPath]);
  }
  return relPaths;
}

/**
 * One stored chunk per file, spanning it whole — what the deferred chunk pass
 * is handed for a file the index holds as a single chunk. Enough to exercise
 * the chunk-owner settlement and the symbol→chunk join on every language.
 */
export function wholeFileChunkMap(relPaths: readonly string[]): Map<string, ChunkLookupEntry[]> {
  const chunkMap = new Map<string, ChunkLookupEntry[]>();
  for (const relPath of relPaths) {
    const lines = (MIXED_LANGUAGE_CORPUS[relPath] ?? "").split("\n").length;
    chunkMap.set(relPath, [{ chunkId: `chunk:${relPath}`, startLine: 1, endLine: lines }]);
  }
  return chunkMap;
}
