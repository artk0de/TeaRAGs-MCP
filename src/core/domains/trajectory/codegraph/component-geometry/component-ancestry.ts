/**
 * The constant-path separator a qualified scope name nests by (`Billing::Invoice`).
 * `.` is not one: a symbol id uses it for class-level members.
 */
export const CONSTANT_PATH_SEPARATOR = "::";

/**
 * Prefix of a namespace component's name — Ruby's root-anchored constant
 * spelling (`::Billing`), which no repo-relative directory takes, so a
 * namespace and a directory component never share a key.
 */
export const NAMESPACE_COMPONENT_PREFIX = "::";

/** Whether a component name is a constant namespace, not a directory. */
export function isNamespaceComponent(component: string): boolean {
  return component.startsWith(NAMESPACE_COMPONENT_PREFIX);
}

/** `::Billing::Invoice` and `Billing::Invoice` → `["Billing", "Invoice"]`. */
export function constantSegments(name: string): string[] {
  return name.split(CONSTANT_PATH_SEPARATOR).filter((segment) => segment.length > 0);
}

/**
 * A component's chain in its own tree, outermost first and itself last: a
 * namespace's enclosing namespaces by constant path (`::Billing`,
 * `::Billing::Refunds`), a directory's enclosing directories by path. The
 * two trees share no node — the nesting `classifyComponentRelation`
 * judges — and the repository root (`""`) is no node of either.
 */
export function componentAncestry(component: string): string[] {
  const namespace = isNamespaceComponent(component);
  const segments = namespace ? constantSegments(component) : component.split("/").filter((s) => s.length > 0);
  const separator = namespace ? CONSTANT_PATH_SEPARATOR : "/";
  const prefix = namespace ? NAMESPACE_COMPONENT_PREFIX : "";
  return segments.map((_, i) => `${prefix}${segments.slice(0, i + 1).join(separator)}`);
}
