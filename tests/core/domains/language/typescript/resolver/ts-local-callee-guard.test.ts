import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  TSImportNarrowedFallbackSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };
const cfg: ResolverConfig = { tsOptions, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * One project symbol per colliding short name — the cardinality that makes
 * `globalShortName` confident under strict mode. Each entry is the real target
 * the taxdome oracle run recorded a fabricated edge to (bd tea-rags-mcp-5tatv):
 * an unrelated `Tooltip#onRemove`, a `TableFilters/helpers/setDate` helper, a
 * Quill attributor's `remove`, a mention module's `onSelect`.
 */
const collidingTable = (): InMemoryGlobalSymbolTable => {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("src/tooltip.ts", [sym("Tooltip#onRemove", "onRemove", "src/tooltip.ts", ["Tooltip"])]);
  table.upsertFile("src/table-filters/helpers/set-date.ts", [
    sym("setDate", "setDate", "src/table-filters/helpers/set-date.ts", []),
  ]);
  table.upsertFile("src/attributor.ts", [
    sym("FontFamilyAttributor#remove", "remove", "src/attributor.ts", ["FontFamilyAttributor"]),
  ]);
  table.upsertFile("src/mention-module.ts", [
    sym("MentionModule#onSelect", "onSelect", "src/mention-module.ts", ["MentionModule"]),
  ]);
  table.upsertFile("src/format.ts", [sym("formatDate", "formatDate", "src/format.ts", [])]);
  return table;
};

const ctx = (callerFile: string, over: Partial<CallContext> = {}): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable: collidingTable(),
  ...over,
});

/**
 * The hook module every React-shaped fixture below destructures from. Stands in
 * for `@types/react` / `react-hook-form` without pulling either into the test
 * tree — what matters is the SHAPE of the binding, not who declared the hook.
 */
function writeHooksFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/hooks.ts",
    [
      `export function useState<T>(initial: T): [T, (next: T) => void] {`,
      `  let current = initial;`,
      `  const set = (next: T): void => {`,
      `    current = next;`,
      `  };`,
      `  return [current, set];`,
      `}`,
      ``,
      `export function useFieldArray(): { remove: (index: number) => void } {`,
      `  return { remove: () => undefined };`,
      `}`,
      ``,
    ].join("\n"),
  );
}

/**
 * `components/Attachments/AttachmentRow.tsx` — a destructured COMPONENT PROP
 * called bare. The oracle recorded `onRemove(attachment)` fabricating an edge to
 * `WysiwygEditor/Themes/FloatingSnowTheme/Tooltip.ts#onRemove`.
 */
function writeDestructuredPropFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/attachment-row.ts",
    [
      `export interface Attachment {`,
      `  id: string;`,
      `}`,
      ``,
      `export interface AttachmentRowProps {`,
      `  attachment: Attachment;`,
      `  onRemove: (attachment: Attachment) => void;`,
      `}`,
      ``,
      `export function AttachmentRow({ attachment, onRemove }: AttachmentRowProps): void {`,
      `  onRemove(attachment);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const DESTRUCTURED_PROP_CALL: CallRef = {
  callText: "onRemove(attachment)",
  receiver: null,
  member: "onRemove",
  startLine: 11,
};

/**
 * `components/TableFilters/DateFilter.tsx` — a `useState` setter. The oracle
 * recorded `setDate(date)` fabricating an edge to the unrelated helper module
 * `TableFilters/helpers/setDate.ts`.
 */
function writeHookArrayBindingFixture(repoRoot: string): void {
  writeHooksFixture(repoRoot);
  writeSource(
    repoRoot,
    "src/date-filter.ts",
    [
      `import { useState } from "./hooks.js";`,
      ``,
      `export function DateFilter(next: Date): void {`,
      `  const [date, setDate] = useState(new Date());`,
      `  void date;`,
      `  setDate(next);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const HOOK_ARRAY_BINDING_CALL: CallRef = {
  callText: "setDate(next)",
  receiver: null,
  member: "setDate",
  startLine: 6,
};

/**
 * `components/ClientStage.tsx` — a `useFieldArray` handler destructured out of
 * the hook's returned object, the object-pattern twin of the array case.
 */
function writeHookObjectBindingFixture(repoRoot: string): void {
  writeHooksFixture(repoRoot);
  writeSource(
    repoRoot,
    "src/client-stage.ts",
    [
      `import { useFieldArray } from "./hooks.js";`,
      ``,
      `export function ClientStage(index: number): void {`,
      `  const { remove } = useFieldArray();`,
      `  remove(index);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const HOOK_OBJECT_BINDING_CALL: CallRef = {
  callText: "remove(index)",
  receiver: null,
  member: "remove",
  startLine: 5,
};

/**
 * The same defect without any destructuring: a callback passed as an ordinary
 * typed PARAMETER and invoked bare. `onSelect(...)` fabricated an edge to
 * `WysiwygEditor/modules/MentionModule.ts#onSelect` on two call sites.
 */
function writeParameterCallbackFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/mention-list.ts",
    [
      `export function MentionList(onSelect: (id: string) => void, id: string): void {`,
      `  onSelect(id);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PARAMETER_CALLBACK_CALL: CallRef = {
  callText: "onSelect(id)",
  receiver: null,
  member: "onSelect",
  startLine: 2,
};

/**
 * The recall guard: a bare call to an IMPORTED PROJECT FUNCTION. Same syntactic
 * shape — no receiver, a short name the table knows — and the single most common
 * way real TypeScript reaches another module. Nothing here may be declined.
 */
function writeImportedFunctionFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/format.ts",
    [`export function formatDate(value: Date): string {`, `  return value.toISOString();`, `}`, ``].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/report.ts",
    [
      `import { formatDate } from "./format.js";`,
      ``,
      `export function report(value: Date): string {`,
      `  return formatDate(value);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const IMPORTED_FUNCTION_CALL: CallRef = {
  callText: "formatDate(value)",
  receiver: null,
  member: "formatDate",
  startLine: 4,
};

const IMPORTED_FUNCTION_CTX = (): CallContext =>
  ctx("src/report.ts", { imports: [{ importText: "./format.js", startLine: 1, importedNames: ["formatDate"] }] });

/**
 * bd tea-rags-mcp-5tatv — a bare call whose callee is a LOCAL VALUE BINDING.
 *
 * `globalShortName` keys on the member name alone, and for a free call the
 * member IS the callee identifier. A destructured component prop, a hook's
 * returned setter, a callback parameter — each is a value handed in at runtime,
 * so no project symbol of that name is its target, yet every one of them reached
 * pass 9 with nothing in the chain able to say so: the walker records no
 * `localBindings` entry for a destructuring pattern, pass 4 bails on a null
 * receiver, and the external guard's receiver arms all return early when there
 * is no receiver to inspect.
 *
 * React makes this the dominant call shape rather than a corner case — props
 * destructuring and hook returns are the idiom — which is why the defect never
 * surfaced on this repo's own JSX-free corpus.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — local-callee guard (bd tea-rags-mcp-5tatv)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const strategy = (): TSGlobalShortNameSymbolResolutionStrategy =>
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, new TSProgramCache({ repoRoot, tsOptions }));

  it("continues for a destructured component prop (AttachmentRow onRemove(attachment))", () => {
    writeDestructuredPropFixture(repoRoot);
    expect(strategy().attempt(DESTRUCTURED_PROP_CALL, ctx("src/attachment-row.ts")).kind).toBe("continue");
  });

  it("continues for a hook's array-destructured setter (DateFilter setDate(next))", () => {
    writeHookArrayBindingFixture(repoRoot);
    expect(strategy().attempt(HOOK_ARRAY_BINDING_CALL, ctx("src/date-filter.ts")).kind).toBe("continue");
  });

  it("continues for a hook's object-destructured handler (ClientStage remove(index))", () => {
    writeHookObjectBindingFixture(repoRoot);
    expect(strategy().attempt(HOOK_OBJECT_BINDING_CALL, ctx("src/client-stage.ts")).kind).toBe("continue");
  });

  it("continues for a callback passed as an ordinary parameter (MentionList onSelect(id))", () => {
    writeParameterCallbackFixture(repoRoot);
    expect(strategy().attempt(PARAMETER_CALLBACK_CALL, ctx("src/mention-list.ts")).kind).toBe("continue");
  });

  it("STILL resolves a bare call to an imported project function (report formatDate(value))", () => {
    writeImportedFunctionFixture(repoRoot);
    expect(strategy().attempt(IMPORTED_FUNCTION_CALL, IMPORTED_FUNCTION_CTX())).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/format.ts", targetSymbolId: "formatDate" },
    });
  });

  it("STILL resolves when no Program can be built for the caller file (nothing on disk)", () => {
    expect(strategy().attempt(DESTRUCTURED_PROP_CALL, ctx("src/attachment-row.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/tooltip.ts", targetSymbolId: "Tooltip#onRemove" },
    });
  });

  it("STILL resolves when the recorded line holds no such call — a node it cannot locate decides nothing", () => {
    writeDestructuredPropFixture(repoRoot);
    const call: CallRef = { ...DESTRUCTURED_PROP_CALL, startLine: 3 };
    expect(strategy().attempt(call, ctx("src/attachment-row.ts"))).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/tooltip.ts", targetSymbolId: "Tooltip#onRemove" },
    });
  });

  it("behaves exactly as before when no Program cache is injected (the disabled state)", () => {
    writeDestructuredPropFixture(repoRoot);
    expect(
      new TSGlobalShortNameSymbolResolutionStrategy(cfg, null).attempt(
        DESTRUCTURED_PROP_CALL,
        ctx("src/attachment-row.ts"),
      ),
    ).toEqual({ kind: "resolved", target: { targetRelPath: "src/tooltip.ts", targetSymbolId: "Tooltip#onRemove" } });
  });
});

/**
 * bd tea-rags-mcp-5tatv — the import-narrowed sibling needs the guard for the
 * same reason it needed the external one: narrowing an ambiguous short name by
 * the caller's imports turns a guess into a committed answer.
 */
describe("TSImportNarrowedFallbackSymbolResolutionStrategy — local-callee guard (bd tea-rags-mcp-5tatv)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-narrowed-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Two project `onRemove`s, one in a file the caller imports — the narrowing shape. */
  const ambiguousTable = (): InMemoryGlobalSymbolTable => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("src/tooltip.ts", [sym("Tooltip#onRemove", "onRemove", "src/tooltip.ts", ["Tooltip"])]);
    table.upsertFile("src/other.ts", [sym("OtherPanel#onRemove", "onRemove", "src/other.ts", ["OtherPanel"])]);
    return table;
  };

  it("continues for a destructured prop rather than narrowing to the imported `onRemove`", () => {
    writeDestructuredPropFixture(repoRoot);
    writeSource(repoRoot, "src/tooltip.ts", [`export class Tooltip {}`, ``].join("\n"));

    const outcome = new TSImportNarrowedFallbackSymbolResolutionStrategy(
      cfg,
      new TSProgramCache({ repoRoot, tsOptions }),
    ).attempt(
      DESTRUCTURED_PROP_CALL,
      ctx("src/attachment-row.ts", {
        symbolTable: ambiguousTable(),
        imports: [{ importText: "./tooltip.js", startLine: 1, importedNames: ["Tooltip"] }],
      }),
    );

    expect(outcome.kind).toBe("continue");
  });
});

/**
 * bd tea-rags-mcp-5tatv — the same decision through the whole chain.
 *
 * The classifier half is asserted NEGATIVE on purpose. A prop callback is not an
 * external call: the function the parent passes is very often project code, so
 * the honest bucket is an internal miss. Declining the fabricated edge and
 * counting the call external would trade a precision fix for an inflated
 * `resolveSuccessRate`.
 */
describe("TSCallResolver — local-callee guard end to end (bd tea-rags-mcp-5tatv)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-e2e-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("emits no edge for a destructured prop called bare (onRemove(attachment))", () => {
    writeDestructuredPropFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(DESTRUCTURED_PROP_CALL, ctx("src/attachment-row.ts"))).toBeNull();
  });

  it("emits no edge for a hook-returned setter called bare (setDate(next))", () => {
    writeHookArrayBindingFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(HOOK_ARRAY_BINDING_CALL, ctx("src/date-filter.ts"))).toBeNull();
  });

  it("keeps that call in the internal denominator — a local callee is a miss, not an external call", () => {
    writeDestructuredPropFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.targetsExternalImport(DESTRUCTURED_PROP_CALL, ctx("src/attachment-row.ts"))).toBe(false);
  });

  it("STILL emits the real edge for a bare call to an imported project function", () => {
    writeImportedFunctionFixture(repoRoot);
    const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
    expect(resolver.resolve(IMPORTED_FUNCTION_CALL, IMPORTED_FUNCTION_CTX())).toEqual({
      targetRelPath: "src/format.ts",
      targetSymbolId: "formatDate",
    });
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 keeps the chain exactly as it was — no checker involvement", () => {
    writeDestructuredPropFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const resolver = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(resolver.programCache).toBeNull();
      expect(resolver.resolve(DESTRUCTURED_PROP_CALL, ctx("src/attachment-row.ts"))).toEqual({
        targetRelPath: "src/tooltip.ts",
        targetSymbolId: "Tooltip#onRemove",
      });
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});
