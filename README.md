# GYM GRID
A simple gym membership manager for members, plans, memberships, renewals, and payment records.
## Run locally
From this folder, run `py -m http.server 5500`, then open `http://127.0.0.1:5500/`.
## Supabase setup
1. Run `supabase.sql` in the Supabase SQL Editor.
2. Create an admin under **Authentication → Users**.
3. Allowlist that user's email in the SQL Editor:
   ```sql
   insert into public.gym_admins (user_id)
   select id from auth.users
   where lower(email) = lower('YOUR_ADMIN_EMAIL')
   on conflict (user_id) do nothing;
   ```
Sign in with the same email and password in GYM GRID. Never put the password or a Supabase service-role key in the frontend.
`reset-data.sql` permanently clears members, memberships, renewals, and payments while keeping plans and admin accounts. Payments are currently demo records; no real charge is processed.
