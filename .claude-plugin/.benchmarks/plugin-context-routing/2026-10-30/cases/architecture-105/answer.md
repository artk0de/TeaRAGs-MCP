`src/auth/**` has **one stable-dependency violation and one root cause**: session and provider components depend on each other.

The root cause is `src/auth/providers`, with instability **0.75**, while its dependent `src/auth/session` has instability **0.25**. The dependency crosses sibling components, with a delta of **0.50**.

Source evidence confirms both directions:

- [SessionService.ts:5](src/auth/session/SessionService.ts#L5): `createDefault()` constructs `ApiKeyAuthenticator`, coupling session code to a concrete provider.
- [ApiKeyAuthenticator.ts:10](src/auth/providers/ApiKeyAuthenticator.ts#L10): `revokeLocalSession()` calls `SessionService.logout()`, creating the reverse dependency.
- [SessionService.ts:6](src/auth/session/SessionService.ts#L6): the constructor already accepts `Authenticator`, providing an existing abstraction for decoupling.

The repair direction is to supply the provider through that constructor and remove the provider’s knowledge of `SessionService`. No changes or remedy simulations were performed.

The report judged **4 of 4 component dependencies across 3 components**, excluding zero containment dependencies, low-support dependencies, tooling files, or test-support files. Impact tiers were **not built because there is no co-change history**, so urgency is unproven despite the row’s `structural` label. Other detector results were absent; they cannot be declared clean.
