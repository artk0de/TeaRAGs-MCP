/**
 * Residual call-site rows (codegraph residual resolution, wave 1): which call
 * sites the static resolve leaves for a model, and the menu each one carries.
 * Fed one verdict at a time by `CallEdgeResolutionRunner#resolveCallSites`.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";

import type {
  ResidualCallSiteRow,
  ResidualExclusionRule,
  ResidualKind,
} from "../../../../contracts/types/codegraph-residual.js";
import type { CallRef, GlobalSymbolTable, RelPath } from "../../../../contracts/types/codegraph.js";
import type { ReceiverKind } from "../symbols/receiver-kind.js";

/** Menu size the wave-1 eval measured; `CODEGRAPH_RESIDUAL_MENU_LIMIT` overrides it. */
export const DEFAULT_RESIDUAL_MENU_LIMIT = 40;

/** Receivers with no type evidence: an unbound name or method result, an ivar, a call chain. */
const DYNAMIC_RECEIVER_KINDS: ReadonlySet<ReceiverKind> = new Set<ReceiverKind>(["dynamic", "ivar", "chain"]);

/** The part of a `CallSiteVerdict` the residual decision reads. */
export interface ResidualVerdictView {
  receiverKind: ReceiverKind;
  outcome: "resolved" | "unresolved" | "ambiguous";
  missBucket?: string;
}

/** The enclosing method of a call site — a `ChunkExtraction` fits it. */
export interface ResidualMethodView {
  symbolId: string;
  startLine?: number;
  endLine?: number;
}

export interface ResidualSiteKeyParts {
  relPath: string;
  methodSymbolId: string;
  line: number;
  column: number;
  receiverText: string;
  member: string;
}

export function residualKindOf(verdict: ResidualVerdictView): ResidualKind | null {
  if (verdict.outcome === "ambiguous") return "ambiguous";
  if (verdict.outcome !== "unresolved" || verdict.missBucket !== "missWithInProjectDef") {
    return null;
  }
  return DYNAMIC_RECEIVER_KINDS.has(verdict.receiverKind) ? "dynamic" : null;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function residualSiteKey(parts: ResidualSiteKeyParts): string {
  return sha1(
    [
      parts.relPath,
      parts.methodSymbolId,
      String(parts.line),
      String(parts.column),
      parts.receiverText,
      parts.member,
    ].join("\u0000"),
  );
}

/** `candidates` must already be sorted — the row stores them sorted. */
export function residualMenuHash(candidates: readonly string[]): string {
  return sha1(candidates.join("\n"));
}

/** Residual sites a language kept out of the rows, per rule. */
export type ResidualExclusionCounts = Record<ResidualExclusionRule, number>;

export function emptyResidualExclusionCounts(): ResidualExclusionCounts {
  return { schemaColumn: 0, frameworkMember: 0 };
}

export function addResidualExclusionCounts(
  counts: ResidualExclusionCounts,
  excluded: Readonly<ResidualExclusionCounts>,
): void {
  counts.schemaColumn += excluded.schemaColumn;
  counts.frameworkMember += excluded.frameworkMember;
}

export class ResidualSiteCollector {
  private readonly collected: ResidualCallSiteRow[] = [];
  private readonly excludedCounts = emptyResidualExclusionCounts();
  private readonly menus = new Map<string, string[]>();
  private readonly extension: string;

  constructor(
    private readonly sourceRelPath: RelPath,
    private readonly symbolTable: Pick<GlobalSymbolTable, "lookupByShortName">,
    private readonly menuLimit: number,
  ) {
    this.extension = extname(sourceRelPath);
  }

  /** `exclude` is asked only for a residual site with a non-empty menu; a rule drops the site. */
  observe(
    method: ResidualMethodView,
    call: CallRef,
    verdict: ResidualVerdictView,
    exclude?: () => ResidualExclusionRule | null,
  ): void {
    const kind = residualKindOf(verdict);
    if (kind === null) return;
    const menu = this.menuFor(call.member);
    if (menu.length === 0) return;
    const rule = exclude?.() ?? null;
    if (rule !== null) {
      this.excludedCounts[rule] += 1;
      return;
    }
    const menuOverflow = menu.length > this.menuLimit;
    const candidates = menuOverflow ? menu.slice(0, this.menuLimit) : menu;
    const line = call.startLine;
    const column = call.startColumn ?? 0;
    const receiverText = call.receiver ?? "";
    this.collected.push({
      siteKey: residualSiteKey({
        relPath: this.sourceRelPath,
        methodSymbolId: method.symbolId,
        line,
        column,
        receiverText,
        member: call.member,
      }),
      sourceRelPath: this.sourceRelPath,
      methodSymbolId: method.symbolId,
      methodStartLine: method.startLine ?? line,
      methodEndLine: method.endLine ?? line,
      line,
      column,
      receiverText,
      member: call.member,
      kind,
      candidates,
      menuHash: residualMenuHash(candidates),
      menuOverflow,
    });
  }

  rows(): ResidualCallSiteRow[] {
    return this.collected;
  }

  excluded(): Readonly<ResidualExclusionCounts> {
    return this.excludedCounts;
  }

  /** Same-language method ids named `member`, deduplicated and sorted; cached per member. */
  private menuFor(member: string): string[] {
    const cached = this.menus.get(member);
    if (cached !== undefined) return cached;
    const ids = new Set<string>();
    for (const def of this.symbolTable.lookupByShortName(member)) {
      if (extname(def.relPath) !== this.extension) continue;
      if (!def.symbolId.endsWith(`#${member}`) && !def.symbolId.endsWith(`.${member}`)) {
        continue;
      }
      ids.add(def.symbolId);
    }
    const menu = [...ids].sort();
    this.menus.set(member, menu);
    return menu;
  }
}
