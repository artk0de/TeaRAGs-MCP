/**
 * Which FRAMEWORK VOCABULARY arm would answer a residual row (bd
 * tea-rags-mcp-w205u.2, E4.2a).
 *
 * `scripts/lib/py-residual-families.ts` cuts the residual by RESOLUTION
 * MECHANISM, which lands Django / SQLAlchemy shapes in `untypedNameReceiver`
 * or `untypedFieldHop`. This cuts the same rows by the four arms E3 deferred,
 * so the 30-row mass bar is measured rather than assumed. One arm per row,
 * most-specific-first; `none` and the binding distribution are both REPORTED,
 * since `unbound` is the classifier's own blind spot, not a zero.
 *
 * Usage: npx tsx scripts/spikes/py-framework-arm-attribution.ts \
 *   --rows <residual.ndjson> --corpus-root <abs path> [--json out.json]
 */
import { readdirSync, readFileSync, writeFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { classifyReceiverBinding, type PyBindingSourceView } from "../lib/py-receiver-binding.js";
import type { PyResidualRow } from "../lib/py-residual-families.js";

export const PY_FRAMEWORK_ARMS = ["getObjectOr404", "instanceTerminal", "fluentMember", "taggedOwner", "none"] as const;
export type PyFrameworkArm = (typeof PY_FRAMEWORK_ARMS)[number];

const OR404 = /\bget_(?:object|list)_or_404\s*\(/;
const MANAGER = /\.(?:objects|_default_manager|query|session)\b/;
const TERMINAL = /\.(?:get|first|last|latest|earliest|create|get_or_create|scalar_one|scalar_one_or_none|scalars)\s*\(/;
const FLUENT = /\.(?:filter|filter_by|exclude|all|annotate|order_by|select_related|prefetch_related|where)\s*\(/;
const TAGS = /@(?:property|cached_property|hybrid_property|declared_attr|computed_field|field_validator)\b/;
const TAGGED_DEF = new RegExp(`${TAGS.source}[^\\n]*\\n(?:[^\\n]*\\n){0,3}?\\s*(?:async\\s+)?def\\s+(\\w+)`, "g");

/**
 * Attribute one residual row to exactly one deferred framework arm.
 *
 * `taggedOwner` reads DOTTED receivers only: `order.calculate_refunded_tax()`
 * binds `order` as an unannotated param, and its sharing a name with some
 * `@property def order` elsewhere in the corpus is a coincidence, not an owner
 * hop. Reading the bare branch too put 30 polar rows here, every one of them
 * `untypedNameReceiver` — which is exactly the mass bar this measures.
 */
export function classifyFrameworkArm(row: PyResidualRow, binding: string, tagged: ReadonlySet<string>): PyFrameworkArm {
  const receiver = row.receiver ?? "";
  if (OR404.test(binding) || OR404.test(receiver)) return "getObjectOr404";
  if (MANAGER.test(binding) && (TERMINAL.test(binding) || FLUENT.test(binding))) return "instanceTerminal";
  if (row.categories.includes("managerQuerySet") || (MANAGER.test(receiver) && FLUENT.test(receiver))) {
    return "fluentMember";
  }
  const tail = receiver.includes(".") ? (receiver.split(".").pop() ?? "") : "";
  return tail !== "" && tagged.has(tail) ? "taggedOwner" : "none";
}

/** Every `@`-tagged def name in the corpus. One walk; the read is the cost, not the regex. */
export function taggedDefs(root: string): Set<string> {
  const names = new Set<string>();
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
      if (e.isDirectory()) stack.push(join(dir, e.name));
      else if (e.name.endsWith(".py")) {
        const text = readFileSync(join(dir, e.name), "utf8");
        for (const m of text.matchAll(TAGGED_DEF)) names.add(m[1]);
      }
    }
  }
  return names;
}

function main(): void {
  const argv = process.argv.slice(2);
  // `indexOf` returns -1 for an absent flag, and `argv[-1 + 1]` is argv[0] —
  // which silently wrote a run with no `--json` to a file named `--rows`.
  const arg = (flag: string): string => {
    const at = argv.indexOf(flag);
    return at === -1 ? "" : (argv[at + 1] ?? "");
  };
  const root = arg("--corpus-root");
  const tagged = taggedDefs(root);
  const cache = new Map<string, readonly string[]>();
  const view: PyBindingSourceView = {
    linesOf: (rel) => {
      if (!cache.has(rel)) cache.set(rel, readFileSync(join(root, rel), "utf8").split("\n"));
      return cache.get(rel) as readonly string[];
    },
    isProjectClass: () => false,
    isProjectDef: () => false,
  };
  const rows = readFileSync(arg("--rows"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as PyResidualRow);

  const byArm = new Map<PyFrameworkArm, PyResidualRow[]>(PY_FRAMEWORK_ARMS.map((a) => [a, []]));
  const bindings = new Map<string, number>();
  for (const row of rows) {
    const { binding, detail } = classifyReceiverBinding(row, view);
    bindings.set(binding, (bindings.get(binding) ?? 0) + 1);
    (byArm.get(classifyFrameworkArm(row, detail, tagged)) as PyResidualRow[]).push(row);
  }
  const bound = [...bindings].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
  const arms = PY_FRAMEWORK_ARMS.map((a) => `${a} ${(byArm.get(a) as PyResidualRow[]).length}`);
  process.stdout.write(`rows ${rows.length}, tagged defs ${tagged.size}\nbindings: ${bound.join(", ")}\n`);
  process.stdout.write(`${arms.join("\n")}\n`);
  const out = arg("--json");
  if (out !== "") writeFileSync(out, JSON.stringify({ rows: rows.length, byArm: Object.fromEntries(byArm) }, null, 2));
}

main();
