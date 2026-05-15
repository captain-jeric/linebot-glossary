create extension if not exists pgcrypto;

drop function if exists public.increment_customer_usage(uuid, bigint);
drop function if exists public.increment_user_usage(uuid, bigint);
drop table if exists public.activations;
drop table if exists public.customers;
drop table if exists public.user_renewals;
drop table if exists public.users;

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  mode text not null default 'bilingual' check (mode in ('bilingual', 'trilingual')),
  from_lang text not null default 'zh',
  to_lang text not null default 'th',
  monthly_quota_chars bigint not null default 0 check (monthly_quota_chars >= 0),
  monthly_used_chars bigint not null default 0 check (monthly_used_chars >= 0),
  extra_quota_chars bigint not null default 0 check (extra_quota_chars >= 0),
  extra_used_chars bigint not null default 0 check (extra_used_chars >= 0),
  billing_period text not null default to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM'),
  expires_at timestamptz not null,
  last_active_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_renewals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('monthly', 'topup', 'adjustment')),
  chars_delta bigint not null default 0,
  expires_at_before timestamptz,
  expires_at_after timestamptz,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists users_line_user_id_idx
  on public.users (line_user_id);

create index if not exists users_status_expires_at_idx
  on public.users (status, expires_at);

create index if not exists user_renewals_user_id_created_at_idx
  on public.user_renewals (user_id, created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists users_set_updated_at on public.users;
create trigger users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

create or replace function public.increment_user_usage(
  p_user_id uuid,
  p_chars bigint
)
returns table (
  id uuid,
  monthly_used_chars bigint,
  monthly_quota_chars bigint,
  extra_used_chars bigint,
  extra_quota_chars bigint
)
language sql
security definer
as $$
  with current_account as (
    select
      u.id,
      u.monthly_quota_chars,
      case
        when u.billing_period = to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM')
          then u.monthly_used_chars
        else 0
      end as monthly_used,
      u.extra_quota_chars,
      u.extra_used_chars,
      to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM') as current_period
    from public.users u
    where u.id = p_user_id
      and p_chars > 0
      and u.status = 'active'
      and u.expires_at > now()
  ),
  charge as (
    select
      ca.id,
      ca.monthly_used,
      ca.extra_used_chars,
      ca.current_period,
      least(greatest(ca.monthly_quota_chars - ca.monthly_used, 0), p_chars) as monthly_charge,
      p_chars - least(greatest(ca.monthly_quota_chars - ca.monthly_used, 0), p_chars) as extra_charge
    from current_account ca
    where greatest(ca.monthly_quota_chars - ca.monthly_used, 0) + greatest(ca.extra_quota_chars - ca.extra_used_chars, 0) >= p_chars
  )
  update public.users u
  set monthly_used_chars = charge.monthly_used + charge.monthly_charge,
      extra_used_chars = charge.extra_used_chars + charge.extra_charge,
      billing_period = charge.current_period,
      last_active_at = now(),
      updated_at = now()
  from charge
  where u.id = charge.id
  returning u.id, u.monthly_used_chars, u.monthly_quota_chars, u.extra_used_chars, u.extra_quota_chars;
$$;

-- Example manual user creation:
-- insert into public.users (
--   line_user_id,
--   name,
--   monthly_quota_chars,
--   expires_at,
--   notes
-- ) values (
--   'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
--   'Demo User',
--   100000,
--   (current_date + interval '1 month')::date + time '23:59:59',
--   'Manual test user'
-- );
