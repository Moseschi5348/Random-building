# Product Decisions & Architecture Log

This document records all architectural choices, assumptions, and design decisions made for the Single-Club Student Platform.

## 1. Domain-Restricted Sign-In
* **Recommendation:** Restrict Google Sign-In by default in production, but keep it optional/configurable via an environment variable (`ALLOWED_EMAIL_DOMAINS`).
* **Why:** In a university or school club, restricting sign-in to `@student.university.edu` or `@university.edu` prevents outside accounts from accessing internal department resources, designs, and leaderboards. Leaving the variable blank in development allows easy testing with any Google account.

## 2. Default Departments
* The 4 seeded departments are:
  1. **Design** (UI/UX, visual design, graphic arts, brand identity) - Icon: `🎨`
  2. **Development** (Web, mobile, software engineering, open source) - Icon: `💻`
  3. **Cybersecurity** (Ethical hacking, network defense, security CTFs) - Icon: `🛡️`
  4. **Media** (Content creation, video editing, social channels, photography) - Icon: `📸`
* Admins can create more departments or rename existing ones at any time.

## 3. Department Membership Policy
* **One Primary Department per Member:** Each member chooses one primary department upon joining.
* **Why:** Ensures department leaderboards and aggregate department points remain fair and statistically distinct without double-counting points across multiple groups.
* **Reassignment:** Members cannot change departments on their own once joined; only administrators can move a member to a different department.

## 4. Attendance & Punctuality Rules
* **Code-Based Check-in:** Department Heads and Admins generate a 6-digit code for active meetings.
* **Punctuality Bonus:**
  * Entering the code within the first 10 minutes of the meeting start time (`now <= startsAt + 10 mins`) awards **15 points** (10 base + 5 punctuality bonus).
  * Entering after 10 minutes (while the meeting is still active) awards **10 base points**.
* **Manual Fallback:** Department Heads can manually mark attendance for members with technical difficulties. Manual check-ins receive **10 base points** (`punctual = false`) to incentivize using the code.
* **Security & Self-Award Rules:**
  * The meeting creator / department head cannot check in to their own meeting or award points to themselves (`403 Forbidden`).
  * Admins cannot mark themselves present (`403 Forbidden`).
  * Members can only check in once per meeting (`@@unique([userId, meetingId])` $\rightarrow$ `409 Conflict`).
  * Rate limiting: max 5 code attempts per user per meeting to prevent brute-forcing.

## 5. PointTransaction Ledger & Daily Game Cap
* All points earned (meetings, quizzes, adjustments) are recorded in the `PointTransaction` table (`userId`, `amount`, `reason`, `sourceType`, `sourceId`, `createdAt`).
* `User.points` is updated in the exact same database transaction as `PointTransaction`.
* **Daily Game Cap:** Quizzes are capped at a maximum of **20 points per day** per member, calculated by querying `PointTransaction` for `sourceType = 'QUIZ_GAME'` on the current calendar day.

## 6. Quiz & Trivia Game Design
* **Server-Side Scoring Only:** The API never sends `isCorrect` to the client. Question options are served with `id` and `text` only.
* **Server-Side Timer:** A quiz attempt record tracks `startedAt`. Submissions sent after `startedAt + totalTimeLimit + gracePeriod` are rejected.
* **Initial Question Pool:** Seeded with club trivia covering Design, Web Dev, Cybersecurity, and Media.

## 7. Badges & Milestones
* Enforced with `@@unique([userId, key])` so badges can never be awarded more than once.
* **Milestones:**
  * `FIRST_STEP`: 1st meeting attended
  * `REGULAR`: 5 meetings attended
  * `COMMITTED`: 10 meetings attended
  * `EARLY_BIRD`: 5 punctual meeting attendances
  * `CENTURY_CLUB`: 100 points
  * `ACHIEVER`: 250 points
  * `CLUB_LEGEND`: 500 points
  * `CONTRIBUTOR`: 3 shared department resources (valid URL, max 1 resource counted per calendar day)
  * `QUIZ_MASTER`: 100% score on a club quiz
