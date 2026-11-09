# GYM GRID

GYM GRID is a browser-based gym membership manager. It tracks members, plans, membership terms, current status, renewals, and payment records. The frontend is plain HTML, CSS, and JavaScript; Supabase Auth and Postgres provide sign-in and persistent data.

## Project files

- `index.html` contains the login screen and the admin dashboard markup and styles.
- `supabase-app.js` handles authentication, reads, form submissions, and rendering.
- `supabase-config.js` contains the Supabase project URL and browser publishable key.
- `supabase.sql` creates the database objects, seeds starter plans, and defines access policies and database functions.
- `reset-data.sql` clears gym activity data while preserving plans and admin accounts.
- `WhatsApp Image 2026-11-09 at 3.21.13 PM.jpeg` is the local login-page image.

## Requirements

- A Supabase project with the SQL Editor and Authentication enabled.
- Python 3 (or another static HTTP server) for local development.
- Internet access for Supabase requests and the Supabase JavaScript client CDN.

## Run locally

From the project folder, start a static server:

```powershell
python -m http.server 5500
```

Open `http://127.0.0.1:5500/`. Keep using that same host and port; `localhost`, `127.0.0.1`, and `file://` have separate browser sessions. Do not open `index.html` directly as a file when testing authentication.

## Supabase setup

1. Open the intended Supabase project and run all of `supabase.sql` in **SQL Editor**. It creates the tables and functions, upserts four starter plans, applies row-level security, and notifies the REST API to refresh its schema cache.
2. In **Authentication → Users**, create the admin user and verify its email if email confirmation is enabled.
3. In SQL Editor, replace the example email and run the allowlist query:

   ```sql
   insert into public.gym_admins (user_id)
   select id
   from auth.users
   where lower(email) = lower('YOUR_ADMIN_EMAIL')
   on conflict (user_id) do nothing;
   ```

4. Sign in to GYM GRID using that Auth user's email and password.

The app's `supabase-config.js` must point to the same project where the SQL and Auth user were created. The publishable key is intended for browser use. Never put a database password, Auth user's password, or Supabase service-role key in frontend code.

## Database structure

- `plans` stores the four seeded membership options and prices in INR. Authenticated users can read plans.
- `members` stores member contact information and archive state.
- `memberships` stores each member's plan and start/end dates.
- `membership_status` is a view that calculates Upcoming, Active, or Expired status from dates.
- `renewals` records each renewal and links it to the previous and new membership terms.
- `payments` records amount, Cash/UPI method, and whether payment is for enrollment or renewal. These are records only, not payment processing.
- `gym_admins` allowlists Supabase Auth user IDs. Member, membership, renewal, and payment data is restricted to allowlisted admins.

## App behavior

- Enrollment calls `create_member_with_membership`; member, initial membership, and payment rows are written together.
- Renewal calls `renew_membership`; each new term starts on the later of the renewal date or the latest membership's end date, so renewals chain in order.
- The enrollment and renewal forms show a five-second demo processing state. A successful result does not charge money.
- Archiving a member hides them from active member lists but retains their related history.
- The default membership start date is held in the current page state and resets on reload.

## Reset data

To start over, run all of `reset-data.sql` in Supabase SQL Editor. It permanently deletes members, memberships, renewals, and payments. It keeps plans, `gym_admins`, and Supabase Auth users. Do not run it if you need to preserve member history.

## Troubleshooting

- **“User is not an admin”**: make sure the Auth user exists in the same project and run the allowlist query with its exact email. Then sign out and back in.
- **No plans appear**: confirm the app config points to the same project and rerun `supabase.sql`. The plan seed is safe to rerun because it upserts by `plan_code`.
- **Function not found**: rerun the latest `supabase.sql`, including the final `notify pgrst, 'reload schema';`, then refresh the page.
- **Network or connection error**: check the project URL and publishable key in `supabase-config.js`, internet access, and that the app is served over HTTP.
