/**
 * The review-section registry (bd tea-rags-mcp-89k7k.1.4, F3):
 * `review_changes`' sections as independent providers behind one port.
 * `REVIEW_SECTION_PROVIDERS` is the live registry — the MCP `sections` enum
 * (`reviewSectionIds`) and the orchestration's default-all derive from it, so
 * a new section appears in the schema with no hand-edited union, and an id
 * with no provider fails loud at the boundary.
 */

import type { ReviewSectionId } from "../../../public/dto/review.js";
import { architectureSectionProvider } from "./architecture-section.js";
import { cohesionSectionProvider } from "./cohesion-section.js";
import { incompleteChangeSectionProvider } from "./incomplete-change-section.js";
import { namingSectionProvider } from "./naming-section.js";
import type {
  ReviewGraphDb,
  ReviewNamingLexicon,
  ReviewSectionBuildContext,
  ReviewSectionContext,
  ReviewSectionProvider,
} from "./review-section-provider.js";

export type {
  ReviewGraphDb,
  ReviewNamingLexicon,
  ReviewSectionBuildContext,
  ReviewSectionContext,
  ReviewSectionProvider,
};
export { architectureSectionProvider, cohesionSectionProvider, incompleteChangeSectionProvider, namingSectionProvider };

/** Every registered section, in the order a default-all review runs them. */
export const REVIEW_SECTION_PROVIDERS: readonly ReviewSectionProvider[] = [
  namingSectionProvider,
  incompleteChangeSectionProvider,
  cohesionSectionProvider,
  architectureSectionProvider,
];

/**
 * The ids the live registry ships, as the non-empty tuple `z.enum` needs. The
 * cast only elides "a literal array of providers is non-empty" — an empty
 * registry is a programming error, not a state to model.
 */
export const reviewSectionIds = REVIEW_SECTION_PROVIDERS.map((provider) => provider.id) as [
  ReviewSectionId,
  ...ReviewSectionId[],
];
