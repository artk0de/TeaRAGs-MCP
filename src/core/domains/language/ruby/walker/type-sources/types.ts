import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import type { RubyExtractInput } from "../walker.js";

/** One receiver-type fact a source attributes to a symbol coordinate. */
export interface RubyTypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  /** Source name that produced this fact — used for precedence resolution in RubyTypeFactStore. */
  source?: string;
  /** Enclosing class/module FQ scope, e.g. ["Octokit","Client"]. */
  symbolScope: string[];
  /** Owning def short name (param/return/local). Undefined for class-level ivar/attr. */
  methodName?: string;
  /** Param / ivar / local var name. Undefined for `return`. */
  name?: string;
  /** 1-based source line for position-scoped inline facts; undefined for sidecar/name-keyed facts. */
  line?: number;
  type: RubyTypeRef;
}

/** A type source colocated in the `.rb` file (YARD comments, Sorbet `sig {}` / `T.let`). */
export interface RubyInlineTypeSource {
  readonly name: string;
  extract: (input: RubyExtractInput) => RubyTypeFact[];
}

/** A type source living in separate signature files (`sig/*.rbs`, `sorbet/rbi/`). */
export interface RubySidecarTypeSource {
  readonly name: string;
  extractProject: (ctx: ProjectTypeSourceContext) => RubyTypeFact[];
}

/** Inputs a sidecar source receives once per project (pre-pass). */
export interface ProjectTypeSourceContext {
  /** Absolute project root. */
  projectRoot: string;
  /** Relative paths of the `.rb` files being indexed (join target by FQ name). */
  rubyFiles: readonly string[];
}
