/**
 * Decodes a rust-analyzer `scip` index into the call-site → definition lookup
 * the Rust chain's last slot reads (bd s3i8m.6 R2a).
 *
 * A minimal protobuf walk over the SCIP schema — only the fields the lookup
 * needs are read, everything else is skipped by wire type:
 *
 *   Index      { 2: repeated Document documents }
 *   Document   { 1: string relative_path, 2: repeated Occurrence occurrences }
 *   Occurrence { 1: repeated int32 range (packed or not), 2: string symbol, 3: int32 symbol_roles }
 *
 * `range` is `[line, startCol, endCol]` (single line) or
 * `[startLine, startCol, endLine, endCol]`; lines are 0-based and columns count
 * UTF-16 code units (SCIP's default position encoding). A role bit 1 marks the
 * DEFINITION occurrence; every other occurrence is a reference.
 *
 * Locals (`local <n>`) are document-scoped in SCIP, so they are qualified to
 * `local <n>@<relPath>` before interning — two files' `local 3` stay apart.
 */

import type {
  RustAnalyzerScipIndex,
  RustAnalyzerScipIndexData,
  RustScipDefinition,
} from "../../contracts/types/language.js";

const INDEX_DOCUMENTS = 2;
const DOCUMENT_RELATIVE_PATH = 1;
const DOCUMENT_OCCURRENCES = 2;
const OCCURRENCE_RANGE = 1;
const OCCURRENCE_SYMBOL = 2;
const OCCURRENCE_ROLES = 3;
const ROLE_DEFINITION = 1;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const LOCAL_PREFIX = "local ";

/** One protobuf field: a varint value, or the byte span of a length-delimited payload. */
type ProtoField =
  | { field: number; wire: typeof WIRE_VARINT; value: number }
  | { field: number; wire: typeof WIRE_LENGTH_DELIMITED; start: number; end: number };

/** Sequential reader over one message's bytes; throws on malformed input. */
class ProtoReader {
  constructor(
    private readonly bytes: Uint8Array,
    private offset: number,
    private readonly end: number,
  ) {}

  *fields(): Iterable<ProtoField> {
    while (this.offset < this.end) {
      const key = this.varint();
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (wire === WIRE_VARINT) yield { field, wire, value: this.varint() };
      else if (wire === WIRE_LENGTH_DELIMITED) {
        const length = this.varint();
        const start = this.offset;
        this.advance(length);
        yield { field, wire, start, end: start + length };
      } else if (wire === WIRE_FIXED64) this.advance(8);
      else if (wire === WIRE_FIXED32) this.advance(4);
      else throw new Error(`SCIP decode: unsupported wire type ${wire} at byte ${this.offset}`);
    }
  }

  varint(): number {
    let result = 0;
    let scale = 1;
    for (;;) {
      if (this.offset >= this.end) throw new Error("SCIP decode: truncated varint");
      const byte = this.bytes[this.offset++] ?? 0;
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
  }

  /** True once every byte of the message has been read. */
  get done(): boolean {
    return this.offset >= this.end;
  }

  private advance(count: number): void {
    if (this.offset + count > this.end) throw new Error("SCIP decode: field runs past its message");
    this.offset += count;
  }
}

interface DecodedOccurrence {
  line: number;
  startCol: number;
  singleLine: boolean;
  symbol: string;
  roles: number;
}

/** Decode SCIP bytes into the JSON-safe lookup data. Throws on bytes that are not a SCIP index. */
export function decodeRustAnalyzerScip(bytes: Uint8Array): RustAnalyzerScipIndexData {
  const decoder = new TextDecoder();
  const symbols: string[] = [];
  const symbolIndex = new Map<string, number>();
  const intern = (symbol: string): number => {
    let index = symbolIndex.get(symbol);
    if (index === undefined) {
      index = symbols.length;
      symbols.push(symbol);
      symbolIndex.set(symbol, index);
    }
    return index;
  };
  const references: Record<string, number[]> = {};
  const definitions: Record<string, [string, number]> = {};

  for (const top of new ProtoReader(bytes, 0, bytes.length).fields()) {
    if (top.field !== INDEX_DOCUMENTS || top.wire !== WIRE_LENGTH_DELIMITED) continue;
    let relPath = "";
    const occurrences: DecodedOccurrence[] = [];
    for (const docField of new ProtoReader(bytes, top.start, top.end).fields()) {
      if (docField.wire !== WIRE_LENGTH_DELIMITED) continue;
      if (docField.field === DOCUMENT_RELATIVE_PATH) {
        relPath = decoder.decode(bytes.subarray(docField.start, docField.end));
      } else if (docField.field === DOCUMENT_OCCURRENCES) {
        const occurrence = decodeOccurrence(bytes, docField.start, docField.end, decoder);
        if (occurrence) occurrences.push(occurrence);
      }
    }
    const refs: number[] = [];
    for (const occurrence of occurrences) {
      const symbol = occurrence.symbol.startsWith(LOCAL_PREFIX) ? `${occurrence.symbol}@${relPath}` : occurrence.symbol;
      const index = intern(symbol);
      if ((occurrence.roles & ROLE_DEFINITION) !== 0) definitions[String(index)] = [relPath, occurrence.line];
      else if (occurrence.singleLine) refs.push(occurrence.line, occurrence.startCol, index);
    }
    if (refs.length > 0) references[relPath] = refs;
  }
  return { symbols, references, definitions };
}

function decodeOccurrence(
  bytes: Uint8Array,
  start: number,
  end: number,
  decoder: TextDecoder,
): DecodedOccurrence | undefined {
  let range: number[] = [];
  let symbol = "";
  let roles = 0;
  for (const field of new ProtoReader(bytes, start, end).fields()) {
    if (field.field === OCCURRENCE_RANGE) {
      if (field.wire === WIRE_LENGTH_DELIMITED) range = readPacked(bytes, field.start, field.end);
      else range.push(field.value);
    } else if (field.field === OCCURRENCE_SYMBOL && field.wire === WIRE_LENGTH_DELIMITED) {
      symbol = decoder.decode(bytes.subarray(field.start, field.end));
    } else if (field.field === OCCURRENCE_ROLES && field.wire === WIRE_VARINT) {
      roles = field.value;
    }
  }
  const [line, startCol, third] = range;
  if (line === undefined || startCol === undefined || symbol.length === 0) return undefined;
  const singleLine = range.length === 3 || (range.length === 4 && third === line);
  return { line, startCol, singleLine, symbol, roles };
}

function readPacked(bytes: Uint8Array, start: number, end: number): number[] {
  const reader = new ProtoReader(bytes, start, end);
  const values: number[] = [];
  while (!reader.done) values.push(reader.varint());
  return values;
}

/** The package field of a SCIP global symbol (`<scheme> <manager> <package> <version> <descriptors>`); "" for a local. */
export function scipSymbolPackage(symbol: string): string {
  if (symbol.startsWith(LOCAL_PREFIX)) return "";
  const parts = symbol.split(" ");
  return parts.length >= 5 ? (parts[2] ?? "") : "";
}

/**
 * The in-memory lookup over decoded data; `data` may come straight from the JSON cache.
 *
 * `servable` narrows a PARTIAL index (cached for an older tree): a reference in a
 * non-servable file answers null, and so does an in-project definition whose target
 * file is non-servable (its line may have moved). Definitions stay in `data` — deleting
 * them would make `describeSymbol` report a project symbol as external.
 */
export function createRustAnalyzerScipIndex(
  data: RustAnalyzerScipIndexData,
  identity: string,
  servable?: (relPath: string) => boolean,
): RustAnalyzerScipIndex {
  const byFile = new Map<string, Map<number, number>>();
  for (const [relPath, triples] of Object.entries(data.references)) {
    const byPosition = new Map<number, number>();
    for (let i = 0; i + 2 < triples.length; i += 3) {
      if ((triples[i + 1] ?? MAX_COLUMN) >= MAX_COLUMN) continue;
      byPosition.set(positionKey(triples[i] ?? 0, triples[i + 1] ?? 0), triples[i + 2] ?? 0);
    }
    byFile.set(relPath, byPosition);
  }
  const projectPackages = new Set<string>();
  for (const key of Object.keys(data.definitions)) {
    const symbol = data.symbols[Number(key)];
    if (symbol !== undefined) projectPackages.add(scipSymbolPackage(symbol));
  }
  return {
    identity,
    definitionAt: (relPath, line, utf16Col) => {
      if (utf16Col < 0 || utf16Col >= MAX_COLUMN || line < 1) return null;
      if (servable && !servable(relPath)) return null;
      const index = byFile.get(relPath)?.get(positionKey(line - 1, utf16Col));
      if (index === undefined) return null;
      const described = describeSymbol(data, index, projectPackages);
      if (described?.inProject && servable && described.relPath !== undefined && !servable(described.relPath)) {
        return null;
      }
      return described;
    },
  };
}

function describeSymbol(
  data: RustAnalyzerScipIndexData,
  index: number,
  projectPackages: ReadonlySet<string>,
): RustScipDefinition | null {
  const symbol = data.symbols[index];
  if (symbol === undefined) return null;
  const definition = data.definitions[String(index)];
  const pkg = scipSymbolPackage(symbol);
  const described = {
    symbol,
    package: pkg,
    ...describeDescriptors(symbol),
    packageInProject: projectPackages.has(pkg),
  };
  if (!definition) return { ...described, inProject: false };
  return { ...described, inProject: true, relPath: definition[0], line: definition[1] + 1 };
}

/** The descriptor chain of a global symbol: everything after `<scheme> <manager> <package> <version> `. */
function scipDescriptors(symbol: string): string {
  return symbol.split(" ").slice(4).join(" ");
}

const IMPL_TRAIT = /impl#\[[^\]]*\]\[([^\]]+)\]/;
const TRAILING_NAME = /(?:`([^`]+)`|([^\s/#.!():[\]`]+))$/;
/** `<Trait>#m().` — a callable whose enclosing descriptor is a type, not an `impl#[…]` block. */
const DECLARING_TRAIT = /(?:^|[/#])(?:`([^`]+)`|([^\s/#.!():[\]`]+))#(?:`[^`]+`|[^\s/#.!():[\]`]+)\(\)\.$/;

function describeDescriptors(
  symbol: string,
): Pick<RustScipDefinition, "name" | "kind" | "implTrait" | "declaringTrait"> {
  if (symbol.startsWith(LOCAL_PREFIX)) return { name: "", kind: "local" };
  const descriptors = scipDescriptors(symbol);
  const implTrait = IMPL_TRAIT.exec(descriptors)?.[1];
  const withTrait = implTrait === undefined ? {} : { implTrait };
  const suffixes = [
    ["().", "callable"],
    ["#", "type"],
    ["!", "macro"],
  ] as const;
  for (const [suffix, kind] of suffixes) {
    if (!descriptors.endsWith(suffix)) continue;
    const match = TRAILING_NAME.exec(descriptors.slice(0, -suffix.length));
    const declaring = kind === "callable" ? DECLARING_TRAIT.exec(descriptors) : null;
    const declaringTrait = declaring?.[1] ?? declaring?.[2];
    return {
      name: match?.[1] ?? match?.[2] ?? "",
      kind,
      ...withTrait,
      ...(declaringTrait === undefined ? {} : { declaringTrait }),
    };
  }
  return { name: "", kind: "other", ...withTrait };
}

/** Columns at or past this are never keyed (a minified line); one safe integer then keys line + column. */
const MAX_COLUMN = 0x100000;

function positionKey(line0: number, col: number): number {
  return line0 * MAX_COLUMN + col;
}
