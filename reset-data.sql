-- Run in Supabase SQL Editor only when you intentionally want to erase gym records.
-- Keeps plans, gym_admins, and Supabase Auth users intact.
begin;
truncate table
  public.payments,
  public.renewals,
  public.memberships,
  public.members
restart identity cascade;
commit;