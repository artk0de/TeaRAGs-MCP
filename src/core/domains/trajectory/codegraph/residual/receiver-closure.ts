/**
 * Receiver narrowing for residual sites (codegraph residual wave 1.5, design §3):
 * which project classes answer a member once inheritance is counted, how calls
 * on one receiver group within a method, and the naming prior that orders a
 * narrowed menu.
 *
 * Spec: `docs/superpowers/specs/2026-10-16-codegraph-residual-wave-1-5-design.md`
 */
import { extname } from "node:path";

import type {
  GlobalSymbolTable,
  HierarchyView,
  InheritanceKind,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import { orderByReceiverName } from "./receiver-name-prior.js";

/** Kinds through which an instance member reaches a class: its superclass chain, included / prepended modules. */
const INSTANCE_MEMBER_KINDS: readonly InheritanceKind[] = ["super", "include", "prepend", "implements"];
/** Kinds through which a class-level member reaches a class: superclass chain and `extend`. */
const CLASS_MEMBER_KINDS: readonly InheritanceKind[] = ["super", "extend"];

/** A receiver root: a local, an ivar or a cvar. */
const RECEIVER_ROOT = /^@{0,2}[A-Za-z_]\w*/;

/** The member's separator in `symbolId`, or `null` when the id does not end in `member`. */
function memberSeparator(symbolId: string, member: string): "#" | "." | null {
  if (symbolId.endsWith(`#${member}`)) return "#";
  if (symbolId.endsWith(`.${member}`)) return ".";
  return null;
}

/**
 * The project classes answering a member, each with the definitions it reaches
 * the member through: its own, else the nearest ancestor's (ties keep every
 * definer at that depth). Schema column accessors count — `isSchemaColumn` marks
 * them on the definition. Cached per member for one file.
 */
export class ReceiverClassClosure {
  private readonly cache = new Map<string, ReadonlyMap<string, readonly SymbolDefinition[]>>();

  constructor(
    private readonly symbolTable: Pick<GlobalSymbolTable, "lookupByShortName">,
    private readonly extension: string,
    private readonly hierarchy?: HierarchyView,
  ) {}

  answerers(member: string): ReadonlyMap<string, readonly SymbolDefinition[]> {
    const cached = this.cache.get(member);
    if (cached !== undefined) return cached;
    const nearest = new Map<string, { depth: number; defs: SymbolDefinition[] }>();
    const offer = (owner: string, depth: number, def: SymbolDefinition): void => {
      const seen = nearest.get(owner);
      if (seen === undefined || depth < seen.depth) nearest.set(owner, { depth, defs: [def] });
      else if (depth === seen.depth && !seen.defs.some((d) => d.symbolId === def.symbolId)) seen.defs.push(def);
    };
    for (const def of this.symbolTable.lookupByShortName(member, { includeSchemaColumns: true })) {
      if (extname(def.relPath) !== this.extension) continue;
      const separator = memberSeparator(def.symbolId, member);
      if (separator === null) continue;
      const owner = def.symbolId.slice(0, def.symbolId.length - member.length - 1);
      offer(owner, 0, def);
      const kinds = separator === "#" ? INSTANCE_MEMBER_KINDS : CLASS_MEMBER_KINDS;
      for (const edge of this.hierarchy?.getDescendants(owner, { transitive: true, kinds }) ?? []) {
        offer(edge.sourceFqName, edge.depth, def);
      }
    }
    const answer = new Map([...nearest].map(([owner, { defs }]) => [owner, defs]));
    this.cache.set(member, answer);
    return answer;
  }
}

/**
 * One receiver within one method: the receiver text with whitespace dropped,
 * split by every assignment to its root that precedes the call — a local
 * reassigned between two calls is two receivers.
 */
export function receiverGroupKey(
  methodSymbolId: string,
  receiverText: string,
  line: number,
  assignmentLines?: Readonly<Record<string, readonly number[]>>,
): string {
  const normalized = receiverText.replace(/\s+/g, "");
  const root = RECEIVER_ROOT.exec(normalized)?.[0];
  const generation =
    root === undefined ? 0 : (assignmentLines?.[root]?.filter((assigned) => assigned < line).length ?? 0);
  return [methodSymbolId, normalized, String(generation)].join("\u0000");
}

/** The menu ordered by the receiver-name prior of each target's class, then by symbolId; nothing is dropped. */
export function orderByNamingPrior(receiverText: string, candidates: readonly string[]): string[] {
  return orderByReceiverName(receiverText, candidates, (id) =>
    id.slice(0, Math.max(id.lastIndexOf("#"), id.lastIndexOf("."))),
  );
}

/** Class names ordered by the receiver-name prior, then by name; nothing is dropped. */
export function orderClassesByNamingPrior(receiverText: string, classes: readonly string[]): string[] {
  return orderByReceiverName(receiverText, classes, (owner) => owner);
}
