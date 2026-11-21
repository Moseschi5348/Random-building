# Authentication integration

The browser must communicate with the application server, never directly with the student database. Serve these pages and the API from the same HTTPS origin so the session cookie works.

## Endpoints used by the frontend

### `POST /api/auth/login`

Request:

```json
{
  "email": "student@school.edu",
  "password": "..."
}
```

On success, return `200` and set a server-managed session cookie. The frontend does not store a password, token, or role in local storage.

Suggested cookie settings: `HttpOnly; Secure; SameSite=Lax; Path=/`, with a strong, unguessable session identifier and an appropriate expiry.

Return `401` for invalid credentials without revealing whether the email or password was incorrect. Return `429` when rate-limiting sign-in attempts.

### `GET /api/auth/session`

Read the session cookie and return the authenticated account:

```json
{
  "user": {
    "id": "server-assigned-id",
    "displayName": "Jordan Miller",
    "role": "student",
    "permissions": ["student-life:read"]
  }
}
```

Return `401` when there is no valid session. Return `403` when the account is authenticated but is not authorized to access a resource. The dashboard calls this endpoint before showing its contents and expects the `student-life:read` permission. Treat these UI checks as a convenience only; the server must independently enforce the same permission on protected APIs.

### `POST /api/auth/logout`

Invalidate the server-side session, expire the session cookie, and return a successful `2xx` response. The dashboard calls this when the user signs out.

### `GET /api/student-life/notices`

Require a valid session and the `student-life:read` permission. Return active notices visible to that account:

```json
{
  "notices": [
    {
      "level": "important",
      "title": "Schedule update",
      "message": "The Robotics Club will meet in room 214 today."
    }
  ]
}
```

`level` must be `emergency`, `important`, or `general`. The frontend sorts emergency notices first and uses stronger visual contrast for them. An empty list means no active school notices. Do not send an empty list when the notice service is unavailable; return an error so the UI can say it could not load notices rather than imply there is no emergency.

## Backend security responsibilities

- Enforce authentication and role/record-level authorization on every protected API request. Frontend visibility checks are only for user experience and are not an authorization boundary.
- Validate all inputs and derive user identity, roles, points, attendance dates, and membership ownership from the authenticated server session—not request-supplied values.
- Use HTTPS, secure password hashing, rate limits, safe session rotation/expiry, and CSRF protections for state-changing endpoints.
- Use parameterized database operations and server-side validation/transactions to protect record integrity; keep an audit trail for attendance and reward changes.
- Do not return student data to accounts that are not authorized to see it.

The dashboard's existing club and attendance interactions are a visual prototype and currently update browser-local demo state. They are not authoritative records. Before connecting real student data, replace those demo actions with authorized server endpoints and use server responses as the source of truth.
