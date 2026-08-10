export { INSTANCE_METHOD_SEPARATOR, classifyMethod, isStaticMethodNode, rubyInsideSingletonClass } from "./classify.js";
export type { MethodClassification } from "./classify.js";
export { constObjectNamespaceName, constObjectNamespaceOwner } from "./const-object-namespace.js";
export {
  isFunctionValuedExpression,
  moduleLevelFunctionDeclarationNames,
  moduleLevelFunctionDeclaratorName,
} from "./const-bound-function.js";
