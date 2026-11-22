# DIS backend

Backend API for clubs, activity registration, optional Stripe payments, attendance, points, badges, and Google sign-in.

GitHub stores this project's source code and migrations. Student and activity records are stored in the managed PostgreSQL database configured by `DATABASE_URL`.

## Requirements

- Node.js 20+
- Managed PostgreSQL
- A Google Cloud OAuth web client

## Setup

1. Install packages with `npm install`.
2. Create a Google OAuth client for a web application. Add `http://localhost:3000/api/auth/google/callback` as an authorized redirect URI for local development.
3. Copy `.env.example` to `.env`. Set the database URLs and Google OAuth client ID/secret/callback URL. Stripe keys are optional; without them, paid registrations and Stripe webhooks are disabled while free sign-ups and Google sign-in continue to work. Keep secrets server-side; never commit `.env` or put credentials in frontend code. See [AUTH-INTEGRATION.md](./AUTH-INTEGRATION.md) for Google Cloud setup.
4. Run `npx prisma migrate deploy` to apply the database migrations.
5. Set `ADMIN_EMAIL` to the administrator's Google account email. That verified Google account receives the administrator role when it signs in. You can also run `npm run db:seed` to create or promote the administrator record before first sign-in.
6. Run `npm run dev` and open `http://localhost:3000`. The Express server serves the frontend and API from the same origin.

Any Google account with a verified email can sign in; DIS does not restrict email domains or independently verify school enrollment. New accounts receive the `STUDENT` role. Existing user and activity records are preserved by the Google sign-in migration; password sign-in is no longer available.

For production, use HTTPS, Google OAuth credentials stored in the host's secret manager, and a production managed PostgreSQL URL. Configure production Stripe keys only if enabling paid memberships or activity registrations.

## Deploy to Vercel with Supabase Postgres

The Express app is recognized by Vercel through `src/server.ts`; Vercel runs it as a Function. Static pages, scripts, styles, and fonts live under `public/` so Vercel can serve them from its CDN.

1. Import this GitHub repository into Vercel. Use the repository root as the project root and Node.js 20 or newer.
2. In Vercel project settings, add the app's environment variables: `DATABASE_URL`, `DIRECT_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`, `CLIENT_URL`, `CORS_ORIGIN`, and optionally `ADMIN_EMAIL`. Keep secrets in Vercel's encrypted environment-variable settings. The callback URL must exactly match the Google OAuth client's authorized redirect URI. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are optional; paid registrations are unavailable unless both are set.
3. In Supabase's **Connect** dialog, copy the **Transaction pooler** URL for `DATABASE_URL` (port `6543`) and add `pgbouncer=true&connection_limit=1`. Copy the **Session pooler** URL for `DIRECT_URL` (port `5432`). Use the exact host and username Supabase provides; do not share the database password.
4. Set `CLIENT_URL` and `CORS_ORIGIN` to the deployed HTTPS origin. Vercel supplies the runtime port.
5. Apply schema migrations once with `npx prisma migrate deploy` using `DIRECT_URL`, then run `npm run db:seed` once with `ADMIN_EMAIL` set. Do not run development migrations against production.
6. Deploy with `npm run build`. Vercel serves the app through its Express Function and the static frontend through `public/`.

The Prisma datasource uses `DATABASE_URL` for application queries and `DIRECT_URL` for migrations. If Stripe payments are enabled in production, use a live Stripe secret key; test keys are rejected when `NODE_ENV` is `production`.

When Stripe payments are enabled, test webhooks can be forwarded locally with:

```text
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by Stripe CLI.

## Main endpoints

All API paths are under `/api`.

| Method | Path | Access |
| --- | --- | --- |
| GET | `/auth/google` | Public; starts Google OAuth |
| GET | `/auth/google/callback` | Public; verifies Google identity and creates session |
| GET | `/auth/session` | Signed-in user |
| POST | `/auth/logout` | Signed-in user; CSRF protected |
| GET | `/admin/overview` | Administrator; account totals and paginated participation directory |
| GET | `/me` | Signed-in user |
| GET | `/clubs` | Public |
| POST | `/clubs` | Administrator |
| POST | `/clubs/:clubId/join` | Signed-in user |
| GET | `/clubs/:clubId/activities` | Public |
| POST | `/clubs/:clubId/activities` | Club leader for that club or administrator |
| POST | `/activities/:activityId/register` | Signed-in user |
| POST | `/activities/:activityId/attendance` | Club leader for that club or administrator |
| GET | `/leaderboard` | Signed-in user |
| PATCH | `/users/:userId/role` | Administrator |
| POST | `/webhooks/stripe` | Stripe-signed webhook |
| GET | `/student-life/notices` | Signed-in user |
| POST | `/student-life/notices` | Administrator |

The browser uses an HTTP-only session cookie and a CSRF token for state-changing requests. New accounts are students; administrators assign club-leader roles. A club leader must be assigned the `CLUB_LEADER` role before an administrator can create a club for them.

Membership and activity fees are one-time charges set in cents by administrators and club leaders, never accepted from checkout requests. Paid sign-ups return a Stripe Checkout URL and remain pending until a signed, verified Stripe webhook confirms payment. The API does not collect or store card details. Free sign-ups are confirmed immediately.

Attendance awards 10 participation points, plus 5 for punctuality and 3 for good conduct. Badges are awarded at 10 attendances, 5 punctual attendances, and 5 good-conduct attendances.

## Security baseline

- Google sign-in validates the OAuth state, nonce, token audience/signature, and verified email.
- Administrator account totals and student participation details are available only to authenticated administrators.
- Password and OTP sign-in endpoints have been removed; Google OAuth credentials are used only on the backend.
- Browser sessions expire after eight hours; only hashes of session tokens are stored in PostgreSQL.
- Helmet, exact-origin CORS, request-size limits, CSRF protections, and role/record-level authorization protect API requests.
- Stripe Checkout is hosted by Stripe. Webhook signatures and payment amount/currency are validated before activating registrations.
