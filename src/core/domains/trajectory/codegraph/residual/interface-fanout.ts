/**
 * Interface fan-out (bd 2m83f.64): a receiver that is polymorphic at runtime
 * makes the model split its probability over the classes behind it, so no
 * single class clears the accept threshold — or one does and the edge covers
 * part of the dispatch set. When the classes the model ranks at or above the
 * fan-out floor belong to one interface and their summed `p` clears the
 * threshold, the group's sites edge to every one of them.
 *
 * The interface is structural, never the model's alone:
 *   - polymorphic — the receiver's last hop names a polymorphic association
 *     (`@actor`, `task.actor`), and the interface is the likely classes
 *     declaring `has_many|has_one …, as: :actor`;
 *   - shared — otherwise every likely class carries one common tie: the same
 *     `as:` name, the same project module mixed in, or the same project
 *     superclass below the topmost project class of its chain.
 *
 * Ties are read from the graph (supertypes) and the class files' text (`as:`),
 * Ruby only; a class without ties never joins a fan-out.
 */
import type { InheritanceEdge } from "../../../../contracts/types/codegraph-hierarchy.js";
import { RESIDUAL_NONE_PROBABILITY_KEY } from "../../../../contracts/types/codegraph-residual.js";
import type { GraphDbClient } from "../../../../contracts/types/codegraph-storage.js";

/** Smallest `p` of a class for it to join a fan-out; `CODEGRAPH_RESIDUAL_FANOUT_FLOOR`. */
export const DEFAULT_FANOUT_FLOOR = 0.15;

/** Superclass hops walked per class. */
const MAX_SUPER_DEPTH = 8;

/** Tie keys per class: `as:<name>`, `include:<Module>`, `super:<Class>`. */
export type ClassTies = ReadonlyMap<string, ReadonlySet<string>>;

export interface ResidualClassTieReader {
  tiesOf: (classes: readonly string[]) => Promise<ClassTies>;
}

export interface InterfaceFanout {
  /** The fanned-out classes, in menu order. */
  classes: string[];
  /** Their summed `p`. */
  p: number;
  via: "polymorphic" | "shared";
}

/** Menu classes at or above `floor`, in menu order. */
export function fanoutCandidates(
  menu: readonly string[],
  probabilities: Readonly<Record<string, number>>,
  floor: number,
): string[] {
  return menu.filter((cls) => cls !== RESIDUAL_NONE_PROBABILITY_KEY && (probabilities[cls] ?? 0) >= floor);
}

/** The name a polymorphic association reader would carry: the receiver's last hop, sigils dropped. */
function interfaceName(receiverText: string): string | undefined {
  const last = receiverText.trim().split(".").at(-1) ?? "";
  return /^@{0,2}([a-z_]\w*)$/u.exec(last.replace(/\(.*$/su, ""))?.[1];
}

/**
 * The fan-out of one answered class question, or `undefined`: fewer than two
 * likely classes, no structural interface over them, or a sum under `accept`.
 * A receiver naming a polymorphic interface that some likely class declares is
 * judged by that interface alone.
 */
export function interfaceFanout(input: {
  receiverText: string;
  menu: readonly string[];
  probabilities: Readonly<Record<string, number>>;
  ties: ClassTies;
  floor: number;
  accept: number;
}): InterfaceFanout | undefined {
  const likely = fanoutCandidates(input.menu, input.probabilities, input.floor);
  if (likely.length < 2) return undefined;
  const tiesOf = (cls: string): ReadonlySet<string> => input.ties.get(cls) ?? new Set<string>();
  const name = interfaceName(input.receiverText);
  const declared = name === undefined ? [] : likely.filter((cls) => tiesOf(cls).has(`as:${name}`));
  let classes: string[];
  let via: InterfaceFanout["via"];
  if (declared.length > 0) {
    classes = declared;
    via = "polymorphic";
  } else {
    const [first, ...rest] = likely;
    const shared = [...tiesOf(first)].some((tie) => rest.every((cls) => tiesOf(cls).has(tie)));
    classes = shared ? likely : [];
    via = "shared";
  }
  if (classes.length < 2) return undefined;
  const p = classes.reduce((sum, cls) => sum + (input.probabilities[cls] ?? 0), 0);
  if (p < input.accept) return undefined;
  return { classes, p: Math.min(1, Math.round(p * 1e6) / 1e6), via };
}

/** `has_many` / `has_one` macro lines naming a polymorphic counterpart (`as: :x`, `:as => :x`). */
const AS_DECLARATION = /^[ \t]*has_(?:many|one)\b[^\n#]*?(?:\bas:[ \t]*|:as[ \t]*=>[ \t]*):([a-z_]\w*)/gmu;

/** The `as:` names of a Ruby source's `has_many` / `has_one` declarations, in order, once each. */
export function polymorphicAsNames(source: string): string[] {
  return [...new Set([...source.matchAll(AS_DECLARATION)].map((m) => m[1]))];
}

/**
 * Ties read from the code graph and the class files, cached for the reader's
 * life (one pass). A file declaring several classes ties each of them to its
 * `as:` names.
 */
export class GraphClassTieReader implements ResidualClassTieReader {
  private readonly ties = new Map<string, ReadonlySet<string>>();
  private readonly supertypes = new Map<string, Promise<InheritanceEdge[]>>();
  private readonly asNames = new Map<string, Promise<string[]>>();

  constructor(
    private readonly graphDb: Pick<GraphDbClient, "getSupertypes" | "getSymbolRelPaths">,
    private readonly readSourceFile: (relPath: string) => Promise<string>,
  ) {}

  async tiesOf(classes: readonly string[]): Promise<ClassTies> {
    const missing = classes.filter((cls) => !this.ties.has(cls));
    if (missing.length > 0) {
      const paths = await this.graphDb.getSymbolRelPaths([...missing]);
      for (const cls of missing) this.ties.set(cls, await this.read(cls, paths.get(cls) ?? []));
    }
    return new Map(classes.map((cls) => [cls, this.ties.get(cls) ?? new Set<string>()]));
  }

  private async read(cls: string, relPaths: readonly string[]): Promise<ReadonlySet<string>> {
    const ties = new Set<string>();
    for (const relPath of relPaths) {
      for (const name of await this.asNamesOf(relPath)) ties.add(`as:${name}`);
    }
    for (const edge of await this.supertypesOf(cls)) {
      if ((edge.kind === "include" || edge.kind === "prepend") && edge.ancestorSymbolId !== null) {
        ties.add(`include:${edge.ancestorFqName}`);
      }
    }
    let current = cls;
    for (let depth = 0; depth < MAX_SUPER_DEPTH; depth++) {
      const parent = await this.projectSuperclass(current);
      if (parent === undefined || (await this.projectSuperclass(parent)) === undefined) break;
      ties.add(`super:${parent}`);
      current = parent;
    }
    return ties;
  }

  private async projectSuperclass(cls: string): Promise<string | undefined> {
    const edge = (await this.supertypesOf(cls)).find((e) => e.kind === "super");
    const projectAncestor = edge !== undefined && edge.ancestorSymbolId !== null;
    return projectAncestor ? edge.ancestorFqName : undefined;
  }

  private async supertypesOf(cls: string): Promise<InheritanceEdge[]> {
    let pending = this.supertypes.get(cls);
    if (pending === undefined) {
      pending = this.graphDb.getSupertypes(cls);
      this.supertypes.set(cls, pending);
    }
    return pending;
  }

  private async asNamesOf(relPath: string): Promise<string[]> {
    let pending = this.asNames.get(relPath);
    if (pending === undefined) {
      pending = this.readSourceFile(relPath).then(polymorphicAsNames, () => []);
      this.asNames.set(relPath, pending);
    }
    return pending;
  }
}
