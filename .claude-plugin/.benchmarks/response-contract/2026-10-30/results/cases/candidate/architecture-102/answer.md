`src/auth` flows from **`AuthController` → `SessionService` → `Authenticator`**, with one concrete provider helper calling back into the session service.

- **Request entry:** `AuthController` receives a `SessionService` and delegates `login`, `renew`, and `logout` directly to it. See [AuthController.ts](src/auth/AuthController.ts:3).
- **Provider contract:** `Authenticator` exposes asynchronous `authenticate(input)` and `refresh(refreshToken)`. Both return an `AuthResult` containing an access token, expiry, and optional refresh token. Logout is absent from this contract. See [contracts.ts](src/auth/contracts.ts:1).
- **Session owner:** `SessionService` stores results by session ID. Login authenticates, stores the result, and returns the access token. Renewal returns an unexpired token or refreshes and replaces the stored result; missing sessions or refresh tokens raise errors. Its default factory selects `ApiKeyAuthenticator`. See [SessionService.ts](src/auth/session/SessionService.ts:5).
- **Default provider:** `ApiKeyAuthenticator` returns the supplied key as the access token, uses `Number.MAX_SAFE_INTEGER` for expiry, and rejects refresh. Its extra `revokeLocalSession` helper calls `SessionService.logout`. See [ApiKeyAuthenticator.ts](src/auth/providers/ApiKeyAuthenticator.ts:4).

For logout UX, the current controller path synchronously deletes the local session entry; it makes no provider revocation call and returns no status. See [logout](src/auth/session/SessionService.ts:21).
