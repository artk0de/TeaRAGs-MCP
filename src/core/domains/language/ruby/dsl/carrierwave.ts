/**
 * CarrierWave file-upload mounting DSL. `mount_uploader :avatar, AvatarUploader`
 * synthesises the mounted column's accessor family on the model — the reader /
 * writer, the presence predicate, the `remove_<col>` removal-flag trio, and the
 * `<col>_cache` retained-upload pair:
 *
 *   avatar, avatar=, avatar?, remove_avatar, remove_avatar=, remove_avatar?,
 *   avatar_cache, avatar_cache=
 *
 * The base is the FIRST positional symbol (`:avatar`); the second positional arg
 * is the uploader CLASS constant, not a mounted column, so `operands:
 * "first-symbol"` takes only the first symbol. `mount_uploaders` (plural, an
 * array column) mounts the same accessor family.
 *
 * Gem-gated by `activatedBy {carrierwave}`: the accessor names all derive from
 * the project's own column symbol (`avatar`), so the gate — not name curation —
 * keeps the grammar off entirely for non-carrierwave projects. Every synthesised
 * name is a projection of the column base; none is a bare ubiquitous verb.
 */
import { defineFrameworkVocabulary } from "./framework-module.js";
import type { DeclaredMethodSpec } from "./types.js";

const mountedAccessors = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" },
  { name: `${b}=`, kind: "instance" },
  { name: `${b}?`, kind: "instance" },
  { name: `remove_${b}`, kind: "instance" },
  { name: `remove_${b}=`, kind: "instance" },
  { name: `remove_${b}?`, kind: "instance" },
  { name: `${b}_cache`, kind: "instance" },
  { name: `${b}_cache=`, kind: "instance" },
];

export const CARRIERWAVE_VOCABULARY = defineFrameworkVocabulary(
  "carrierwave",
  {
    mount_uploader: { category: "accessor", declares: mountedAccessors, operands: "first-symbol" },
    mount_uploaders: { category: "accessor", declares: mountedAccessors, operands: "first-symbol" },
  },
  undefined,
  { activatedBy: new Set(["carrierwave"]) },
);
