`src/auth` flows from **`AuthController` → `SessionService` → an `Authenticator` provider**. The service owns session state and coordinates authentication.

| Component | Current responsibility |
|---|---|
| [AuthController](src/auth/AuthController.ts:3) | Request-facing entry within this module. Receives a `SessionService` and delegates `login`, `renew`, and `logout` directly to it. |
| [Provider contract](src/auth/contracts.ts:1) | `Authenticator` exposes asynchronous `authenticate(input)` and `refresh(refreshToken)`. Both return `AuthResult`: an access token, optional refresh token, and expiry timestamp. |
| [SessionService](src/auth/session/SessionService.ts:7) | Stores and retrieves sessions by ID, decides whether renewal is needed, and removes sessions on logout. Its constructor accepts the provider interface; `createDefault()` supplies `ApiKeyAuthenticator`. |
| [ApiKeyAuthenticator](src/auth/providers/ApiKeyAuthenticator.ts:4) | Returns the supplied key as the access token, with `Number.MAX_SAFE_INTEGER` as expiry and no refresh token. Its `refresh()` throws. |

The calls behave as follows:

- **Login:** controller → service → provider’s `authenticate()` → service stores the result under the session ID → returns the access token.
- **Renew:** controller → service looks up the session. A valid session returns its existing token. An expired session requires a refresh token, calls the provider’s `refresh()`, and replaces the stored result. Missing sessions or refresh tokens throw. See [renew](src/auth/session/SessionService.ts:12).
- **Logout:** controller → service → deletes the session entry. The controller returns no value. See [logout](src/auth/session/SessionService.ts:21).

For logout UX, the key boundary is that **logout currently removes local session state only**. The provider contract has no logout or revocation operation. There is also a concrete-provider helper, [`revokeLocalSession()`](src/auth/providers/ApiKeyAuthenticator.ts:10), that calls back into `SessionService.logout()`; the controller’s logout path does not use it.

These flows are verified from method bodies; the graph tool returned no edge data for the queried entry points.
