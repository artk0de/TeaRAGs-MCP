/**
 * Residual call-site rows (codegraph residual resolution, wave 1): which call
 * sites the static resolve leaves for a model, and the menu each one carries.
 * Fed one verdict at a time by `CallEdgeResolutionRunner#resolveCallSites`.
 */
import { createHash } from "node:crypto";
import { extname } from "node:path";

import type {
  ResidualCallSiteRow,
  ResidualClassTarget,
  ResidualExclusionRule,
  ResidualKind,
  ResidualReason,
} from "../../../../contracts/types/codegraph-residual.js";
import type {
  CallRef,
  GlobalSymbolTable,
  GraphEdges,
  HierarchyView,
  RelPath,
} from "../../../../contracts/types/codegraph.js";
import type { ReceiverKind } from "../symbols/receiver-kind.js";
import {
  orderByNamingPrior,
  orderClassesByNamingPrior,
  ReceiverClassClosure,
  receiverGroupKey,
} from "./receiver-closure.js";

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
  /** Lines assigning each local / ivar in the method, so a reassigned receiver splits in two. */
  localAssignmentLines?: Readonly<Record<string, readonly number[]>>;
}

/** Turns receiver narrowing on: the closure reads the run's class hierarchy when there is one. */
export interface ResidualNarrowingOptions {
  hierarchy?: HierarchyView;
}

/** A residual site its receiver's constraint set settled to one target: a static edge, no question. */
export interface NarrowedResidualSite {
  receiverKind: ReceiverKind;
  edge: GraphEdges["methodEdges"][number];
}

/**
 * Misses that say nothing about the receiver's class: the classifier put the
 * callee outside the project, or out of static reach. Such a call never
 * constrains its receiver.
 */
const NON_CONSTRAINING_BUCKETS: ReadonlySet<string> = new Set(["externalSkipped", "coreAmbiguous", "unresolvable"]);

/** Receivers that name the enclosing object: their class is the caller's, never a narrowing question. */
const SELF_RECEIVERS: ReadonlySet<string> = new Set(["", "self", "this", "super"]);

interface PendingResidualSite {
  method: ResidualMethodView;
  call: CallRef;
  verdict: ResidualVerdictView;
  kind: ResidualKind;
  groupKey: string;
  /** The `frameworkOverride` menu (sorted overrides); narrowing may only shrink it. */
  overrideMenu?: readonly string[];
  returnTypeOf?: ResidualReturnTypeOf;
}

/** The class `owner#member` returns on an `owner` instance, or `undefined` when no fact says. */
export type ResidualReturnTypeOf = (owner: string, member: string) => string | undefined;

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

/** `candidates` in the row's menu order — sorted, or by naming prior once narrowed. */
export function residualMenuHash(candidates: readonly string[]): string {
  return sha1(candidates.join("\n"));
}

/** Residual sites a language kept out of the rows, per rule. */
export type ResidualExclusionCounts = Record<ResidualExclusionRule, number>;

export function emptyResidualExclusionCounts(): ResidualExclusionCounts {
  return { schemaColumn: 0, frameworkMember: 0, timestampColumn: 0 };
}

export function addResidualExclusionCounts(
  counts: ResidualExclusionCounts,
  excluded: Readonly<ResidualExclusionCounts>,
): void {
  counts.schemaColumn += excluded.schemaColumn;
  counts.frameworkMember += excluded.frameworkMember;
  counts.timestampColumn += excluded.timestampColumn;
}

/**
 * The group's classes in naming-prior order, each with the method target the
 * member reaches on it; a class reaching the member only as a schema column has
 * no method to edge to and is left out. A tie of definers at one depth takes the
 * smallest symbolId. With `allowed` (a `frameworkOverride` site's override
 * menu) a class whose target is not a reachable override is left out too. A
 * class whose member's return `returnTypeOf` knows carries it third.
 */
function classTargetsOf(
  receiverText: string,
  member: string,
  classes: ReadonlySet<string>,
  own: ReadonlyMap<string, readonly { symbolId: string; isSchemaColumn?: boolean }[]>,
  allowed?: ReadonlySet<string>,
  returnTypeOf?: ResidualReturnTypeOf,
): ResidualClassTarget[] {
  const targets = new Map<string, string>();
  for (const owner of classes) {
    const ids = (own.get(owner) ?? [])
      .filter((d) => d.isSchemaColumn !== true && (allowed === undefined || allowed.has(d.symbolId)))
      .map((d) => d.symbolId)
      .sort();
    if (ids.length > 0) targets.set(owner, ids[0]);
  }
  return orderClassesByNamingPrior(receiverText, [...targets.keys()]).map((owner): ResidualClassTarget => {
    const returnType = returnTypeOf?.(owner, member);
    const target = targets.get(owner) as string;
    return returnType === undefined ? [owner, target] : [owner, target, returnType];
  });
}

/** The receiver group of the hop whose receiver is this call — `record.firm(x)` for `record.firm(x).name`. */
function downstreamGroupOf(site: PendingResidualSite): string {
  return sha1(
    receiverGroupKey(site.method.symbolId, site.call.callText, site.call.startLine, site.method.localAssignmentLines),
  );
}

export class ResidualSiteCollector {
  private readonly collected: ResidualCallSiteRow[] = [];
  private readonly excludedCounts = emptyResidualExclusionCounts();
  private readonly menus = new Map<string, string[]>();
  private readonly extension: string;
  private readonly closure: ReceiverClassClosure | undefined;
  /** Receiver group → member → whether every call of it on the receiver may constrain the class. */
  private readonly groups = new Map<string, Map<string, boolean>>();
  private readonly pendingSites: PendingResidualSite[] = [];
  private readonly narrowedSites: NarrowedResidualSite[] = [];
  private readonly narrowEmpty: ReceiverKind[] = [];
  private settled = false;

  constructor(
    private readonly sourceRelPath: RelPath,
    private readonly symbolTable: Pick<GlobalSymbolTable, "lookupByShortName">,
    private readonly menuLimit: number,
    /** The `cg_run_stats` language this file's sites are counted under. */
    private readonly language: string,
    narrowing?: ResidualNarrowingOptions,
  ) {
    this.extension = extname(sourceRelPath);
    this.closure =
      narrowing === undefined ? undefined : new ReceiverClassClosure(symbolTable, this.extension, narrowing.hierarchy);
  }

  /**
   * Fed every call site of the file. `exclude` is asked only for a residual site
   * with a non-empty menu; a rule drops the site. `overrideMenu` is asked for a
   * site that stays: a non-empty answer (the project overrides of a framework
   * member the receiver reaches) replaces the menu and marks the row
   * `frameworkOverride`. With narrowing on, every call joins its receiver's
   * constraint set and residual rows are built on the first read of {@link rows};
   * narrowing only intersects an override menu, never adds to it. `returnTypeOf`
   * types each class target of a grouped row, so an accepted class can type the
   * next chain hop.
   */
  observe(
    method: ResidualMethodView,
    call: CallRef,
    verdict: ResidualVerdictView,
    exclude?: () => ResidualExclusionRule | null,
    overrideMenu?: () => readonly string[] | null,
    returnTypeOf?: ResidualReturnTypeOf,
  ): void {
    const groupKey = this.closure === undefined ? undefined : this.constrain(method, call, verdict);
    const kind = residualKindOf(verdict);
    if (kind === null) return;
    const fullMenu = this.menuFor(call.member);
    if (fullMenu.length === 0) return;
    const rule = exclude?.() ?? null;
    if (rule !== null) {
      this.excludedCounts[rule] += 1;
      // A framework member says nothing about which project class the receiver is.
      if (rule === "frameworkMember" && groupKey !== undefined) this.groups.get(groupKey)?.set(call.member, false);
      return;
    }
    const overrides = overrideMenu?.() ?? null;
    const reason: ResidualReason | undefined =
      overrides !== null && overrides.length > 0 ? "frameworkOverride" : undefined;
    const menu = reason === undefined ? fullMenu : [...new Set(overrides)].sort();
    if (groupKey === undefined) {
      this.pushRow(method, call, verdict, kind, menu, reason);
      return;
    }
    // Every project class inheriting the framework member answers it, not only the overriders.
    if (reason !== undefined) this.groups.get(groupKey)?.set(call.member, false);
    this.pendingSites.push({
      method,
      call,
      verdict,
      kind,
      groupKey,
      overrideMenu: reason === undefined ? undefined : menu,
      returnTypeOf,
    });
  }

  /** Residual sites settled to a static edge by their receiver's constraint set. */
  narrowed(): NarrowedResidualSite[] {
    this.settle();
    return this.narrowedSites;
  }

  /** Receiver kinds of residual sites whose constraint set intersected to no class (old menu kept). */
  narrowEmptyKinds(): ReceiverKind[] {
    this.settle();
    return this.narrowEmpty;
  }

  /** Record `call` against its receiver; the receiver's group key, or `undefined` for a receiverless call. */
  private constrain(method: ResidualMethodView, call: CallRef, verdict: ResidualVerdictView): string | undefined {
    if (call.receiver === null || SELF_RECEIVERS.has(call.receiver)) return undefined;
    const key = receiverGroupKey(method.symbolId, call.receiver, call.startLine, method.localAssignmentLines);
    let members = this.groups.get(key);
    if (members === undefined) {
      members = new Map();
      this.groups.set(key, members);
    }
    const constrains = verdict.missBucket === undefined || !NON_CONSTRAINING_BUCKETS.has(verdict.missBucket);
    members.set(call.member, (members.get(call.member) ?? true) && constrains);
    return key;
  }

  private settle(): void {
    if (this.settled || this.closure === undefined) return;
    this.settled = true;
    for (const site of this.pendingSites) this.narrow(site, this.closure);
  }

  /**
   * The classes answering every constraining member of the site's receiver.
   * A member no project class answers is external and constrains nothing; an
   * empty intersection keeps the single-member menu (precision first: never
   * drop the true class). A `frameworkOverride` site's menu is its override
   * menu intersected with the narrowed definitions — never more — and falls
   * back to the whole override menu when the two share nothing.
   */
  private narrow(site: PendingResidualSite, closure: ReceiverClassClosure): void {
    const own = closure.answerers(site.call.member);
    let classes = new Set(own.keys());
    for (const [member, constrains] of this.groups.get(site.groupKey) ?? []) {
      if (!constrains || member === site.call.member) continue;
      const answers = closure.answerers(member);
      if (answers.size === 0) continue;
      classes = new Set([...classes].filter((owner) => answers.has(owner)));
    }
    const overrides = site.overrideMenu === undefined ? undefined : new Set(site.overrideMenu);
    const reason: ResidualReason | undefined = overrides === undefined ? undefined : "frameworkOverride";
    const keptMenu = site.overrideMenu ?? this.menuFor(site.call.member);
    if (classes.size === 0) {
      this.narrowEmpty.push(site.verdict.receiverKind);
      this.pushRow(site.method, site.call, site.verdict, site.kind, [...keptMenu], reason);
      return;
    }
    const targets = new Map<string, { relPath: RelPath; isSchemaColumn: boolean }>();
    for (const owner of classes) {
      for (const def of own.get(owner) ?? []) {
        if (overrides !== undefined && !overrides.has(def.symbolId)) continue;
        targets.set(def.symbolId, { relPath: def.relPath, isSchemaColumn: def.isSchemaColumn === true });
      }
    }
    const methods = [...targets].filter(([, t]) => !t.isSchemaColumn);
    if (methods.length === 0 && site.overrideMenu !== undefined) {
      this.narrowEmpty.push(site.verdict.receiverKind);
      this.pushRow(site.method, site.call, site.verdict, site.kind, [...site.overrideMenu], reason);
      return;
    }
    if (methods.length === 0) {
      // Every narrowed class reads the member as a schema column: no method node to edge to.
      this.excludedCounts.schemaColumn += 1;
      return;
    }
    const [sole] = methods;
    // An edge needs the OTHER calls to have done the narrowing: a member only one
    // class answers on its own is a namesake as often as not (`filter`, `save!`).
    const narrowedByConstraints = own.size > 1 && classes.size === 1;
    if (narrowedByConstraints && targets.size === 1 && site.kind === "dynamic" && sole !== undefined) {
      this.narrowedSites.push({
        receiverKind: site.verdict.receiverKind,
        edge: {
          sourceSymbolId: site.method.symbolId,
          targetSymbolId: sole[0],
          targetRelPath: sole[1].relPath,
          callExpression: site.call.callText,
        },
      });
      return;
    }
    const menu = orderByNamingPrior(
      site.call.receiver ?? "",
      methods.map(([id]) => id),
    );
    const classTargets = classTargetsOf(
      site.call.receiver ?? "",
      site.call.member,
      classes,
      own,
      overrides,
      site.returnTypeOf,
    );
    this.pushRow(site.method, site.call, site.verdict, site.kind, menu, reason, {
      receiverGroup: sha1(site.groupKey),
      classTargets,
      ...(classTargets.some((t) => t.length > 2) ? { downstreamGroup: downstreamGroupOf(site) } : {}),
    });
  }

  private pushRow(
    method: ResidualMethodView,
    call: CallRef,
    verdict: ResidualVerdictView,
    kind: ResidualKind,
    menu: string[],
    reason?: ResidualReason,
    group?: Pick<ResidualCallSiteRow, "receiverGroup" | "classTargets" | "downstreamGroup">,
  ): void {
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
      language: this.language,
      receiverKind: verdict.receiverKind,
      ...(reason === undefined ? {} : { reason }),
      ...(group?.classTargets?.length ? group : {}),
    });
  }

  rows(): ResidualCallSiteRow[] {
    this.settle();
    return this.collected;
  }

  excluded(): Readonly<ResidualExclusionCounts> {
    this.settle();
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
