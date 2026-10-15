import { rmSync } from "node:fs";

import type { CollectionArtifact, FootprintContext } from "./artifact.js";

/**
 * The residual-resolution verdict store of a logical collection. Its verdicts
 * are keyed by call-site content, not by generation, so a clone copies nothing
 * and only the collection's removal deletes the file.
 */
export class ResidualVerdictsArtifact implements CollectionArtifact {
  readonly id = "residual-verdicts" as const;
  readonly addressing = "logical" as const;
  constructor(private readonly fileFor: (logicalName: string) => string) {}

  async clone(): Promise<void> {
    // Nothing to copy — see the class docblock.
  }

  async remove(ctx: FootprintContext): Promise<void> {
    const file = this.fileFor(ctx.target.logicalName);
    rmSync(file, { force: true });
    rmSync(`${file}.wal`, { force: true });
  }
}
