/**
 * What a type source produces and what shape a type source has (E1 seam 2,
 * relocated from `ruby/walker/type-sources/types.ts`).
 *
 * A `TypeFact` is one receiver-type claim at one symbol coordinate. Facts are
 * language-neutral: the SOURCE names (`"yard"`, `"annotations"`, `"docstring"`)
 * and their precedence are the language's data, resolved by `TypeFactStore`
 * against the order that language injects. The kernel never decides that a
 * `sig` outranks an inferred assignment.
 */
import type { TypeRef } from "../../../contracts/types/language.js";

/** One receiver-type fact a source attributes to a symbol coordinate. */
export interface TypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  /** Source name that produced this fact — used for precedence resolution in {@link TypeFactStore}. */
  source?: string;
  /** Enclosing class/module FQ scope, e.g. ["Octokit","Client"]. */
  symbolScope: string[];
  /** Owning def short name (param/return/local). Undefined for class-level ivar/attr. */
  methodName?: string;
  /** Param / ivar / local var name. Undefined for `return`. */
  name?: string;
  /**
   * `true` when the fact documents a CLASS-level member (Ruby `@!method
   * self.call`, Python `@classmethod`) rather than an instance one. The store
   * then joins the coordinate with `.` instead of `#`, keeping `Class.call` and
   * `Class#call` — genuinely different methods — from overwriting each other
   * (bd tea-rags-mcp-8ypeu).
   */
  classForm?: boolean;
  /** 1-based source line for position-scoped inline facts; undefined for sidecar/name-keyed facts. */
  line?: number;
  type: TypeRef;
}

/**
 * A type source colocated in the source file itself (Ruby YARD comments and
 * Sorbet `sig {}`, Python annotations and docstrings). Generic over the
 * language's extract input so the kernel never names a language's walker type.
 */
export interface InlineTypeSource<TInput> {
  readonly name: string;
  extract: (input: TInput) => TypeFact[];
}

/** Inputs a sidecar source receives once per project (pre-pass). */
export interface ProjectTypeSourceContext {
  /** Absolute project root. */
  projectRoot: string;
  /** Relative paths of the source files being indexed (join target by FQ name). */
  files: readonly string[];
}

/**
 * A type source living in separate signature files (`sig/*.rbs`, `sorbet/rbi/`,
 * `*.pyi` stubs). Runs once per project, not once per file.
 */
export interface SidecarTypeSource {
  readonly name: string;
  extractProject: (ctx: ProjectTypeSourceContext) => TypeFact[];
}
