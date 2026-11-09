-- Run this file once in Supabase SQL Editor.
-- Create the administrator in Authentication > Users, then add their Auth UID:
-- insert into public.gym_admins (user_id) values ('<AUTH_USER_UUID>');
-- Or add by email after creating the Auth user:
-- insert into public.gym_admins (user_id)
-- select id from auth.users where email = 'YOUR_ADMIN_EMAIL'
-- on conflict (user_id) do nothing;

create extension if not exists pgcrypto;

create table if not exists public.plans (
  id uuid primary key default gen_random_uuid(),
  plan_code text not null unique,
  name text not null,
  duration_months integer not null check (duration_months > 0),
  price numeric(10, 2) not null check (price >= 0),
  discount numeric(10, 2) not null default 0 check (discount >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  archived_at timestamptz
);

create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  constraint memberships_valid_term check (ends_on > starts_on)
);

create table if not exists public.renewals (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  membership_id uuid not null unique references public.memberships(id) on delete cascade,
  previous_membership_id uuid references public.memberships(id) on delete set null,
  plan_id uuid not null references public.plans(id),
  renewed_on date not null default current_date,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete cascade,
  membership_id uuid not null references public.memberships(id) on delete cascade,
  plan_id uuid not null references public.plans(id),
  amount numeric(10, 2) not null check (amount >= 0),
  payment_method text not null check (payment_method in ('Cash', 'UPI')),
  payment_type text not null check (payment_type in ('Membership', 'Renewal')),
  paid_on timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists memberships_member_term_idx
  on public.memberships (member_id, ends_on desc, created_at desc);
create index if not exists renewals_member_date_idx
  on public.renewals (member_id, renewed_on desc);
create index if not exists payments_paid_on_idx
  on public.payments (paid_on desc);

create table if not exists public.gym_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.gym_admins enable row level security;
revoke all on public.gym_admins from anon, authenticated;

create or replace function public.is_gym_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.gym_admins where user_id = auth.uid());
$$;
revoke all on function public.is_gym_admin() from public;
grant execute on function public.is_gym_admin() to authenticated;

create or replace view public.membership_status
with (security_invoker = true)
as
select
  m.id as membership_id,
  m.member_id,
  m.plan_id,
  m.starts_on,
  m.ends_on,
  case
    when current_date < m.starts_on then 'Upcoming'
    when current_date <= m.ends_on then 'Active'
    else 'Expired'
  end as status,
  not exists (
    select 1
    from public.memberships newer
    where newer.member_id = m.member_id
      and (newer.starts_on, newer.created_at) > (m.starts_on, m.created_at)
  ) as is_latest
from public.memberships m;

alter table public.plans enable row level security;
alter table public.members enable row level security;
alter table public.memberships enable row level security;
alter table public.renewals enable row level security;
alter table public.payments enable row level security;

drop policy if exists plans_authenticated_read on public.plans;
create policy plans_authenticated_read on public.plans
  for select to authenticated using (true);

drop policy if exists members_authenticated_read on public.members;
create policy members_authenticated_read on public.members
  for select to authenticated using (public.is_gym_admin());
drop policy if exists members_authenticated_update on public.members;
create policy members_authenticated_update on public.members
  for update to authenticated using (public.is_gym_admin()) with check (public.is_gym_admin());

drop policy if exists memberships_authenticated_read on public.memberships;
create policy memberships_authenticated_read on public.memberships
  for select to authenticated using (public.is_gym_admin());

drop policy if exists renewals_authenticated_read on public.renewals;
create policy renewals_authenticated_read on public.renewals
  for select to authenticated using (public.is_gym_admin());

drop policy if exists payments_authenticated_read on public.payments;
create policy payments_authenticated_read on public.payments
  for select to authenticated using (public.is_gym_admin());

grant select on public.plans, public.members, public.memberships,
  public.membership_status, public.renewals, public.payments to authenticated;
grant update (archived_at) on public.members to authenticated;

insert into public.plans (plan_code, name, duration_months, price, discount)
values
  ('normal-1m', 'Normal', 1, 1000, 0),
  ('elite-plus-3m', 'Elite Plus', 3, 2800, 200),
  ('elite-pro-6m', 'Elite Pro', 6, 5500, 500),
  ('elite-premium-12m', 'Elite Premium', 12, 10000, 2000)
on conflict (plan_code) do update set
  name = excluded.name,
  duration_months = excluded.duration_months,
  price = excluded.price,
  discount = excluded.discount,
  is_active = true;

do $$
declare
  seeded_plan_count integer;
begin
  select count(*) into seeded_plan_count
  from public.plans
  where is_active
    and plan_code in ('normal-1m', 'elite-plus-3m', 'elite-pro-6m', 'elite-premium-12m');

  if seeded_plan_count <> 4 then
    raise exception 'Starter plan setup incomplete: expected 4 active plans, found %', seeded_plan_count;
  end if;
end;
$$;

create or replace function public.create_member_with_membership(
  p_full_name text,
  p_phone text,
  p_plan_id uuid,
  p_starts_on date,
  p_payment_method text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.members%rowtype;
  v_plan public.plans%rowtype;
  v_membership public.memberships%rowtype;
begin
  if auth.uid() is null or not public.is_gym_admin() then
    raise exception 'Gym administrator access required';
  end if;
  if p_payment_method not in ('Cash', 'UPI') then
    raise exception 'Unsupported payment method';
  end if;

  select * into strict v_plan from public.plans
  where id = p_plan_id and is_active;

  insert into public.members (full_name, phone, created_by)
  values (trim(p_full_name), trim(p_phone), auth.uid())
  returning * into v_member;

  insert into public.memberships (member_id, plan_id, starts_on, ends_on, created_by)
  values (
    v_member.id, v_plan.id, p_starts_on,
    (p_starts_on + make_interval(months => v_plan.duration_months))::date,
    auth.uid()
  ) returning * into v_membership;

  insert into public.payments
    (member_id, membership_id, plan_id, amount, payment_method, payment_type, created_by)
  values
    (v_member.id, v_membership.id, v_plan.id, v_plan.price, p_payment_method, 'Membership', auth.uid());

  return jsonb_build_object('member_id', v_member.id, 'membership_id', v_membership.id);
end;
$$;

create or replace function public.renew_membership(
  p_member_id uuid,
  p_plan_id uuid,
  p_renewed_on date,
  p_payment_method text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.members%rowtype;
  v_plan public.plans%rowtype;
  v_previous public.memberships%rowtype;
  v_membership public.memberships%rowtype;
  v_starts_on date;
begin
  if auth.uid() is null or not public.is_gym_admin() then
    raise exception 'Gym administrator access required';
  end if;
  if p_payment_method not in ('Cash', 'UPI') then
    raise exception 'Unsupported payment method';
  end if;

  select * into strict v_member from public.members
  where id = p_member_id and archived_at is null for update;
  select * into strict v_plan from public.plans
  where id = p_plan_id and is_active;

  select * into v_previous from public.memberships
  where member_id = p_member_id
  order by ends_on desc, created_at desc
  limit 1;

  v_starts_on := greatest(coalesce(v_previous.ends_on, p_renewed_on), p_renewed_on);

  insert into public.memberships (member_id, plan_id, starts_on, ends_on, created_by)
  values (
    p_member_id, v_plan.id, v_starts_on,
    (v_starts_on + make_interval(months => v_plan.duration_months))::date,
    auth.uid()
  ) returning * into v_membership;

  insert into public.renewals
    (member_id, membership_id, previous_membership_id, plan_id, renewed_on, starts_on, ends_on, created_by)
  values
    (p_member_id, v_membership.id, v_previous.id, v_plan.id, p_renewed_on,
     v_membership.starts_on, v_membership.ends_on, auth.uid());

  insert into public.payments
    (member_id, membership_id, plan_id, amount, payment_method, payment_type, created_by)
  values
    (p_member_id, v_membership.id, v_plan.id, v_plan.price, p_payment_method, 'Renewal', auth.uid());

  return jsonb_build_object(
    'membership_id', v_membership.id,
    'starts_on', v_membership.starts_on,
    'ends_on', v_membership.ends_on
  );
end;
$$;

revoke all on function public.create_member_with_membership(text, text, uuid, date, text) from public;
revoke all on function public.renew_membership(uuid, uuid, date, text) from public;
grant execute on function public.create_member_with_membership(text, text, uuid, date, text) to authenticated;
grant execute on function public.renew_membership(uuid, uuid, date, text) to authenticated;

notify pgrst, 'reload schema';