import { describe, expect, it } from "vitest";

import { CollectionNotFoundError, ExploreError } from "../../../../src/core/domains/explore/errors/explore-errors.js";
import { CollectionNotFoundError as ErrorCollectionNotFoundError } from "../../../../src/core/domains/explore/errors/index.js";
import { CollectionNotFoundError as DomainCollectionNotFoundError } from "../../../../src/core/domains/explore/index.js";
import { TeaRagsError } from "../../../../src/core/primitives/errors/index.js";

describe("shared collection-not-found input error compatibility", () => {
  it("keeps one constructor and the existing public error shape through the old domain export", () => {
    expect(DomainCollectionNotFoundError).toBe(CollectionNotFoundError);
    expect(ErrorCollectionNotFoundError).toBe(CollectionNotFoundError);
    const error = new CollectionNotFoundError("code_existing");
    expect(error).toBeInstanceOf(ExploreError);
    expect(error).toBeInstanceOf(TeaRagsError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CollectionNotFoundError");
    expect(error.code).toBe("EXPLORE_COLLECTION_NOT_FOUND");
    expect(error.message).toBe('Collection "code_existing" not found');
    expect(error.hint).toBe("Run index_codebase first to create and populate the collection");
    expect(error.httpStatus).toBe(404);
  });
});
