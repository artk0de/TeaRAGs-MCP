/**
 * Residual sites no model pick can make right (bd tea-rags-mcp-2m83f.34): the
 * true callee is a framework-generated method, so it is in no menu. The runner
 * drops such a site from `cg_residual_call_sites` and counts it under the rule.
 */
import type { GlobalSymbolTable } from "../../../../contracts/types/codegraph-symbols.js";
import type { CallContext, CallRef, ResidualExclusionRule } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { RAILS_RESIDUAL_FRAMEWORK_MEMBERS } from "../dsl/index.js";
import { camelizeModelName } from "../walker/association-types.js";
import {
  isRubyPath,
  lastConstantSegment,
  lookupRubySymbolsByShortName,
  railsVocabularyActive,
  receiverLooksLikeArRelationChain,
  rubyMemberLookupRole,
} from "./strategies/index.js";

/** A bare local or ivar — the only receiver a model name can be read off. */
const MODEL_NAMED_RECEIVER = /^@?([a-z_]\w*)$/;

/** The last method name of a receiver chain, its argument list dropped: `a.b(1).c` → `c`. */
const RECEIVER_TAIL = /([A-Za-z_]\w*[?!]?)\s*(?:\([^()]*\))?\s*$/;

const ATTACHMENT_PROXY_PREFIX = "ActiveStorage::Attached::";

/** Columns ActiveRecord timestamps on every table it creates. */
const AR_TIMESTAMP_COLUMNS: ReadonlySet<string> = new Set(["created_at", "updated_at"]);

/**
 * What every return fact of one method short name says it returns. `external`
 * — a class the project does not declare, so it owns no menu candidate — never
 * breaks the agreement of the others (bd tea-rags-mcp-2m83f.35).
 */
type TailShape = "relation" | "attachment" | "external" | "mixed";

const tailShapesByTable = new WeakMap<
  GlobalSymbolTable,
  WeakMap<Readonly<Record<string, RubyTypeRef>>, Map<string, TailShape>>
>();

/** No Ruby declaration carries the class's last segment — `File`, a gem's `Quickbooks::Model::Payment`. */
function isUndeclaredClass(name: string, symbolTable: GlobalSymbolTable): boolean {
  return !symbolTable.lookupByShortName(lastConstantSegment(name)).some((def) => isRubyPath(def.relPath));
}

function shapeOf(type: RubyTypeRef, symbolTable: GlobalSymbolTable): TailShape {
  if (type.form === "container") return "relation";
  if (type.form === "instance" && type.name.startsWith(ATTACHMENT_PROXY_PREFIX)) return "attachment";
  if (type.form === "instance" && isUndeclaredClass(type.name, symbolTable)) return "external";
  return "mixed";
}

function agree(seen: TailShape | undefined, shape: TailShape): TailShape {
  if (seen === undefined || seen === shape || shape === "external") return seen ?? shape;
  return seen === "external" ? shape : "mixed";
}

/** Method short name → the shape all its return facts agree on; built once per run map. */
function tailShapes(
  returns: Readonly<Record<string, RubyTypeRef>>,
  symbolTable: GlobalSymbolTable,
): Map<string, TailShape> {
  let byReturns = tailShapesByTable.get(symbolTable);
  if (byReturns === undefined) {
    byReturns = new WeakMap();
    tailShapesByTable.set(symbolTable, byReturns);
  }
  const cached = byReturns.get(returns);
  if (cached !== undefined) return cached;
  const shapes = new Map<string, TailShape>();
  for (const [key, type] of Object.entries(returns)) {
    const short = key.slice(Math.max(key.lastIndexOf("#"), key.lastIndexOf(".")) + 1);
    shapes.set(short, agree(shapes.get(short), shapeOf(type, symbolTable)));
  }
  byReturns.set(returns, shapes);
  return shapes;
}

/** A column accessor on a receiver named after the model that owns the column and declares no such def. */
function isModelColumnRead(call: CallRef, receiver: string, ctx: CallContext): boolean {
  const named = MODEL_NAMED_RECEIVER.exec(receiver)?.[1];
  if (named === undefined) return false;
  const modelName = camelizeModelName(named);
  const role = rubyMemberLookupRole(call);
  const columns = lookupRubySymbolsByShortName(ctx, call.member, { role, includeSchemaColumns: true }).filter(
    (def) => def.isSchemaColumn === true,
  );
  if (columns.length === 0) return false;
  const declared = new Set(lookupRubySymbolsByShortName(ctx, call.member, { role }).map((def) => def.symbolId));
  return columns.some((column) => {
    const model = column.symbolId.slice(0, column.symbolId.lastIndexOf("#"));
    return lastConstantSegment(model) === modelName && !declared.has(column.symbolId);
  });
}

/** A relation member on a relation, or an ActiveStorage member on an attachment proxy. */
function isFrameworkMember(call: CallRef, receiver: string, ctx: CallContext): boolean {
  const { relationMembers, attachmentMembers } = RAILS_RESIDUAL_FRAMEWORK_MEMBERS;
  const relationMember = relationMembers.has(call.member);
  const attachmentMember = attachmentMembers.has(call.member);
  if (!relationMember && !attachmentMember) return false;
  if (!railsVocabularyActive(ctx)) return false;
  if (relationMember && receiverLooksLikeArRelationChain(receiver)) return true;
  const tail = RECEIVER_TAIL.exec(receiver)?.[1];
  if (tail === undefined || ctx.structuredReturnTypes === undefined) return false;
  const shape = tailShapes(ctx.structuredReturnTypes, ctx.symbolTable).get(tail);
  return (relationMember && shape === "relation") || (attachmentMember && shape === "attachment");
}

/**
 * `created_at` / `updated_at` on a bare receiver when some model owns the
 * column and no model declares a def of that name — every menu candidate is a
 * non-model namesake (a DTO, a serializer), the callee the column accessor.
 */
function isTimestampColumnRead(call: CallRef, receiver: string, ctx: CallContext): boolean {
  if (!AR_TIMESTAMP_COLUMNS.has(call.member) || !MODEL_NAMED_RECEIVER.test(receiver)) return false;
  if (!railsVocabularyActive(ctx)) return false;
  const role = rubyMemberLookupRole(call);
  const columns = lookupRubySymbolsByShortName(ctx, call.member, { role, includeSchemaColumns: true }).filter(
    (def) => def.isSchemaColumn === true,
  );
  if (columns.length === 0) return false;
  const models = new Set(columns.map((column) => column.symbolId));
  return !lookupRubySymbolsByShortName(ctx, call.member, { role }).some((def) => models.has(def.symbolId));
}

export function rubyResidualExclusion(call: CallRef, ctx: CallContext): ResidualExclusionRule | null {
  const { receiver } = call;
  if (receiver === null) return null;
  if (isModelColumnRead(call, receiver, ctx)) return "schemaColumn";
  if (isFrameworkMember(call, receiver, ctx)) return "frameworkMember";
  if (isTimestampColumnRead(call, receiver, ctx)) return "timestampColumn";
  return null;
}
