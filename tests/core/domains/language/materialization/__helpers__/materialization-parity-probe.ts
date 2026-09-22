/**
 * Shared corpus and probe for the two materialization guards next door.
 *
 * WHY this exists at all: production and unit tests walk DIFFERENT trees. The
 * codegraph file extractor materializes before extracting
 * (`CodegraphFileExtractor`), so every walker in the pipeline reads an
 * `AstNode` built by `materializeTree`; a walker unit test parses natively and
 * reads a `Parser.SyntaxNode`. `materializeTree` rebuilds each node's field map
 * from `fieldNameForChild(i)`, which answers ONE name per child index, while
 * the native tree answers `childForFieldName(name)` out of tree-sitter's own
 * table, where a single child may be registered under SEVERAL names. Any name
 * but the first one therefore answers on the native tree and `null` on the
 * materialized one — so a walker that reads that field returns a value in every
 * spec and nothing in production, silently, with a green suite.
 *
 * That is not hypothetical: `tree-sitter-swift` registers a `parameter`'s type
 * child under `name`, and Swift's annotated parameters, annotated locals and
 * the whole stored-property channel evaluated to nothing on a real index while
 * 102 Swift specs stayed green. `src/core/domains/language/CLAUDE.md` records
 * it.
 *
 * The corpus below is SYNTHETIC and lives in the repo on purpose: the guards
 * have to run on a clean CI checkout, with no dependency on a corpus sitting in
 * someone's home directory.
 */

import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

import Parser from "tree-sitter";

import type { AstNode, MaterializedTree } from "../../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph-extraction.js";
import type { CollectedSymbolRange } from "../../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../../src/core/domains/language/factory.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CODEGRAPH_LANGUAGES } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/file-extractor.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";

/** Repository root — six levels up from `tests/core/domains/language/materialization/__helpers__/`. */
const REPO_ROOT = join(import.meta.dirname, "../../../../../..");

/** Every walker, resolver and kernel module whose field reads the guards must cover. */
const LANGUAGE_SOURCE_ROOT = join(REPO_ROOT, "src/core/domains/language");

/**
 * One synthetic source file, paired with the grammar it is parsed by.
 *
 * Keyed by GRAMMAR, not by language: `.ts` and `.tsx` load different
 * tree-sitter grammars behind one walker, and a field collision in one of them
 * says nothing about the other.
 */
export interface MaterializationParityFixture {
  /** Pin key and failure-message label. */
  grammarKey: string;
  /** `CODEGRAPH_LANGUAGES` language name — selects the walker. */
  language: string;
  /** `CODEGRAPH_LANGUAGES` key — selects the grammar. */
  extension: string;
  /** Path the extraction is attributed to; some walkers read it (Ruby's Zeitwerk channel). */
  relPath: string;
  source: string;
}

const TYPESCRIPT_SOURCE = `import { readFileSync } from "node:fs";
import type { Formatter } from "./formatter.js";

export const DEFAULT_LIMIT = 25;
const registry = { entries: 0, owner: "acme" };

export type Rows = Record<string, number>;
export type NegativeLimit = -1;
export type ReadonlyNames = readonly string[];
export type LedgerKey = keyof Rows;
export type RegistryShape = typeof registry;
export type EntryCount = typeof registry.entries;
export type FirstName = ReadonlyNames[0];

export interface Row {
  label: string;
  amount: number;
}

export class Ledger implements Formatter<Row> {
  private readonly rows: Rows = {};
  static create(owner: string): Ledger {
    return new Ledger(owner);
  }
  constructor(public owner: string) {}
  render(row: Row, limit: number = DEFAULT_LIMIT): string {
    const text = readFileSync(row.label, "utf8");
    this.rows[text] = row.amount + limit;
    return \`\${this.owner}:\${text}\`;
  }
  async settle(): Promise<boolean> {
    const labels = Object.keys(this.rows);
    for (const label of labels) {
      if (label.length > 0) await Promise.resolve(label);
    }
    return labels.length > 0;
  }
}

export function summarize(ledger: Ledger, ...extra: string[]): Rows {
  const { owner } = ledger;
  const [first] = extra;
  return { [owner]: first?.length ?? registry.entries };
}
`;

const TSX_SOURCE = `import { useState } from "react";

interface RowProps {
  label: string;
  onPick?: (id: number) => void;
}

export function Row({ label, onPick }: RowProps) {
  const [count, setCount] = useState<number>(0);
  const bump = (): void => {
    setCount(count + 1);
    onPick?.(count);
  };
  return (
    <li className="row" onClick={bump}>
      <span title={label}>{label}</span>
      {count > 0 ? <em>{count}</em> : null}
    </li>
  );
}
`;

const JAVASCRIPT_SOURCE = `import { EventEmitter } from "node:events";
import format from "./format.js";

export class Ledger extends EventEmitter {
  #entries = new Map();
  static from(rows) {
    return new Ledger(rows);
  }
  constructor(rows = []) {
    super();
    this.rows = rows;
  }
  post(amount, memo) {
    this.#entries.set(memo, amount);
    const [head, ...tail] = this.rows;
    this.emit("posted", format("%s", head), tail.length);
    return this.rows?.[0]?.id ?? null;
  }
  async *stream() {
    for (const row of this.rows) yield row;
  }
}

export default function summarize(ledger, { limit = 10 } = {}) {
  const total = ledger.rows.reduce((acc, row) => acc + row.amount, 0);
  switch (true) {
    case total > limit:
      return "big";
    default:
      return \`small \${total}\`;
  }
}
`;

const PYTHON_SOURCE = `from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Optional

DEFAULT_LIMIT: int = 25


@dataclass
class Row:
    label: str
    amount: float = 0.0
    tags: dict[str, Any] = field(default_factory=dict)


class Ledger(Row):
    registry: dict[str, "Ledger"] = {}

    def __init__(self, owner: str, rows: Optional[list[Row]] = None) -> None:
        super().__init__(label=owner)
        self.owner = owner
        self.rows = rows or []

    @property
    def total(self) -> float:
        return sum(row.amount for row in self.rows)

    @staticmethod
    def create(owner: str) -> "Ledger":
        return Ledger(owner)

    def post(self, amount: float, memo: str = "") -> bool:
        path = os.path.join(self.owner, memo)
        self.tags[path] = amount
        for row in self.rows:
            if row.label == memo:
                row.amount += amount
        with open(path) as handle:
            handle.read()
        try:
            return bool(self.total)
        except ValueError as err:
            raise RuntimeError(memo) from err


def summarize(ledger: Ledger, *args: str, **kwargs: Any) -> dict[str, float]:
    return {name: ledger.total for name in args}
`;

const RUBY_SOURCE = `require "json"
require_relative "row"

module Acme
  class Ledger < Base
    include Comparable
    attr_accessor :owner, :rows
    ENTRIES = {}.freeze

    def self.create(owner)
      new(owner)
    end

    def initialize(owner, rows = [])
      @owner = owner
      @rows = rows
    end

    def post(amount, memo: nil)
      rows.each { |row| row.apply(amount) }
      ENTRIES[memo] = amount
      Row.new(amount: amount, memo: memo).tap do |row|
        row.settle!
      end
    rescue StandardError => e
      raise ArgumentError, e.message
    end

    def total
      rows.map(&:amount).sum
    end
  end
end
`;

const GO_SOURCE = `package ledger

import (
	"errors"
	"fmt"
)

type Row struct {
	Label  string
	Amount float64
}

type Formatter interface {
	Render(row Row) (string, error)
}

type Ledger struct {
	Owner string
	rows  []Row
	index map[string]int
}

func NewLedger(owner string) *Ledger {
	return &Ledger{Owner: owner, index: make(map[string]int)}
}

func (l *Ledger) Post(amount float64, memo string) (string, error) {
	if amount < 0 {
		return "", errors.New("negative amount")
	}
	l.rows = append(l.rows, Row{Label: memo, Amount: amount})
	for i, row := range l.rows {
		l.index[row.Label] = i
	}
	switch {
	case len(l.rows) == 0:
		return "", nil
	default:
		return fmt.Sprintf("%s:%f", l.Owner, amount), nil
	}
}

func (l Ledger) Render(row Row) (string, error) {
	return fmt.Sprintf("%v", row.Amount), nil
}
`;

const JAVA_SOURCE = `package com.example.ledger;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

public class Ledger implements Formatter<Row> {
    private static final int DEFAULT_LIMIT = 25;
    private final String owner;
    private final List<Row> rows = new ArrayList<>();

    public Ledger(String owner) {
        this.owner = owner;
    }

    public static Ledger create(String owner) {
        return new Ledger(owner);
    }

    @Override
    public String render(Row row, int limit) {
        return owner + ":" + row.amount() + limit;
    }

    public boolean post(double amount, String memo) throws IllegalStateException {
        Row row = new Row(memo, amount);
        rows.add(row);
        for (Row each : rows) {
            if (each.amount() > DEFAULT_LIMIT) {
                return true;
            }
        }
        Map<String, Row> index = Map.of(memo, row);
        return index.containsKey(memo);
    }
}
`;

const RUST_SOURCE = `use std::collections::HashMap;
use std::fmt::{self, Display};

pub const DEFAULT_LIMIT: usize = 25;

#[derive(Debug, Clone)]
pub struct Row {
    pub label: String,
    pub amount: f64,
}

pub trait Formatter {
    fn render(&self, row: &Row) -> String;
}

pub struct Ledger<T: Formatter> {
    owner: String,
    rows: Vec<Row>,
    index: HashMap<String, usize>,
    formatter: T,
}

impl<T: Formatter> Ledger<T> {
    pub fn new(owner: &str, formatter: T) -> Self {
        Ledger {
            owner: owner.to_string(),
            rows: Vec::new(),
            index: HashMap::new(),
            formatter,
        }
    }

    pub fn post(&mut self, amount: f64, memo: &str) -> Result<String, String> {
        if amount < 0.0 {
            return Err(String::from("negative amount"));
        }
        let row = Row {
            label: memo.to_string(),
            amount,
        };
        self.index.insert(row.label.clone(), self.rows.len());
        self.rows.push(row);
        match self.rows.last() {
            Some(last) => Ok(self.formatter.render(last)),
            None => Err(self.owner.clone()),
        }
    }
}

impl Display for Row {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.label, self.amount)
    }
}
`;

const BASH_SOURCE = `#!/usr/bin/env bash
set -euo pipefail

LEDGER_OWNER="\${1:-acme}"
declare -A ENTRIES=()

log_line() {
  local level="$1"
  shift
  printf '%s %s\\n' "$level" "$*" >&2
}

post_entry() {
  local memo="$1"
  local amount="$2"
  ENTRIES["$memo"]=$amount
  if [[ "$amount" -gt 0 ]]; then
    log_line INFO "posted $memo"
  else
    log_line WARN "skipped $memo"
  fi
  for key in "\${!ENTRIES[@]}"; do
    echo "$key=\${ENTRIES[$key]}"
  done
}

main() {
  local total=0
  while read -r line; do
    total=$((total + 1))
    post_entry "$line" "$total"
  done < <(printf 'a\\nb\\n')
  log_line INFO "total=$total owner=$LEDGER_OWNER"
}

main "$@"
`;

/**
 * Swift is deliberately the densest fixture. Its grammar is the one KNOWN to
 * double-register children, so this source reaches for every shape the real
 * corpora flagged — the `return_type` family (function, protocol function,
 * function type, closure type, subscript), `as` / `is` casts, dictionary types,
 * tuple-type items, type annotations, typealias values and `case .x(let y)`
 * patterns — so that a future walker change against any of them is caught by
 * the inventory pin rather than by a live index.
 */
const SWIFT_SOURCE = `import Foundation

typealias Rows = [String: Int]

struct Row {
    let label: String
    var amount: Double
}

enum Currency {
    case usd
    case other(code: String)
}

protocol Renderer {
    func render(row: Row) -> String
    var caption: String { get }
}

final class Ledger: Renderer {
    let owner: String
    var rows: [Row] = []
    var index: [String: Int] = [:]
    var caption: String { return owner }

    init(owner: String, rows: [Row] = []) {
        self.owner = owner
        self.rows = rows
    }

    func render(row: Row) -> String {
        return "\\(owner):\\(row.amount)"
    }

    func post(_ memo: String, amount: Double, currency: Currency = .usd) -> Rows? {
        let raw: Any = amount
        guard let value = raw as? Double else { return nil }
        if raw is Int { return [:] }
        let pair: (label: String, amount: Double) = (memo, value)
        let transform: (Int) -> String = { n in String(n) }
        let describe = { (code: String) -> String in code.uppercased() }
        var out: Rows = [:]
        switch currency {
        case .usd:
            out[memo] = Int(value)
        case .other(let code):
            out[describe(code)] = Int(value)
        }
        switch raw {
        case let text as String:
            out[text] = 0
        case is Int:
            break
        default:
            break
        }
        for row in rows {
            index[row.label] = Int(row.amount)
        }
        return out.isEmpty ? nil : [transform(1): Int(pair.amount)]
    }

    subscript(key: String) -> Int {
        return index[key] ?? 0
    }
}

extension Ledger {
    static func make(owner: String) -> Ledger {
        return Ledger(owner: owner)
    }
}
`;

/**
 * One fixture per grammar reachable from `CODEGRAPH_LANGUAGES`. The completeness
 * of this list is asserted by the guards, so adding a language to the production
 * table without a fixture fails rather than silently going unguarded.
 */
export const MATERIALIZATION_PARITY_CORPUS: readonly MaterializationParityFixture[] = [
  {
    grammarKey: "typescript",
    language: "typescript",
    extension: ".ts",
    relPath: "src/ledger.ts",
    source: TYPESCRIPT_SOURCE,
  },
  {
    grammarKey: "typescript-tsx",
    language: "typescript",
    extension: ".tsx",
    relPath: "src/Row.tsx",
    source: TSX_SOURCE,
  },
  {
    grammarKey: "javascript",
    language: "javascript",
    extension: ".js",
    relPath: "src/ledger.js",
    source: JAVASCRIPT_SOURCE,
  },
  { grammarKey: "python", language: "python", extension: ".py", relPath: "pkg/ledger.py", source: PYTHON_SOURCE },
  { grammarKey: "ruby", language: "ruby", extension: ".rb", relPath: "app/models/ledger.rb", source: RUBY_SOURCE },
  { grammarKey: "go", language: "go", extension: ".go", relPath: "internal/ledger/ledger.go", source: GO_SOURCE },
  {
    grammarKey: "java",
    language: "java",
    extension: ".java",
    relPath: "src/main/java/com/example/ledger/Ledger.java",
    source: JAVA_SOURCE,
  },
  { grammarKey: "rust", language: "rust", extension: ".rs", relPath: "src/ledger.rs", source: RUST_SOURCE },
  {
    grammarKey: "swift",
    language: "swift",
    extension: ".swift",
    relPath: "Sources/Ledger.swift",
    source: SWIFT_SOURCE,
  },
  { grammarKey: "bash", language: "bash", extension: ".sh", relPath: "scripts/ledger.sh", source: BASH_SOURCE },
];

/** Parse a fixture with the SAME grammar row the codegraph extractor would use. */
export function parseFixture(fixture: MaterializationParityFixture): Parser.Tree {
  const config = CODEGRAPH_LANGUAGES[fixture.extension];
  if (config === undefined) throw new Error(`no CODEGRAPH_LANGUAGES row for ${fixture.extension}`);
  const parser = new Parser();
  parser.setLanguage(config.loadParser());
  return parser.parse(fixture.source);
}

/**
 * Distinct grammar objects `CODEGRAPH_LANGUAGES` can load. Two extensions
 * sharing one grammar (`.mjs` / `.cjs` / `.js`) collapse to one entry; `.ts`
 * and `.tsx` do not.
 */
export function distinctGrammarExtensions(): string[] {
  const seen = new Map<unknown, string>();
  for (const [extension, config] of Object.entries(CODEGRAPH_LANGUAGES)) {
    const grammar: unknown = config.loadParser();
    if (!seen.has(grammar)) seen.set(grammar, extension);
  }
  return [...seen.values()];
}

/** A `(nodeType, fieldName)` pair the native tree answers and the materialized one loses. */
export interface MaterializedFieldLoss {
  /** `${nodeType}.${fieldName}` — the pinned identity. */
  pair: string;
  occurrences: number;
  /** First losing node's source text, trimmed — enough to recognise the shape. */
  example: string;
}

/**
 * Ask BOTH trees for every candidate field name, at every node.
 *
 * The walk is index-parallel: `materializeTree` appends one child per non-null
 * native child index, in order, so child `i` of the native node is child `i` of
 * the materialized node. Walking by field name instead would beg the question —
 * the field map is exactly what is under test.
 */
export function findMaterializedFieldLosses(
  nativeRoot: Parser.SyntaxNode,
  materializedRoot: AstNode,
  fieldNames: readonly string[],
): MaterializedFieldLoss[] {
  const losses = new Map<string, MaterializedFieldLoss>();

  const visit = (native: Parser.SyntaxNode, materialized: AstNode): void => {
    for (const fieldName of fieldNames) {
      const nativeChild = native.childForFieldName(fieldName);
      if (nativeChild === null) continue;
      if (materialized.childForFieldName(fieldName) !== null) continue;
      const pair = `${native.type}.${fieldName}`;
      const known = losses.get(pair);
      if (known) known.occurrences++;
      else losses.set(pair, { pair, occurrences: 1, example: nativeChild.text.slice(0, 40).replace(/\s+/g, " ") });
    }
    let materializedIndex = 0;
    for (let i = 0; i < native.childCount; i++) {
      const nativeChild = native.child(i);
      if (nativeChild === null) continue;
      const materializedChild = materialized.children[materializedIndex++];
      if (materializedChild === undefined) continue;
      visit(nativeChild, materializedChild);
    }
  };
  visit(nativeRoot, materializedRoot);

  return [...losses.values()].sort((a, b) => a.pair.localeCompare(b.pair));
}

/** What a scan of the language sources found out about `childForFieldName` reads. */
export interface WalkerFieldReadSurvey {
  /** Every distinct field name read, sorted. */
  names: string[];
  /** Total `childForFieldName(` call sites seen. */
  callSites: number;
  /** How many of those passed a plain string literal the scan could read. */
  literalCallSites: number;
}

function listTypeScriptSources(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((entry) => extname(entry) === ".ts")
    .map((entry) => join(root, entry));
}

/**
 * Derive the candidate field names from the sources themselves, rather than
 * from a list somebody has to remember to update. A walker that starts reading
 * a new field is covered by the guards the moment it is written.
 *
 * Regenerate the equivalent by hand with:
 *   grep -rno 'childForFieldName("[^"]*")' --include='*.ts' src/core/domains/language/
 */
export function surveyWalkerFieldReads(): WalkerFieldReadSurvey {
  const names = new Set<string>();
  let callSites = 0;
  let literalCallSites = 0;
  for (const file of listTypeScriptSources(LANGUAGE_SOURCE_ROOT)) {
    const text = readFileSync(file, "utf8");
    callSites += [...text.matchAll(/childForFieldName\(/g)].length;
    for (const match of text.matchAll(/childForFieldName\(\s*"([^"]+)"\s*\)/g)) {
      names.add(match[1]);
      literalCallSites++;
    }
  }
  return { names: [...names].sort(), callSites, literalCallSites };
}

/** Node types tree-sitter emits for source it could not parse. */
export function findParseFailures(root: Parser.SyntaxNode): string[] {
  const failures: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "ERROR" || node.isMissing) failures.push(`${node.type} @ line ${node.startPosition.row + 1}`);
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) visit(child);
    }
  };
  visit(root);
  return failures;
}

/** What one extraction of a fixture produced, off one tree. */
export interface FixtureExtractionRun {
  symbols: CollectedSymbolRange[];
  extraction: FileExtraction;
}

const parityFactory = new LanguageFactory();
const parityComposer = new DefaultSymbolIdComposer();

/**
 * Run the production extraction path — `collectSymbols` then `walker.walk` — over
 * one tree. Mirrors `CodegraphFileExtractor#extractOneFile`, which is what makes a
 * divergence between two calls of this meaningful: both halves read fields, and a
 * loss in `nameOf` moves symbol ids while a loss in the walk empties a channel.
 */
export function runFixtureExtraction(
  fixture: MaterializationParityFixture,
  tree: MaterializedTree,
): FixtureExtractionRun {
  const config = CODEGRAPH_LANGUAGES[fixture.extension];
  if (config === undefined) throw new Error(`no CODEGRAPH_LANGUAGES row for ${fixture.extension}`);
  const { walker } = parityFactory.create(fixture.language);
  if (walker === undefined) throw new Error(`language ${fixture.language} has no walker`);
  const symbols = collectSymbols(
    tree,
    (node) => walker.nameOf(node),
    config.scopeSeparator,
    config.disambiguateOverloads ?? false,
    parityComposer,
  );
  const extraction = walker.walk({
    tree,
    code: fixture.source,
    relPath: fixture.relPath,
    language: config.language,
    chunks: symbols,
  });
  return { symbols, extraction };
}

/** Both trees of one fixture: the one specs read, and the one production reads. */
export function bothTreesOf(fixture: MaterializationParityFixture): {
  native: Parser.Tree;
  materialized: MaterializedTree;
} {
  const native = parseFixture(fixture);
  return { native, materialized: { rootNode: materializeTree(native.rootNode, fixture.source) } };
}
