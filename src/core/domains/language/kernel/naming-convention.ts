/**
 * Naming-convention receiver typing, the neutral half (E2 seam 5, bd
 * tea-rags-mcp-9fgdi / 0g8g5) — relocated from
 * `ruby/resolver/ruby-unbound-receiver-types.ts`, where it was measured on
 * taxdome as 11 % of the entire recall hole (bd tea-rags-mcp-wob7g).
 *
 * `payment` is a `Payment` because that is the dominant naming discipline of
 * every OO language, not a Rails idiom. Two gates, both measured rather than
 * argued, and BOTH are the whole precision story:
 *
 *  1. the camelized class must EXIST in the run. A name that camelizes to
 *     nothing the project declares means something else entirely, and a
 *     fabricated receiver type poisons every downstream hop.
 *  2. it must have NO subtypes. A class with descendants is a polymorphic base,
 *     and a variable named after it carries a CONCRETE subtype at runtime —
 *     `actor` in an app whose `Actor` is specialised by Guest / Employee is an
 *     `Employee`. That shape is where EVERY measured convention error came from.
 *
 * The gates are ORDERED and each short-circuits: an empty camelization asks
 * nothing, and an unknown class is never asked about descendants. Both ports
 * scan run-global structures on some languages, so the order is a cost
 * decision as much as a semantic one.
 *
 * What this does NOT own is the terminal: the caller must still refuse to emit
 * an edge when the guessed class does not declare the member. That gate is
 * per-language (it needs the language's MRO) and each caller documents it.
 */

/** The three per-language answers the gate is composed from. */
export interface NamingConventionPorts<TCtx> {
  /** `blog_post` → `BlogPost`. Per-language: Ruby camelizes, Python does the same but on a narrower alphabet. */
  camelize: (receiverName: string) => string;
  /** Does the run DECLARE this class? The existence gate. */
  classExists: (className: string, ctx: TCtx) => boolean;
  /** Does it have DESCENDANTS? A polymorphic base named by a variable carries a concrete subtype. */
  hasSubtypes: (className: string, ctx: TCtx) => boolean;
}

/**
 * The class `receiverName` NAMES by convention, or `undefined` when either gate
 * declines. The receiver text is already stripped of whatever sigil the
 * language puts on it — the caller owns the surface it acts on.
 */
export function conventionClassNameFor<TCtx>(
  receiverName: string,
  ctx: TCtx,
  ports: NamingConventionPorts<TCtx>,
): string | undefined {
  const className = ports.camelize(receiverName);
  if (className.length === 0) return undefined;
  if (!ports.classExists(className, ctx)) return undefined;
  if (ports.hasSubtypes(className, ctx)) return undefined;
  return className;
}
