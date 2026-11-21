# Google sign-in

DIS uses Google OAuth sign-in. Any Google account can sign in; there is no NUTM domain restriction, password form, or email OTP. Google verifies the account email before DIS creates or links a user record.

## Google Cloud setup

1. In Google Cloud Console, configure the OAuth consent screen for an external app. Request only the `openid`, `email`, and `profile` scopes. Add test users while the app is in testing; publish it when ready for general use.
2. Create an OAuth client ID for a **Web application**.
3. Add the exact callback URL to the OAuth client’s authorized redirect URIs:
   - Local: `http://localhost:3000/api/auth/google/callback`
   - Production: `https://YOUR-VERCEL-DOMAIN/api/auth/google/callback`
4. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` in the server environment. Set `GOOGLE_CALLBACK_URL` to the exact production callback URL. Keep the client secret only in Vercel’s encrypted environment variables.

The OAuth state and nonce are random, short-lived, HTTP-only cookies. The backend verifies Google’s ID-token signature, audience, nonce, and verified email before creating a session. New users receive the `STUDENT` role. If an existing DIS account has the same verified email, Google sign-in links it while preserving its role; an account already linked to a different Google identity is rejected.

## Admin account

Set `ADMIN_EMAIL` to the Google account that should administer DIS and run `npm run db:seed` once after applying database migrations. That Google account receives the `ADMIN` role on its first sign-in.

## Session behavior

- The backend issues an HTTP-only session cookie after a successful Google callback.
- State-changing API calls require the session-bound CSRF token returned by `GET /api/auth/session`.
- Sessions expire after eight hours; only hashes of session tokens are stored in PostgreSQL.
- Google OAuth credentials and database credentials must remain server-side. The Google client ID is public; the client secret is not.
