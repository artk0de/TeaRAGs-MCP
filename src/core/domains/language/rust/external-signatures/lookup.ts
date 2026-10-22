/**
 * The `RustExternalSignatureTable` port over one extraction's data — the shape
 * a disk cache round-trips through JSON, so every read is `Object.hasOwn`-guarded
 * (a member named `constructor` must not answer `Object.prototype`'s).
 */
import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type {
  RustClosedAssoc,
  RustExternalMember,
  RustExternalSignatureTable,
  RustExternalSignatureTableData,
  RustExternalTypeExpr,
} from "../../../../contracts/index.js";
import { rustImportBindings } from "../resolver/strategies/shared.js";
import { rustUseTargetSegments } from "./canonical-paths.js";

const STD_PRELUDE_MODULES = ["std::prelude::rust_2024", "std::prelude::rust_2021", "std::prelude::v1"];

export class RustExternalSignatureLookup implements RustExternalSignatureTable {
  constructor(
    private readonly data: RustExternalSignatureTableData,
    readonly identity: string,
  ) {}

  /**
   * A spelling as the caller wrote it: a full path, a head bound by one of the
   * caller's `use` declarations (named, aliased, grouped or glob), or a bare std
   * prelude name. A `crate::` / `self::` / `super::` import names project code
   * and answers nothing; so does a spelling the table has no public path for.
   */
  canonicalType(spelling: string, importText: readonly string[]): string | undefined {
    const direct = this.path(spelling);
    if (direct !== undefined) return direct;
    const [head, ...rest] = spelling.split("::");
    const bindings = importText.flatMap((text) => rustImportBindings(text) ?? []).filter((b) => b.prefix === null);
    for (const binding of bindings) {
      if (binding.globImport || binding.localName !== head) continue;
      const found = this.path([...rustUseTargetSegments(binding), ...rest].join("::"));
      if (found !== undefined) return found;
    }
    for (const binding of bindings) {
      if (!binding.globImport) continue;
      const found = this.path([...binding.moduleSegments, spelling].join("::"));
      if (found !== undefined) return found;
    }
    if (rest.length > 0) return undefined;
    for (const prelude of STD_PRELUDE_MODULES) {
      const found = this.path(`${prelude}::${spelling}`);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  inherentMember(typePath: string, member: string): RustExternalMember | "ambiguous" | undefined {
    return identifierEntry(identifierEntry(this.data.types, typePath)?.inherent, member);
  }

  associatedType(typePath: string, assoc: RustClosedAssoc): RustExternalTypeExpr | undefined {
    const found = identifierEntry(identifierEntry(this.data.types, typePath)?.associated, assoc);
    return found === "ambiguous" ? undefined : found;
  }

  field(typePath: string, field: string): RustExternalTypeExpr | undefined {
    return identifierEntry(identifierEntry(this.data.types, typePath)?.fields, field);
  }

  alias(typePath: string): RustExternalTypeExpr | undefined {
    return identifierEntry(this.data.aliases, typePath);
  }

  private path(spelling: string): string | undefined {
    return identifierEntry(this.data.paths, spelling);
  }
}
