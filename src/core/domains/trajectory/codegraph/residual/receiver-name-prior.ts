/**
 * The receiver-name prior (codegraph residual wave 1.5, design §3 "Naming
 * prior"): which classes of a receiver group the receiver's own name points at.
 * It orders the class set and opens the tournament; it never removes a class.
 *
 * Language-neutral: names are compared as word tokens, so `current_user`,
 * `currentUser` and `CurrentUser` read alike.
 *
 * Spec: `docs/superpowers/specs/2026-10-16-codegraph-residual-wave-1-5-design.md`
 */

/** Match strength, best first. */
export const NAME_PRIOR = {
  /** `invoice` → `Invoice`, `result` → `AbstractPolicy::Result`. */
  exact: 0,
  /** `invoices` → `Invoice`, `companies` → `Company`. */
  singular: 1,
  /** The class short name ends with the name: `result` → `PaymentResult` (name ≥ 4 letters). */
  classSuffix: 2,
  /** The name ends with the class short name: `current_user` → `User`, `signatory_users` → `User`. */
  reverseSuffix: 3,
  none: 4,
} as const;

/** Shortest name the class-suffix rule reads: `id` must not open every `*Id` class. */
const MIN_CLASS_SUFFIX_NAME = 4;

const IDENTIFIER = /[A-Za-z_]\w*/g;

/**
 * The receiver's last name: arguments and indexing dropped, sigils dropped, the
 * text after the last `.` / `::` / `&.` — `build(x).payment_webhook` →
 * `payment_webhook`, `@invoice` → `invoice`, `items[0]` → `items`.
 */
export function receiverNameOf(receiverText: string): string | undefined {
  let text = receiverText;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/\([^()]*\)|\[[^[\]]*\]/g, "");
  } while (text !== previous);
  const names = text.match(IDENTIFIER);
  if (names === null) return undefined;
  const tail = text.trimEnd().replace(/[?!]$/, "");
  const last = names[names.length - 1];
  return tail.endsWith(last) ? last : undefined;
}

/** `Billing::InvoiceItem` → `["invoice", "item"]`; `line_items` → `["line", "items"]`. */
function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter((t) => t.length > 0);
}

/** English plural of a word token to its singular; a token that is not plural comes back unchanged. */
function singularOf(token: string): string {
  if (token.endsWith("ies") && token.length > 3) return `${token.slice(0, -3)}y`;
  if (/(?:s|x|z|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !/(?:ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
}

function endsWith(tokens: readonly string[], suffix: readonly string[]): boolean {
  if (suffix.length > tokens.length) return false;
  const offset = tokens.length - suffix.length;
  return suffix.every((t, i) => tokens[offset + i] === t);
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && endsWith(a, b);
}

/** How the receiver name relates to the class's short name (its last `::` / `.` component). */
export function receiverNameRank(name: string | undefined, className: string): number {
  if (name === undefined) return NAME_PRIOR.none;
  const short = className.slice(Math.max(className.lastIndexOf(":"), className.lastIndexOf(".")) + 1);
  const cls = tokensOf(short);
  const raw = tokensOf(name);
  if (cls.length === 0 || raw.length === 0) return NAME_PRIOR.none;
  const singular = [...raw.slice(0, -1), singularOf(raw[raw.length - 1])];
  if (same(raw, cls)) return NAME_PRIOR.exact;
  if (same(singular, cls)) return NAME_PRIOR.singular;
  const forms = singular.join("_") === raw.join("_") ? [raw] : [raw, singular];
  if (forms.some((f) => f.join("").length >= MIN_CLASS_SUFFIX_NAME && f.length < cls.length && endsWith(cls, f))) {
    return NAME_PRIOR.classSuffix;
  }
  if (forms.some((f) => f.length > cls.length && endsWith(f, cls))) return NAME_PRIOR.reverseSuffix;
  return NAME_PRIOR.none;
}

/** The classes the receiver's name points at, best rank first, the input order within a rank. */
export function nameMatchedClasses(receiverText: string, classes: readonly string[]): string[] {
  const name = receiverNameOf(receiverText);
  return classes
    .map((cls, index) => ({ cls, index, rank: receiverNameRank(name, cls) }))
    .filter((c) => c.rank < NAME_PRIOR.none)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((c) => c.cls);
}

/** `ids` ordered by the name prior of the class each names, then by id; nothing is dropped. */
export function orderByReceiverName(
  receiverText: string,
  ids: readonly string[],
  classOf: (id: string) => string,
): string[] {
  const name = receiverNameOf(receiverText);
  return ids
    .map((id) => ({ id, rank: receiverNameRank(name, classOf(id)) }))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => r.id);
}
