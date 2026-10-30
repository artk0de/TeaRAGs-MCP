Move concrete provider wiring into an outer composition module, and remove local session revocation from the provider.

The root cause is a dependency cycle:

- [`SessionService.createDefault()`](src/auth/session/SessionService.ts:5) constructs `ApiKeyAuthenticator`.
- [`ApiKeyAuthenticator.revokeLocalSession()`](src/auth/providers/ApiKeyAuthenticator.ts:10) accepts `SessionService` and calls `logout()`.

The architecture report judged all four component dependencies across three components. It found one stable-dependencies violation: session → providers, with instability rising from 0.25 to 0.75. There is no co-change history, so these metrics establish structural coupling rather than measured maintenance impact.

The proposed order is:

1. **Move default construction outward.** Extract `createDefault()` into a proposed `src/auth/composition/createDefaultSessionService.ts`. It should construct `new SessionService(new ApiKeyAuthenticator())`. Remove the concrete-provider import from `SessionService`; retain its existing `Authenticator` constructor parameter.

2. **Keep local session lifecycle in the session/application layer.** Remove `ApiKeyAuthenticator.revokeLocalSession()` and migrate its callers to `SessionService.logout()` through application orchestration. [`AuthController.logout()`](src/auth/AuthController.ts:6) already provides that delegation. The provider method only deletes local session state; it performs no provider-side revocation.

3. **Keep the shared contracts stable.** Retain `Authenticator` and `AuthResult` in [`contracts.ts`](src/auth/contracts.ts:1). No additional interface is needed for the current behavior.

The concrete candidate operations are:

```text
removeEdge src/auth/session/SessionService.ts
        -> src/auth/providers/ApiKeyAuthenticator.ts
removeEdge src/auth/providers/ApiKeyAuthenticator.ts
        -> src/auth/session/SessionService.ts
addFile   src/auth/composition/createDefaultSessionService.ts
addEdge   composition/createDefaultSessionService.ts -> session/SessionService.ts
addEdge   composition/createDefaultSessionService.ts -> providers/ApiKeyAuthenticator.ts
```

The target direction is composition → session and provider, with session and provider depending on shared contracts.

The combined extraction simulation reported **one stable-dependencies violation resolved and none introduced**. The planning call did not return ordered steps, so the order above is a recommendation, not a server-validated sequence. Caller queries also returned no usable fixture edges; caller migration remains an implementation check.

During implementation, verify default construction, login, renewal, and logout behavior, then compare the architecture review against the expected resolution. Any unexpected finding should trigger a revised plan before continuing.

No files were edited.
