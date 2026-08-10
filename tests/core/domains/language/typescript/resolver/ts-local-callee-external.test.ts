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
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, content: string): void {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/**
 * A dependency, declared where a dependency actually lives. The whole question
 * this bead asks is answered by the DECLARATION FILE of the callee's call
 * signatures, and `TSProgramCache.isProjectSourceFile` draws that line at the
 * `node_modules` segment — so a fixture that writes the hook into `src/` cannot
 * exercise the behaviour at all, no matter how React-shaped its contents.
 */
function writePackage(repoRoot: string, name: string, declarations: string[]): void {
  writeSource(
    repoRoot,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0", types: "index.d.ts" }),
  );
  writeSource(repoRoot, `node_modules/${name}/index.d.ts`, declarations.join("\n"));
}

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/**
 * Deliberately mixed. `setDate` and `onRemove` collide with a project symbol —
 * the shape bd tea-rags-mcp-5tatv declined an edge for — while `t`, `bump` and
 * `onPick` are names this project declares nothing by. The external verdict must
 * not depend on which side of that line a callee falls: the symbol table is a
 * COST gate on the precision guard, and a hook-returned `t()` is exactly the
 * call that leaves the project without ever colliding with anything.
 */
const table = (): InMemoryGlobalSymbolTable => {
  const built = new InMemoryGlobalSymbolTable();
  built.upsertFile("src/table-filters/helpers/set-date.ts", [
    sym("setDate", "setDate", "src/table-filters/helpers/set-date.ts", []),
  ]);
  built.upsertFile("src/tooltip.ts", [sym("Tooltip#onRemove", "onRemove", "src/tooltip.ts", ["Tooltip"])]);
  built.upsertFile("src/format.ts", [sym("formatDate", "formatDate", "src/format.ts", [])]);
  return built;
};

const ctx = (callerFile: string, over: Partial<CallContext> = {}): CallContext => ({
  callerFile,
  callerScope: [],
  imports: [],
  symbolTable: table(),
  ...over,
});

/**
 * `components/TableFilters/DateFilter.tsx` — a `useState` setter, the single
 * most common bare call in a React codebase. `Dispatch<SetStateAction<S>>` is
 * declared by `@types/react`, so the value behind `setDate` provably never
 * reaches project code.
 */
function writeHookSetterFixture(repoRoot: string): void {
  writePackage(repoRoot, "react", [
    `export type Dispatch<A> = (value: A) => void;`,
    `export type SetStateAction<S> = S | ((prev: S) => S);`,
    `export declare function useState<S>(initial: S): [S, Dispatch<SetStateAction<S>>];`,
    ``,
  ]);
  writeSource(
    repoRoot,
    "src/date-filter.ts",
    [
      `import { useState } from "react";`,
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

const HOOK_SETTER_CALL: CallRef = {
  callText: "setDate(next)",
  receiver: null,
  member: "setDate",
  startLine: 6,
};

/**
 * `components/Greeting.tsx` — the i18n `t()` shape, destructured out of a hook's
 * returned OBJECT rather than its array. Nothing in the project is named `t`, so
 * this call never collided with anything; it simply sat in the internal
 * denominator as a miss the resolver could never have won.
 */
function writeTranslationFixture(repoRoot: string): void {
  writePackage(repoRoot, "i18n", [`export declare function useTranslation(): { t: (key: string) => string };`, ``]);
  writeSource(
    repoRoot,
    "src/greeting.ts",
    [
      `import { useTranslation } from "i18n";`,
      ``,
      `export function Greeting(): string {`,
      `  const { t } = useTranslation();`,
      `  return t("hello");`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const TRANSLATION_CALL: CallRef = {
  callText: 't("hello")',
  receiver: null,
  member: "t",
  startLine: 5,
};

/**
 * `components/Attachments/AttachmentRow.tsx` — the boundary this bead is most at
 * risk of getting wrong. A destructured prop is a local value binding just like
 * a hook return, but the function the parent passes is USUALLY project code we
 * cannot pin without dataflow, and the props interface says so: its signature is
 * declared right here in the project.
 */
function writeProjectPropFixture(repoRoot: string): void {
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

const PROJECT_PROP_CALL: CallRef = {
  callText: "onRemove(attachment)",
  receiver: null,
  member: "onRemove",
  startLine: 11,
};

/** A prop with no annotation at all — the checker has no signature to read. */
function writeUntypedPropFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/untyped-row.ts",
    [`export function UntypedRow({ onPick }) {`, `  onPick();`, `}`, ``].join("\n"),
  );
}

const UNTYPED_PROP_CALL: CallRef = {
  callText: "onPick()",
  receiver: null,
  member: "onPick",
  startLine: 2,
};

/** A hook the PROJECT declares — same binding shape, in-project signature. */
function writeProjectHookFixture(repoRoot: string): void {
  writeSource(
    repoRoot,
    "src/hooks.ts",
    [
      `export function useCounter(): { bump: (n: number) => void } {`,
      `  return { bump: () => undefined };`,
      `}`,
      ``,
    ].join("\n"),
  );
  writeSource(
    repoRoot,
    "src/counter.ts",
    [
      `import { useCounter } from "./hooks.js";`,
      ``,
      `export function Counter(n: number): void {`,
      `  const { bump } = useCounter();`,
      `  bump(n);`,
      `}`,
      ``,
    ].join("\n"),
  );
}

const PROJECT_HOOK_CALL: CallRef = {
  callText: "bump(n)",
  receiver: null,
  member: "bump",
  startLine: 5,
};

/** The recall guard: a bare call to an imported project function. */
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
 * bd tea-rags-mcp-qdjfu — a local value binding whose CALL SIGNATURES are all
 * declared outside the project.
 *
 * bd tea-rags-mcp-5tatv stopped these calls fabricating edges and deliberately
 * left them in the internal `resolveSuccessRate` denominator, because a prop
 * callback usually IS project code. That reasoning does not survive contact with
 * a hook RETURN: a `useState` setter, a `useFieldArray` handler, `t()`,
 * `navigate()` are declared in `node_modules` and provably never reach project
 * code, so counting them as internal misses penalises the resolver for calls it
 * could never have resolved.
 *
 * The two halves are asserted together on purpose — the verdict is only correct
 * if it moves the hook returns OUT of the denominator and leaves the prop
 * callbacks IN it.
 */
describe("TSCallResolver — externally-signatured local callee (bd tea-rags-mcp-qdjfu)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-external-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const resolver = (): TSCallResolver => new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

  it("classifies a hook's array-destructured setter as external (DateFilter setDate(next))", () => {
    writeHookSetterFixture(repoRoot);
    expect(resolver().targetsExternalImport(HOOK_SETTER_CALL, ctx("src/date-filter.ts"))).toBe(true);
  });

  it('classifies a hook\'s object-destructured handler as external (Greeting t("hello"))', () => {
    writeTranslationFixture(repoRoot);
    expect(resolver().targetsExternalImport(TRANSLATION_CALL, ctx("src/greeting.ts"))).toBe(true);
  });

  it("keeps a prop callback typed by a PROJECT interface an internal miss (AttachmentRow onRemove)", () => {
    writeProjectPropFixture(repoRoot);
    expect(resolver().targetsExternalImport(PROJECT_PROP_CALL, ctx("src/attachment-row.ts"))).toBe(false);
  });

  it("keeps an UNTYPED prop callback an internal miss — no signature is no evidence", () => {
    writeUntypedPropFixture(repoRoot);
    expect(resolver().targetsExternalImport(UNTYPED_PROP_CALL, ctx("src/untyped-row.ts"))).toBe(false);
  });

  it("keeps a binding returned by a PROJECT hook an internal miss (Counter bump(n))", () => {
    writeProjectHookFixture(repoRoot);
    expect(resolver().targetsExternalImport(PROJECT_HOOK_CALL, ctx("src/counter.ts"))).toBe(false);
  });

  it("leaves a bare call to an imported project function internal (report formatDate(value))", () => {
    writeImportedFunctionFixture(repoRoot);
    expect(resolver().targetsExternalImport(IMPORTED_FUNCTION_CALL, IMPORTED_FUNCTION_CTX())).toBe(false);
  });

  it("stays silent with no Program to read (nothing on disk)", () => {
    expect(resolver().targetsExternalImport(HOOK_SETTER_CALL, ctx("src/date-filter.ts"))).toBe(false);
  });

  it("CODEGRAPH_TS_TYPECHECKER=0 classifies nothing — the verdict is checker-only", () => {
    writeHookSetterFixture(repoRoot);
    const previous = process.env.CODEGRAPH_TS_TYPECHECKER;
    process.env.CODEGRAPH_TS_TYPECHECKER = "0";
    try {
      const disabled = new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);
      expect(disabled.programCache).toBeNull();
      expect(disabled.targetsExternalImport(HOOK_SETTER_CALL, ctx("src/date-filter.ts"))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEGRAPH_TS_TYPECHECKER;
      else process.env.CODEGRAPH_TS_TYPECHECKER = previous;
    }
  });
});

/**
 * bd tea-rags-mcp-qdjfu — this is a RECLASSIFICATION, not a resolution
 * mechanism. Every call it moves is one the chain had already declined, so the
 * edges the resolver emits must be byte-identical before and after: what changes
 * is only which denominator the miss is counted against.
 */
describe("TSCallResolver — reclassification emits no new edges (bd tea-rags-mcp-qdjfu)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-local-callee-external-edges-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const resolver = (): TSCallResolver => new TSCallResolver(tsOptions, DEFAULT_AMBIGUOUS_RESOLVE_MODE, repoRoot);

  it("still emits no edge for the reclassified hook setter (setDate collides with a project helper)", () => {
    writeHookSetterFixture(repoRoot);
    expect(resolver().resolve(HOOK_SETTER_CALL, ctx("src/date-filter.ts"))).toBeNull();
  });

  it("still emits no edge for the prop callback that stays an internal miss", () => {
    writeProjectPropFixture(repoRoot);
    expect(resolver().resolve(PROJECT_PROP_CALL, ctx("src/attachment-row.ts"))).toBeNull();
  });

  it("still emits the real edge for a bare call to an imported project function", () => {
    writeImportedFunctionFixture(repoRoot);
    expect(resolver().resolve(IMPORTED_FUNCTION_CALL, IMPORTED_FUNCTION_CTX())).toEqual({
      targetRelPath: "src/format.ts",
      targetSymbolId: "formatDate",
    });
  });
});
