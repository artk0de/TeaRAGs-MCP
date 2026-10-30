`src/auth` centers on **`SessionService`**, with a thin controller in front and an interchangeable authentication provider behind it.

| Component | Current responsibility |
|---|---|
| Request entry: `AuthController` | Receives `login`, `renew`, and `logout` calls and delegates directly to its injected session service. |
| Provider contract: `Authenticator` | Defines asynchronous `authenticate(input)` and `refresh(refreshToken)`. Both return `AuthResult`: an access token, optional refresh token, and expiry. |
| Session owner: `SessionService` | Stores authentication results by session ID, decides whether renewal is necessary, and deletes sessions on logout. |
| Default provider: `ApiKeyAuthenticator` | Returns the supplied key as the access token with `Number.MAX_SAFE_INTEGER` expiry. Its refresh method throws `"API keys do not refresh"`. |

Sources: [controller](src/auth/AuthController.ts:3), [contracts](src/auth/contracts.ts:1), [session service](src/auth/session/SessionService.ts:7), [provider](src/auth/providers/ApiKeyAuthenticator.ts:4).

The calls flow as follows:

- **Login:** controller → session service → provider’s `authenticate` → service stores the result → access token returns to the caller.
- **Renew:** controller → session service → return the cached token if unexpired; otherwise require a refresh token, call the provider’s `refresh`, store the replacement result, and return its access token. Missing sessions and missing refresh tokens throw errors. [Renewal logic](src/auth/session/SessionService.ts:12)
- **Logout:** controller → session service → delete the session entry. The operation is synchronous and performs no provider revocation. [Logout](src/auth/session/SessionService.ts:21)

Construction uses dependency injection: the service accepts an `Authenticator`, while `createDefault()` supplies an `ApiKeyAuthenticator`. The provider also exposes `revokeLocalSession(service, id)`, which calls back into `SessionService.logout`; this helper sits outside the provider interface. [Construction](src/auth/session/SessionService.ts:5), [callback](src/auth/providers/ApiKeyAuthenticator.ts:10)

For logout UX, the key existing behavior is **local session deletion with no returned status**. Call relationships above are verified from method bodies; the graph lookup returned no edge data.
