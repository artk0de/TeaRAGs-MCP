/**
 * Project-scope schema-column pre-pass (bd tea-rags-mcp-8l5fo).
 *
 * An ORM column accessor (`firm.name`, `firm.firm_id`, `firm.created_at`) is a
 * real method at runtime with no `def` anywhere in source — the ORM generates it
 * from the persisted schema at boot. Statically that turns every such call into
 * a miss, and the column short-names dominate the ambiguous aggregates on a
 * Rails corpus. This pre-pass restores the missing declaration: it runs ONCE per
 * run at the pass-1→pass-2 barrier, maps each schema table onto its owning
 * model, and synthesizes the accessor definitions onto that model.
 *
 * Two halves, both pure over injected data (mirroring `self-dispatch-discovery.ts`):
 *
 *   - {@link collectSchemaColumnModels} — the run's model inventory, from the
 *     ancestry map + symbol table the barrier already holds.
 *   - {@link synthesizeSchemaColumnDefs} — the table→model mapping and the
 *     definitions themselves.
 *
 * Language-agnostic by construction: the table parse, the table→model naming
 * convention and the model base classes all arrive through the injected
 * `SchemaColumnAccessorSource` facet, so this module carries no Rails knowledge
 * (the same dependency direction as `buildCodegraphExclusionFilter`).
 *
 * PRECISION RULE throughout: an unmapped or ambiguous table synthesizes NOTHING.
 * A missing column is silence; a column attached to the wrong model is a wrong
 * edge, and there is no way for a consumer to tell the two apart afterwards.
 */

import type {
  GlobalSymbolTable,
  RelPath,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import type { SchemaTableColumns } from "../../../../contracts/types/language.js";

/** One model the pre-pass may attach columns to. */
export interface SchemaColumnModel {
  /** Fully-qualified class name, as the walker's ancestry map keys it. */
  readonly fqName: string;
  /** File declaring the class — the synthesized definitions' `relPath`. */
  readonly relPath: RelPath;
  /**
   * Lexical scope the class's OWN member definitions carry. Derived from the
   * class-body definition rather than split from the FQ, because the two stored
   * forms differ: a nested `module Admin; class Firm` yields `["Admin","Firm"]`
   * while a compact `class Admin::Firm` yields `["Admin::Firm"]`, and the
   * resolver matches on the scope TAIL.
   */
  readonly scope: readonly string[];
  /** Explicit table override declared in the class body, when present. */
  readonly declaredTable?: string;
}

/** Mapping outcome of one pre-pass, for the run's debug log. */
export interface SchemaColumnSynthesisStats {
  schemaTables: number;
  models: number;
  mappedExplicit: number;
  mappedInflection: number;
  ambiguous: number;
  unmapped: number;
  definitions: number;
}

export interface SchemaColumnSynthesis {
  definitions: SymbolDefinition[];
  stats: SchemaColumnSynthesisStats;
}

/** Inputs {@link collectSchemaColumnModels} folds over. */
export interface SchemaColumnModelInput {
  /** Run-global `class FQ → ancestors` (superclass first, then mixins). */
  readonly classAncestors: Readonly<Record<string, readonly string[]>>;
  /** Run-global `class FQ → explicit table override`. */
  readonly declaredTables: Readonly<Record<string, string>>;
  /** Base classes whose descendants own schema tables (language-supplied). */
  readonly modelBaseClasses: readonly string[];
  /** The run's symbol table, for the class's declaring file + scope form. */
  readonly symbolTable: GlobalSymbolTable;
}

/** Transitive ancestry reach, cycle-guarded. Mirrors the resolver's own
 *  `ancestryReaches` walk, over the data the barrier holds run-global. */
function ancestryReaches(
  fqName: string,
  targets: ReadonlySet<string>,
  classAncestors: Readonly<Record<string, readonly string[]>>,
  seen: Set<string>,
): boolean {
  if (targets.has(fqName)) return true;
  if (seen.has(fqName)) return false;
  seen.add(fqName);
  for (const ancestor of classAncestors[fqName] ?? []) {
    if (ancestryReaches(ancestor, targets, classAncestors, seen)) return true;
  }
  return false;
}

/**
 * The class's OWN local name — its FQ minus the namespace its class-body
 * definition was declared under. `("Admin::Firm", ["Admin"])` → `"Firm"`;
 * `("Admin::Firm", [])` (compact declaration) → `"Admin::Firm"`.
 */
function localNameOf(fqName: string, declaringScope: readonly string[]): string {
  if (declaringScope.length === 0) return fqName;
  const prefix = `${declaringScope.join("::")}::`;
  return fqName.startsWith(prefix) ? fqName.slice(prefix.length) : fqName;
}

/**
 * The models this run may attach schema columns to: every class whose ancestry
 * reaches one of the language's model base classes AND whose class-body
 * definition the symbol table knows (that definition supplies the declaring file
 * plus the scope form the resolver matches on). A class the table does not know
 * is skipped — under-coverage, never a definition on the wrong file.
 */
export function collectSchemaColumnModels(input: SchemaColumnModelInput): SchemaColumnModel[] {
  const bases = new Set(input.modelBaseClasses);
  const models: SchemaColumnModel[] = [];
  for (const fqName of Object.keys(input.classAncestors)) {
    if (!ancestryReaches(fqName, bases, input.classAncestors, new Set())) continue;
    const classDef = input.symbolTable.lookup(fqName).find((def) => def.fqName === fqName);
    if (classDef === undefined) continue;
    const declaredTable = input.declaredTables[fqName];
    const scope = [...classDef.scope, localNameOf(fqName, classDef.scope)];
    models.push(
      declaredTable === undefined
        ? { fqName, relPath: classDef.relPath, scope }
        : { fqName, relPath: classDef.relPath, scope, declaredTable },
    );
  }
  return models;
}

/**
 * Map every schema table onto its owning model and synthesize the column
 * accessor definitions.
 *
 * Mapping precedence, exactly the oracle's (measured on taxdome 2026-07-26: 342
 * of 367 tables mapped, 330 of them explicit, zero ambiguous):
 *
 *   1. An explicit in-source declaration (`self.table_name`) CLAIMS its table.
 *      A claimed table is then invisible to inflection, so a `companies` table
 *      declared by `Firm` can never also land on a `Company` model.
 *   2. Inflection maps a remaining table to the model whose own name equals
 *      `modelNameForTable(table)` — but only when EXACTLY ONE model matches and
 *      it has not claimed a different table. Two namesakes in different
 *      namespaces are ambiguous, and ambiguous means silence.
 *
 * Matching is on the model's own local name (the scope tail), so `Admin::Firm`
 * and `Firm` both answer to `Firm` and therefore collide — deliberately.
 */
export function synthesizeSchemaColumnDefs(
  tables: readonly SchemaTableColumns[],
  models: readonly SchemaColumnModel[],
  modelNameForTable: (table: string) => string,
): SchemaColumnSynthesis {
  const stats: SchemaColumnSynthesisStats = {
    schemaTables: tables.length,
    models: models.length,
    mappedExplicit: 0,
    mappedInflection: 0,
    ambiguous: 0,
    unmapped: 0,
    definitions: 0,
  };
  if (tables.length === 0 || models.length === 0) return { definitions: [], stats };

  const tablesByName = new Map(tables.map((t) => [t.table, t]));
  /** table → the model that owns it. */
  const owners = new Map<string, SchemaColumnModel>();
  const claimedTables = new Set<string>();

  for (const model of models) {
    if (model.declaredTable === undefined) continue;
    claimedTables.add(model.declaredTable);
    // First declaration wins; a second model naming the same table is a genuine
    // collision (STI-style sharing), and guessing between them is not our call.
    if (tablesByName.has(model.declaredTable) && !owners.has(model.declaredTable)) {
      owners.set(model.declaredTable, model);
      stats.mappedExplicit += 1;
    }
  }

  const byLocalName = new Map<string, SchemaColumnModel[]>();
  for (const model of models) {
    if (model.declaredTable !== undefined) continue; // already bound to its own table
    const local = model.scope[model.scope.length - 1] ?? model.fqName;
    const bare = local.includes("::") ? (local.split("::").pop() ?? local) : local;
    const bucket = byLocalName.get(bare);
    if (bucket) bucket.push(model);
    else byLocalName.set(bare, [model]);
  }

  for (const table of tables) {
    if (claimedTables.has(table.table)) continue;
    const candidates = byLocalName.get(modelNameForTable(table.table)) ?? [];
    const only = candidates[0];
    if (candidates.length === 1 && only !== undefined) {
      owners.set(table.table, only);
      stats.mappedInflection += 1;
    } else if (candidates.length > 1) {
      stats.ambiguous += 1;
    } else {
      stats.unmapped += 1;
    }
  }

  const definitions: SymbolDefinition[] = [];
  for (const [tableName, model] of owners) {
    const table = tablesByName.get(tableName);
    if (table === undefined) continue;
    for (const accessor of table.accessors) {
      const symbolId = `${model.fqName}#${accessor}`;
      definitions.push({
        symbolId,
        fqName: symbolId,
        shortName: accessor,
        relPath: model.relPath,
        scope: [...model.scope],
        isSchemaColumn: true,
      });
    }
  }
  stats.definitions = definitions.length;
  return { definitions, stats };
}
