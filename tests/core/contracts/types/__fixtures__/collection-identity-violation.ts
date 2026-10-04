/**
 * Harness self-check for `collection-identity.test.ts` (bd tea-rags-mcp-39xca.1).
 *
 * Deliberately wrong: a string literal typed as a physical name. The test
 * requires exactly one TS2322 here, which proves the compile step reports type
 * errors at all — without it, a harness that silently stopped checking (a
 * missing file, `noCheck`, a wrong root) would pass the boundary fixture too.
 */

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import type { PhysicalCollectionName } from "../../../../../src/core/contracts/types/collection-identity.js";

export const leakedAlias: PhysicalCollectionName = fixturePhysicalCollectionName("code_8b243ffe");
