import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Independent Rust definition evidence. Coordinates are zero-based UTF-16. */
export interface RustOracleRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
export type RustOracleSourceProvenance = "source" | "generated" | "inactiveCfg";
export interface RustOracleSourceSite {
  relPath: string;
  expressionRange: RustOracleRange;
  tokenRange: RustOracleRange;
  provenance: RustOracleSourceProvenance;
  dispatch: "concrete" | "trait";
}
export interface RustOracleSymbol {
  uri: string;
  symbolId: string;
  range: RustOracleRange;
  selectionRange: RustOracleRange;
  provenance: RustOracleSourceProvenance;
  declarationOnly: boolean;
  traitDeclaration: boolean;
}
export interface RustOracleProvenance {
  workspaceRoot: string;
  firstPartyRoots: string[];
  workspaceRevision: string;
  configurationDigest: string;
  toolchain: string;
  rustAnalyzerVersion: string;
  inventoryRevision: string;
}
export interface RustOracleObservation {
  site: RustOracleSourceSite;
  response: { kind: "success"; value: unknown } | { kind: "timeout" | "error" };
  complete: boolean;
}
export interface RustOracleInput {
  provenance: RustOracleProvenance;
  symbols: RustOracleSymbol[];
  observations: RustOracleObservation[];
}
export interface RustOracleTarget {
  uri: string;
  relPath: string | null;
  selectionRange: RustOracleRange;
  symbolId: string | null;
  provenance: RustOracleSourceProvenance | null;
  declarationOnly: boolean | null;
  traitDeclaration: boolean | null;
}
export interface RustOracleSiteEvidence {
  site: RustOracleSourceSite;
  kind: "inProject" | "external" | "unknown";
  complete: boolean;
  reasons: string[];
  targets: RustOracleTarget[];
}
export interface RustOracleEvidence {
  provenance: RustOracleProvenance;
  sites: RustOracleSiteEvidence[];
}

/**
 * Pure evidence adapter, not a resolver or an LSP client. The caller supplies
 * independently collected definitions and source symbols under one pinned
 * configuration. `complete` asserts only the returned definition set, never
 * the runtime implementations of trait dispatch.
 *
 * Roots and inventory URIs must use one canonical filesystem namespace. This
 * lexical adapter does not read files or resolve symlinks; the collector owns
 * realpath canonicalization before recording evidence.
 */
export function normalizeRustOracleEvidence(input: RustOracleInput): RustOracleEvidence {
  const { provenance } = input;
  for (const value of [
    provenance.workspaceRevision,
    provenance.configurationDigest,
    provenance.toolchain,
    provenance.rustAnalyzerVersion,
    provenance.inventoryRevision,
  ]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("missing pinned Rust oracle provenance");
  }
  const workspaceRoot = canonicalRoot(provenance.workspaceRoot);
  const roots = [...new Set(provenance.firstPartyRoots.map(canonicalRoot))].sort();
  if (!roots.length) throw new Error("missing first-party roots in provenance");
  const inventory = prepareInventory(input.symbols);
  const sites = new Map<string, RustOracleSiteEvidence>();
  for (const observation of input.observations) {
    const { site } = observation;
    if (
      !site.relPath ||
      isAbsolute(site.relPath) ||
      site.relPath.includes("\\") ||
      site.relPath.split("/").some((part) => !part || part === "." || part === "..") ||
      site.relPath.includes(String.fromCharCode(0))
    ) {
      throw new Error("non-canonical source path");
    }
    if (!roots.some((root) => containsPath(root, resolve(workspaceRoot, site.relPath)))) {
      throw new Error("source site outside first-party roots");
    }
    if (
      !validRange(site.expressionRange) ||
      comparePosition(site.expressionRange.start, site.expressionRange.end) === 0 ||
      !validRange(site.tokenRange) ||
      comparePosition(site.tokenRange.start, site.tokenRange.end) === 0 ||
      !containsRange(site.expressionRange, site.tokenRange)
    ) {
      throw new Error("invalid source token range");
    }
    if (
      !validProvenance(site.provenance) ||
      !["concrete", "trait"].includes(site.dispatch) ||
      typeof observation.complete !== "boolean"
    ) {
      throw new Error("invalid source classification");
    }
    const evidence = classifyObservation(observation, inventory, workspaceRoot, roots);
    const key = JSON.stringify([site.relPath, copyRange(site.expressionRange), copyRange(site.tokenRange)]);
    const prior = sites.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(evidence)) {
      throw new Error(`contradictory site evidence: ${key}`);
    }
    sites.set(key, evidence);
  }
  return {
    provenance: { ...provenance, workspaceRoot, firstPartyRoots: roots },
    sites: [...sites.values()].sort(
      (a, b) =>
        compareText(a.site.relPath, b.site.relPath) ||
        comparePosition(a.site.expressionRange.start, b.site.expressionRange.start) ||
        comparePosition(a.site.expressionRange.end, b.site.expressionRange.end) ||
        comparePosition(a.site.tokenRange.start, b.site.tokenRange.start) ||
        comparePosition(a.site.tokenRange.end, b.site.tokenRange.end),
    ),
  };
}

interface RustOracleInventorySymbol extends RustOracleSymbol {
  path: string;
}

function prepareInventory(symbols: RustOracleSymbol[]): RustOracleInventorySymbol[] {
  const inventory = new Map<string, RustOracleInventorySymbol>();
  const uriProvenance = new Map<string, RustOracleSourceProvenance>();
  for (const symbol of symbols) {
    const path = canonicalFileUri(symbol.uri);
    if (
      !path ||
      !symbol.symbolId.trim() ||
      !validRange(symbol.range) ||
      !validRange(symbol.selectionRange) ||
      !containsRange(symbol.range, symbol.selectionRange) ||
      !validProvenance(symbol.provenance) ||
      typeof symbol.declarationOnly !== "boolean" ||
      typeof symbol.traitDeclaration !== "boolean"
    ) {
      throw new Error("invalid independent symbol inventory");
    }
    const knownProvenance = uriProvenance.get(path);
    if (knownProvenance && knownProvenance !== symbol.provenance) {
      throw new Error(`contradictory symbol URI provenance: ${path}`);
    }
    uriProvenance.set(path, symbol.provenance);
    const normalized = {
      uri: pathToFileURL(path).href,
      symbolId: symbol.symbolId,
      range: copyRange(symbol.range),
      selectionRange: copyRange(symbol.selectionRange),
      provenance: symbol.provenance,
      declarationOnly: symbol.declarationOnly,
      traitDeclaration: symbol.traitDeclaration,
      path,
    };
    const key = JSON.stringify([path, symbol.symbolId, normalized.range, normalized.selectionRange]);
    const prior = inventory.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(normalized)) {
      throw new Error(`contradictory symbol provenance: ${key}`);
    }
    inventory.set(key, normalized);
  }
  return [...inventory.values()];
}

function classifyObservation(
  observation: RustOracleObservation,
  inventory: RustOracleInventorySymbol[],
  workspaceRoot: string,
  roots: string[],
): RustOracleSiteEvidence {
  const reasons = new Set<string>();
  const targets = new Map<string, RustOracleTarget>();
  const { site, response } = observation;
  if (site.provenance !== "source") reasons.add(site.provenance);
  if (site.dispatch === "trait") reasons.add("traitUncertainty");
  if (!observation.complete) reasons.add("incompleteDefinitions");
  if (response.kind !== "success") {
    reasons.add(response.kind);
  } else {
    const values = response.value === null ? [] : Array.isArray(response.value) ? response.value : [response.value];
    if (!values.length) reasons.add("noDefinition");
    for (const value of values) {
      const location = normalizeLocation(value, site.tokenRange);
      if (!location) {
        reasons.add("invalidResponse");
        continue;
      }
      // Selection overlap alone is insufficient: a hit must fit inside one
      // independent selection range, or equal its full declaration range.
      const candidates = inventory.filter(
        (symbol) =>
          symbol.path === location.path &&
          (containsRange(symbol.selectionRange, location.selectionRange) ||
            equalRange(symbol.range, location.selectionRange)),
      );
      const fileProvenance = inventory.find((entry) => entry.path === location.path)?.provenance;
      if (fileProvenance && fileProvenance !== "source") reasons.add(fileProvenance);
      const inProject = roots.some((root) => containsPath(root, location.path));
      if (candidates.length > 1) reasons.add("ambiguousTarget");
      const symbol = candidates.length === 1 ? candidates[0] : undefined;
      if (inProject && !candidates.length) reasons.add("unmappedTarget");
      if (symbol?.provenance && symbol.provenance !== "source") reasons.add(symbol.provenance);
      if (symbol?.declarationOnly) reasons.add("declarationOnly");
      if (symbol?.traitDeclaration) reasons.add("traitUncertainty");
      const target: RustOracleTarget = {
        uri: pathToFileURL(location.path).href,
        relPath: containsPath(workspaceRoot, location.path)
          ? relative(workspaceRoot, location.path).split(sep).join("/")
          : null,
        selectionRange: symbol?.selectionRange ?? location.selectionRange,
        symbolId: symbol?.symbolId ?? null,
        provenance: symbol?.provenance ?? fileProvenance ?? null,
        declarationOnly: symbol?.declarationOnly ?? null,
        traitDeclaration: symbol?.traitDeclaration ?? null,
      };
      targets.set(JSON.stringify(target), target);
    }
  }
  const sortedTargets = [...targets.values()].sort(
    (a, b) =>
      compareText(a.uri, b.uri) ||
      comparePosition(a.selectionRange.start, b.selectionRange.start) ||
      comparePosition(a.selectionRange.end, b.selectionRange.end) ||
      compareText(a.symbolId ?? "", b.symbolId ?? ""),
  );
  const origins = new Set(
    sortedTargets.map((target) =>
      roots.some((root) => containsPath(root, fileURLToPath(target.uri))) ? "inProject" : "external",
    ),
  );
  if (origins.size > 1) reasons.add("mixedOrigins");
  const complete = reasons.size === 0 && sortedTargets.length > 0;
  return {
    site: {
      relPath: site.relPath,
      expressionRange: copyRange(site.expressionRange),
      tokenRange: copyRange(site.tokenRange),
      provenance: site.provenance,
      dispatch: site.dispatch,
    },
    kind: complete ? (origins.has("inProject") ? "inProject" : "external") : "unknown",
    complete,
    reasons: [...reasons].sort(),
    targets: sortedTargets,
  };
}

function normalizeLocation(
  value: unknown,
  tokenRange: RustOracleRange,
): { path: string; selectionRange: RustOracleRange } | null {
  if (!value || typeof value !== "object") return null;
  const location = value as Record<string, unknown>;
  const link = "targetUri" in location;
  const path = canonicalFileUri(link ? location.targetUri : location.uri);
  const selectionRange = link ? location.targetSelectionRange : location.range;
  if (!path || !validRange(selectionRange)) return null;
  if (
    link &&
    (!validRange(location.targetRange) ||
      !containsRange(location.targetRange, selectionRange) ||
      (location.originSelectionRange !== undefined &&
        (!validRange(location.originSelectionRange) || !containsRange(location.originSelectionRange, tokenRange))))
  ) {
    return null;
  }
  return { path, selectionRange: copyRange(selectionRange) };
}

function canonicalFileUri(value: unknown): string | null {
  if (typeof value !== "string" || !/^file:\/\//i.test(value)) return null;
  try {
    // URL() normalizes dot segments. Reject them BEFORE parsing so malformed
    // evidence cannot escape a root and acquire a false external verdict.
    const decoded = decodeURIComponent(value);
    if (
      decoded.includes("\\") ||
      decoded.includes(String.fromCharCode(0)) ||
      decoded.split("/").some((part) => part === "." || part === "..") ||
      /%2f|%5c/i.test(value)
    ) {
      return null;
    }
    const uri = new URL(value);
    if (uri.protocol !== "file:" || uri.search || uri.hash || (uri.hostname && uri.hostname !== "localhost")) {
      return null;
    }
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function canonicalRoot(root: string): string {
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    root.includes(String.fromCharCode(0)) ||
    root.split(/[\\/]/).some((part) => part === "." || part === "..")
  ) {
    throw new Error("invalid root in provenance");
  }
  return resolve(root);
}

function containsPath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function validProvenance(value: unknown): value is RustOracleSourceProvenance {
  return value === "source" || value === "generated" || value === "inactiveCfg";
}

function validRange(value: unknown): value is RustOracleRange {
  if (!value || typeof value !== "object") return false;
  const { start, end } = value as RustOracleRange;
  return (
    [start, end].every(
      (position) =>
        position &&
        Number.isSafeInteger(position.line) &&
        position.line >= 0 &&
        Number.isSafeInteger(position.character) &&
        position.character >= 0,
    ) && comparePosition(start, end) <= 0
  );
}

function containsRange(outer: RustOracleRange, inner: RustOracleRange): boolean {
  return (
    comparePosition(outer.start, inner.start) <= 0 &&
    comparePosition(inner.end, outer.end) <= 0 &&
    (comparePosition(inner.start, inner.end) !== 0 || comparePosition(inner.start, outer.end) < 0)
  );
}

function equalRange(a: RustOracleRange, b: RustOracleRange): boolean {
  return comparePosition(a.start, b.start) === 0 && comparePosition(a.end, b.end) === 0;
}

function copyRange(range: RustOracleRange): RustOracleRange {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

function comparePosition(a: RustOracleRange["start"], b: RustOracleRange["start"]): number {
  return a.line - b.line || a.character - b.character;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
