# DIS backend

Backend API for club discovery, membership and activity registration, Stripe payments, attendance, points, and badges.

## Requirements

- Node.js 20+
- PostgreSQL
- A Stripe account (test mode is sufficient for local development)

## Local setup

1. Install packages: `npm install`
2. Copy `.env.example` to `.env` and set the database URL, a random JWT secret of at least 32 characters, Stripe test keys, and the frontend URL/origin.
3. Create the PostgreSQL database named in `DATABASE_URL`.
4. Run `npx prisma migrate dev --name init`.
5. Set `ADMIN_EMAIL` and a strong `ADMIN_PASSWORD`, then run `npm run db:seed`.
6. Start the API with `npm run dev`.

The API listens on port 3000 by default. `GET /health` checks that the process is responding. Stripe test webhooks can be forwarded with:

```text
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by Stripe CLI. Never commit `.env` or use test keys in production.

## Main endpoints

All API paths are under `/api`.

| Method | Path | Access |
| --- | --- | --- |
| POST | `/auth/register`, `/auth/login` | Public |
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

Use `Authorization: Bearer <accessToken>` for signed-in routes. New accounts are students; administrators assign club leader and administrator roles. A club leader must be assigned the `CLUB_LEADER` role before an administrator can create a club for them.

Membership and activity fees are one-time charges set in cents by administrators and club leaders, never accepted from checkout requests. Paid sign-ups return a Stripe Checkout URL and remain pending until a signed, verified Stripe webhook confirms payment. The API does not collect or store card details. Free sign-ups are confirmed immediately.

Attendance awards 10 participation points, plus 5 for punctuality and 3 for good conduct. Badges are awarded at 10 attendances, 5 punctual attendances, and 5 good-conduct attendances.

## Security baseline

- Passwords are hashed with bcrypt; role assignment is never accepted at public registration.
- Authenticated requests reload the current user role from PostgreSQL; access tokens expire after 15 minutes by default.
- Helmet, exact-origin CORS, request-size limits, and rate limits protect API requests. Authentication endpoints have a stricter rate limit.
- Stripe Checkout is hosted by Stripe. Webhook signatures and payment amount/currency are validated before activating registrations.
- Keep secrets in environment variables or a deployment secret manager. Configure HTTPS and production CORS origins before deployment.
