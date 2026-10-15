/**
 * Residual sites no model pick can make right (bd tea-rags-mcp-2m83f.34): the
 * true callee is a framework-generated method, so it is in no menu. The runner
 * drops such a site from `cg_residual_call_sites` and counts it under the rule.
 */
import type { CallContext, CallRef, ResidualExclusionRule } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { RAILS_RESIDUAL_FRAMEWORK_MEMBERS } from "../dsl/index.js";
import { camelizeModelName } from "../walker/association-types.js";
import {
  lastConstantSegment,
  lookupRubySymbolsByShortName,
  receiverLooksLikeArRelationChain,
  rubyMemberLookupRole,
} from "./strategies/index.js";

/** A bare local or ivar — the only receiver a model name can be read off. */
const MODEL_NAMED_RECEIVER = /^@?([a-z_]\w*)$/;

/** The last method name of a receiver chain, its argument list dropped: `a.b(1).c` → `c`. */
const RECEIVER_TAIL = /([A-Za-z_]\w*[?!]?)\s*(?:\([^()]*\))?\s*$/;

const ATTACHMENT_PROXY_PREFIX = "ActiveStorage::Attached::";

/** What every return fact of one method short name says it returns. */
type TailShape = "relation" | "attachment" | "mixed";

const tailShapesByReturns = new WeakMap<Readonly<Record<string, RubyTypeRef>>, Map<string, TailShape>>();

function shapeOf(type: RubyTypeRef): TailShape {
  if (type.form === "container") return "relation";
  if (type.form === "instance" && type.name.startsWith(ATTACHMENT_PROXY_PREFIX)) return "attachment";
  return "mixed";
}

/** Method short name → the shape all its return facts agree on; built once per run map. */
function tailShapes(returns: Readonly<Record<string, RubyTypeRef>>): Map<string, TailShape> {
  const cached = tailShapesByReturns.get(returns);
  if (cached !== undefined) return cached;
  const shapes = new Map<string, TailShape>();
  for (const [key, type] of Object.entries(returns)) {
    const short = key.slice(Math.max(key.lastIndexOf("#"), key.lastIndexOf(".")) + 1);
    const shape = shapeOf(type);
    const seen = shapes.get(short);
    shapes.set(short, seen === undefined || seen === shape ? shape : "mixed");
  }
  tailShapesByReturns.set(returns, shapes);
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

function railsDeclared(ctx: CallContext): boolean {
  const gems = ctx.declaredDependencies;
  if (gems === undefined) return true;
  for (const gem of RAILS_RESIDUAL_FRAMEWORK_MEMBERS.gems) if (gems.has(gem)) return true;
  return false;
}

/** A relation member on a relation, or an ActiveStorage member on an attachment proxy. */
function isFrameworkMember(call: CallRef, receiver: string, ctx: CallContext): boolean {
  const { relationMembers, attachmentMembers } = RAILS_RESIDUAL_FRAMEWORK_MEMBERS;
  const relationMember = relationMembers.has(call.member);
  const attachmentMember = attachmentMembers.has(call.member);
  if (!relationMember && !attachmentMember) return false;
  if (!railsDeclared(ctx)) return false;
  if (relationMember && receiverLooksLikeArRelationChain(receiver)) return true;
  const tail = RECEIVER_TAIL.exec(receiver)?.[1];
  if (tail === undefined || ctx.structuredReturnTypes === undefined) return false;
  const shape = tailShapes(ctx.structuredReturnTypes).get(tail);
  return (relationMember && shape === "relation") || (attachmentMember && shape === "attachment");
}

export function rubyResidualExclusion(call: CallRef, ctx: CallContext): ResidualExclusionRule | null {
  const { receiver } = call;
  if (receiver === null) return null;
  if (isModelColumnRead(call, receiver, ctx)) return "schemaColumn";
  if (isFrameworkMember(call, receiver, ctx)) return "frameworkMember";
  return null;
}
