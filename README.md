# DIS backend

Backend API for clubs, activity registration, Stripe payments, attendance, points, badges, and school-email accounts.

GitHub stores this project's source code and migrations. Student and activity records are stored in the managed PostgreSQL database configured by `DATABASE_URL`.

## Requirements

- Node.js 20+
- Managed PostgreSQL
- A dedicated Gmail account with 2-Step Verification and an App Password for low-volume OTP email
- A Stripe account (test mode is sufficient for local development)

## Setup

1. Install packages with `npm install`.
2. Create a dedicated Gmail sender account, enable 2-Step Verification, and create an App Password in its Google Account security settings. Use the App Password, not the account's normal password. Google Workspace administrators can disable App Passwords.
3. Copy `.env.example` to `.env`. Set the managed database URL, a random `OTP_HASH_SECRET` of at least 32 characters, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and Stripe test keys. Keep secrets server-side; never commit `.env` or put credentials in frontend code.
4. Run `npx prisma migrate deploy` to apply the database migrations.
5. Set `ADMIN_EMAIL` to the administrator's NUTM email and run `npm run db:seed`. The administrator then registers with that address and verifies it by OTP; the seeded administrator role is retained.
6. Run `npm run dev` and open `http://localhost:3000`. The Express server serves the frontend and API from the same origin.

The backend accepts only addresses ending in `@nutm.edu.ng`. Registration sends a six-digit code through Gmail SMTP. Codes expire after ten minutes, allow at most five attempts, and are stored only as keyed hashes. Accounts are created and signed in only after email verification. Sign-in afterward uses the verified school email and password. Gmail is suitable for a low-volume pilot; use a transactional email service for higher-volume production sending.

For production, use HTTPS, production Stripe keys, the Gmail App Password stored in the host's secret manager, and a production managed PostgreSQL URL.

## Deploy to Vercel with Supabase Postgres

The Express app is recognized by Vercel through `src/server.ts`; Vercel runs it as a Function. Static pages, scripts, styles, and fonts live under `public/` so Vercel can serve them from its CDN.

1. Import this GitHub repository into Vercel. Use the repository root as the project root and Node.js 20 or newer.
2. In Vercel project settings, add the app's environment variables: `DATABASE_URL`, `DIRECT_URL`, `OTP_HASH_SECRET`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `CLIENT_URL`, `CORS_ORIGIN`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `ADMIN_EMAIL`. Keep all passwords and keys in Vercel's encrypted environment-variable settings.
3. In Supabase's **Connect** dialog, copy the **Transaction pooler** URL for `DATABASE_URL` (port `6543`) and add `pgbouncer=true&connection_limit=1`. Copy the **Session pooler** URL for `DIRECT_URL` (port `5432`). Use the exact host and username Supabase provides; do not share the database password.
4. Set `CLIENT_URL` and `CORS_ORIGIN` to the deployed HTTPS origin. Vercel supplies the runtime port.
5. Apply schema migrations once with `npx prisma migrate deploy` using `DIRECT_URL`, then run `npm run db:seed` once with `ADMIN_EMAIL` set. Do not run development migrations against production.
6. Deploy with `npm run build`. Vercel serves the app through its Express Function and the static frontend through `public/`.

The Prisma datasource uses `DATABASE_URL` for application queries and `DIRECT_URL` for migrations. Vercel deployments require a production Stripe secret key under the current configuration; Stripe test keys are rejected when `NODE_ENV` is `production`.

Stripe test webhooks can be forwarded locally with:

```text
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by Stripe CLI.

## Main endpoints

All API paths are under `/api`.

| Method | Path | Access |
| --- | --- | --- |
| POST | `/auth/register` | Public; NUTM email only, sends OTP |
| POST | `/auth/verify-email` | Public; verifies OTP and creates account |
| POST | `/auth/resend-verification` | Public; throttled |
| POST | `/auth/login` | Public; verified account required |
| GET | `/auth/session` | Signed-in user |
| POST | `/auth/logout` | Signed-in user; CSRF protected |
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

- Registration and sign-in enforce the `@nutm.edu.ng` domain server-side.
- Passwords use bcrypt; OTPs use cryptographic randomness, HMAC storage, expiry, attempt limits, and rate limits.
- Gmail SMTP credentials are used only on the backend to send mail.
- Browser sessions expire after eight hours; only hashes of session tokens are stored in PostgreSQL.
- Helmet, exact-origin CORS, request-size limits, CSRF protections, and role/record-level authorization protect API requests.
- Stripe Checkout is hosted by Stripe. Webhook signatures and payment amount/currency are validated before activating registrations.
