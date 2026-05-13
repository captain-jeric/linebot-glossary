create extension if not exists pgcrypto;

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  activation_code text not null unique,
  activation_code_enabled boolean not null default true,
  status text not null default 'active' check (status in ('active', 'trial', 'paused', 'expired', 'cancelled')),
  quota_chars bigint not null default 0 check (quota_chars >= 0),
  used_chars bigint not null default 0 check (used_chars >= 0),
  extra_quota_chars bigint not null default 0 check (extra_quota_chars >= 0),
  extra_used_chars bigint not null default 0 check (extra_used_chars >= 0),
  billing_cycle_day integer not null default 1 check (billing_cycle_day >= 1 and billing_cycle_day <= 28),
  billing_period text not null default to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM'),
  expires_at timestamptz not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.customers
  add column if not exists extra_quota_chars bigint not null default 0 check (extra_quota_chars >= 0);

alter table public.customers
  add column if not exists extra_used_chars bigint not null default 0 check (extra_used_chars >= 0);

alter table public.customers
  add column if not exists billing_cycle_day integer not null default 1 check (billing_cycle_day >= 1 and billing_cycle_day <= 28);

alter table public.customers
  add column if not exists billing_period text not null default to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM');

create table if not exists public.activations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  conversation_id text not null unique,
  source_type text not null check (source_type in ('group', 'room', 'user')),
  enabled boolean not null default true,
  mode text not null default 'bilingual' check (mode in ('bilingual', 'trilingual')),
  from_lang text not null default 'zh',
  to_lang text not null default 'th',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_active_at timestamptz
);

create index if not exists customers_activation_code_idx
  on public.customers (activation_code);

create index if not exists customers_status_expires_at_idx
  on public.customers (status, expires_at);

create index if not exists activations_customer_id_idx
  on public.activations (customer_id);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

drop trigger if exists activations_set_updated_at on public.activations;
create trigger activations_set_updated_at
before update on public.activations
for each row execute function public.set_updated_at();

create or replace function public.increment_customer_usage(
  p_customer_id uuid,
  p_chars bigint
)
returns table (
  id uuid,
  used_chars bigint,
  quota_chars bigint
)
language sql
security definer
as $$
  with current_customer as (
    select
      c.id,
      c.quota_chars,
      case
        when c.billing_period = to_char(
          (now() at time zone 'Asia/Bangkok')
            - case
                when extract(day from now() at time zone 'Asia/Bangkok') < c.billing_cycle_day
                  then interval '1 month'
                else interval '0 month'
              end,
          'YYYY-MM'
        )
          then c.used_chars
        else 0
      end as monthly_used,
      c.extra_quota_chars,
      c.extra_used_chars,
      to_char(
        (now() at time zone 'Asia/Bangkok')
          - case
              when extract(day from now() at time zone 'Asia/Bangkok') < c.billing_cycle_day
                then interval '1 month'
              else interval '0 month'
            end,
        'YYYY-MM'
      ) as current_period
    from public.customers c
    where c.id = p_customer_id
      and p_chars > 0
  ),
  charge as (
    select
      id,
      monthly_used,
      extra_used_chars,
      current_period,
      least(greatest(quota_chars - monthly_used, 0), p_chars) as monthly_charge,
      p_chars - least(greatest(quota_chars - monthly_used, 0), p_chars) as extra_charge
    from current_customer
    where greatest(quota_chars - monthly_used, 0) + greatest(extra_quota_chars - extra_used_chars, 0) >= p_chars
  )
  update public.customers c
  set used_chars = charge.monthly_used + charge.monthly_charge,
      extra_used_chars = charge.extra_used_chars + charge.extra_charge,
      billing_period = charge.current_period,
      updated_at = now()
  from charge
  where c.id = charge.id
  returning c.id, c.used_chars, c.quota_chars;
$$;

-- Example manual customer creation:
-- insert into public.customers (
--   name,
--   activation_code,
--   status,
--   quota_chars,
--   expires_at,
--   notes
-- ) values (
--   'Demo Customer',
--   'DEMO-2026-001',
--   'trial',
--   100000,
--   now() + interval '14 days',
--   'Manual trial code'
-- );
