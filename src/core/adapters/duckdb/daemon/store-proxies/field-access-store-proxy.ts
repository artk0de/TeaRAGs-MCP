import type {
  CodegraphFieldAccessStore,
  FieldAccessReplaceEntry,
  RelPath,
  StoredFieldAccessRow,
  SymbolId,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/**
 * `CodegraphFieldAccessStore` over the daemon socket (field-access edges, bd
 * tea-rags-mcp-zy6hx). Readonly arrays are copied into plain arrays — the op
 * params are the wire shape.
 */
export class DaemonFieldAccessStoreProxy implements CodegraphFieldAccessStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async replaceFieldAccessesBulk(entries: readonly FieldAccessReplaceEntry[]): Promise<void> {
    await this.ops.call("replaceFieldAccessesBulk", { entries: [...entries] });
  }

  async readFieldAccessesBySymbols(symbolIds: readonly SymbolId[]): Promise<StoredFieldAccessRow[]> {
    return (await this.ops.call("readFieldAccessesBySymbols", { symbolIds: [...symbolIds] })) as StoredFieldAccessRow[];
  }

  async readFieldAccessesByFiles(relPaths: readonly RelPath[]): Promise<StoredFieldAccessRow[]> {
    return (await this.ops.call("readFieldAccessesByFiles", { relPaths: [...relPaths] })) as StoredFieldAccessRow[];
  }
}
