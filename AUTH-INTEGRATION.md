# School email and OTP authentication

The backend accepts only NUTM addresses ending in `@nutm.edu.ng`. It sends a one-time verification code to the address before creating the student account. Verification codes expire after ten minutes, are limited to five attempts, and are stored only as keyed hashes.

## Registration flow

1. The frontend submits the student's name, NUTM email, and password to `POST /api/auth/register`.
2. The backend validates the exact school email domain, stores a pending registration, and sends a six-digit code through Microsoft Graph.
3. The student submits the code to `POST /api/auth/verify-email`.
4. On successful verification, the backend creates the student account, marks the school email as verified, and sets an HTTP-only session cookie.

`POST /api/auth/resend-verification` requests a new code. A per-address cooldown applies. The frontend does not store a password or session token in local storage.

## Login and session

### `POST /api/auth/login`

Request:

```json
{
  "email": "eevans@nutm.edu.ng",
  "password": "..."
}
```

Login is allowed only for an active account with a verified school email. Invalid credentials return a generic `401`.

### `GET /api/auth/session`

Returns the current account and a session-bound CSRF token. Send the token in `X-CSRF-Token` for state-changing requests.

### `POST /api/auth/logout`

Requires the session-bound CSRF token, invalidates the server-side session, and expires the session cookie.

## Microsoft Graph mail setup

Register a confidential application in the school's Microsoft Entra tenant, grant the **Microsoft Graph `Mail.Send` application permission**, and obtain administrator consent. Configure `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, and `GRAPH_SENDER_EMAIL` in the server environment. `GRAPH_SENDER_EMAIL` must be an authorized `@nutm.edu.ng` mailbox. Set `OTP_HASH_SECRET` to a separate random value of at least 32 characters. Never put these secrets in frontend code or commit them to GitHub.

## Security responsibilities

- The backend enforces the `@nutm.edu.ng` domain; the frontend's email check is only a usability aid.
- OTPs are cryptographically random, expire after ten minutes, have a five-attempt limit, and are HMAC-hashed with a server-only secret.
- Registration and verification requests are rate-limited; sending another code is also throttled per email address.
- Session cookies are HTTP-only, `SameSite=Lax`, and `Secure` in production. Only a hash of the random session token is stored in PostgreSQL.
- Enforce authentication and role/record-level authorization on every protected API request. Frontend visibility checks are not an authorization boundary.
- Use HTTPS in production and keep database URLs, OTP secrets, Microsoft Graph credentials, Stripe keys, and webhook secrets in a deployment secret manager.
