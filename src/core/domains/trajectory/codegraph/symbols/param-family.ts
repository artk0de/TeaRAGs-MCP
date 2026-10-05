/**
 * Which extractions feed the interprocedural PARAMETER family (bd
 * tea-rags-mcp-bvalc), and the facts each one contributes — one answer shared by
 * `CodegraphRunState#absorb` (a walked file) and `buildPass1Aggregates` (the
 * persisted slice an unwalked file is hydrated from), so a full run and an
 * incremental one cannot disagree about membership (bd tea-rags-mcp-m99j1.1.17).
 *
 * Every key here is the walker's own spelling (the key contract on
 * `KnownTargetCallArgs`); nothing below re-spells one. The only per-language
 * fact the family needs is WHERE that language addresses its class fields,
 * because a derived field must land on the channel the language's resolver
 * reads, and the same channel decides which fields count as already typed.
 */
import type {
  ChunkExtraction,
  ClassFieldParamLink,
  FileExtraction,
  KnownTargetCallArgs,
} from "../../../../contracts/types/codegraph.js";

/**
 * The class-field channel a language's walker types fields on:
 *  - `perFile` — `FileExtraction.classFieldTypes`, keyed by the class key and
 *    handed to pass-2 per file. A class may be reopened across files, so the
 *    coordinates it typed are collected per file into the run-global
 *    `typedClassFields` gate.
 *  - `classKeyed` — the run-global, hydrated `classFieldTypesByClassKey`. The
 *    map is complete at the barrier, so its own keys ARE the gate and nothing
 *    is collected per file.
 */
export type ParamFamilyFieldChannel = "perFile" | "classKeyed";

/** The languages whose walker feeds the family, by the channel their fields live on. */
const PARAM_FAMILY_FIELD_CHANNEL: Readonly<Record<string, ParamFamilyFieldChannel>> = {
  ruby: "perFile",
  python: "classKeyed",
};

/** The channel `language` types its class fields on, or `undefined` when the language is not in the family. */
export function paramFamilyFieldChannelOf(language: string): ParamFamilyFieldChannel | undefined {
  return Object.hasOwn(PARAM_FAMILY_FIELD_CHANNEL, language) ? PARAM_FAMILY_FIELD_CHANNEL[language] : undefined;
}

/** The fold coordinate of the def a chunk holds: the walker's spelling, else its symbolId. */
export function paramCoordinateOf(chunk: Pick<ChunkExtraction, "symbolId" | "paramCoordinate">): string {
  return chunk.paramCoordinate ?? chunk.symbolId;
}

/** One file's contribution to the family. */
export interface ParamFamilyFacts {
  readonly fieldChannel: ParamFamilyFieldChannel;
  readonly knownTargetCallArgs: readonly KnownTargetCallArgs[] | undefined;
  /** `paramCoordinate → positional param names`, in chunk order. */
  readonly methodParamNames: Record<string, readonly string[]>;
  readonly classFieldParamLinks: Record<string, Record<string, ClassFieldParamLink>> | undefined;
  /** `"<classKey>|<field>"` the walker typed on its own; always empty for a `classKeyed` language. */
  readonly typedClassFields: string[];
}

/** The family's facts in `extraction`, or `undefined` when its language is not in the family. */
export function paramFamilyFactsOf(
  extraction: Pick<FileExtraction, "language" | "chunks" | "classFieldParamLinks" | "classFieldTypes"> & {
    readonly knownTargetCallArgs?: readonly KnownTargetCallArgs[];
  },
): ParamFamilyFacts | undefined {
  const fieldChannel = paramFamilyFieldChannelOf(extraction.language);
  if (fieldChannel === undefined) return undefined;
  const methodParamNames: Record<string, readonly string[]> = {};
  for (const chunk of extraction.chunks) {
    if (chunk.paramNames !== undefined) methodParamNames[paramCoordinateOf(chunk)] = chunk.paramNames;
  }
  const typedClassFields: string[] = [];
  if (fieldChannel === "perFile") {
    for (const [classKey, fields] of Object.entries(extraction.classFieldTypes ?? {})) {
      for (const field of Object.keys(fields)) typedClassFields.push(`${classKey}|${field}`);
    }
  }
  return {
    fieldChannel,
    knownTargetCallArgs: extraction.knownTargetCallArgs,
    methodParamNames,
    classFieldParamLinks: extraction.classFieldParamLinks,
    typedClassFields,
  };
}
