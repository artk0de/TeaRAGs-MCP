The abstraction still assumes an OAuth-style token lifecycle in both its contracts and its session execution.

- **Result contract:** [`AuthResult`](src/auth/contracts.ts:1) requires `accessToken` and `expiresAt`, with an optional `refreshToken`. Every provider must represent its credentials as an expiring access token.
- **Provider contract:** [`Authenticator`](src/auth/contracts.ts:6) requires `refresh(refreshToken: string)` for every provider, even providers that cannot refresh.
- **Login path:** [`SessionService.login`](src/auth/session/SessionService.ts:7) stores the authentication result and returns only `result.accessToken`.
- **Renewal path:** [`SessionService.renew`](src/auth/session/SessionService.ts:12) implements the token lifecycle directly: a missing session throws `"missing session"`; an unexpired session returns its existing access token; an expired session requires a refresh token or throws `"refresh token required"`. With a refresh token, it calls the provider’s `refresh`, replaces the stored result, and returns the new access token. Equality with `expiresAt` counts as expired.

For **API-key authentication**, [`ApiKeyAuthenticator.authenticate`](src/auth/providers/ApiKeyAuthenticator.ts:4) simply wraps the supplied key as `accessToken`, sets `expiresAt` to `Number.MAX_SAFE_INTEGER`, and supplies no refresh token. This method performs no key validation. [`SessionService.createDefault`](src/auth/session/SessionService.ts:5) selects this provider.

Consequently, ordinary API-key renewal just returns the same key while `now < Number.MAX_SAFE_INTEGER`. At or beyond that expiry value, renewal throws `"refresh token required"` before calling the provider. The provider’s mandatory [`refresh`](src/auth/providers/ApiKeyAuthenticator.ts:7) method itself always throws `"API keys do not refresh"`.

The [`controller`](src/auth/AuthController.ts:4) delegates login and renewal directly to the session service, so it adds no provider-specific handling. API keys fit the abstraction through a practically non-expiring token representation, rather than through an explicit non-refreshable credential contract.
