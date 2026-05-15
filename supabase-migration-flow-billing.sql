-- Migrate from monthly quota + topup quota to single flow balance.
-- Run this on an existing Supabase database before deploying the updated app.

alter table public.users
  add column if not exists quota_chars bigint not null default 0,
  add column if not exists used_chars bigint not null default 0;

update public.users
set
  quota_chars = coalesce(monthly_quota_chars, 0) + coalesce(extra_quota_chars, 0),
  used_chars = least(
    coalesce(monthly_quota_chars, 0) + coalesce(extra_quota_chars, 0),
    (
      case
        when billing_period = to_char(now() at time zone 'Asia/Bangkok', 'YYYY-MM')
          then coalesce(monthly_used_chars, 0)
        else 0
      end
    ) + coalesce(extra_used_chars, 0)
  )
where quota_chars = 0
  and used_chars = 0;

alter table public.users
  drop constraint if exists users_used_chars_check;

alter table public.users
  add constraint users_used_chars_check
  check (used_chars >= 0 and used_chars <= quota_chars);

alter table public.user_renewals
  drop constraint if exists user_renewals_type_check;

update public.user_renewals
set type = case
  when type = 'monthly' then 'recharge'
  when type = 'topup' then 'recharge'
  else type
end;

alter table public.user_renewals
  add constraint user_renewals_type_check
  check (type in ('purchase', 'recharge', 'adjustment'));

drop function if exists public.increment_user_usage(uuid, bigint);

create or replace function public.increment_user_usage(
  p_user_id uuid,
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
  with current_account as (
    select
      u.id,
      u.quota_chars,
      u.used_chars
    from public.users u
    where u.id = p_user_id
      and p_chars > 0
      and u.status = 'active'
      and u.expires_at > now()
      and u.quota_chars - u.used_chars >= p_chars
  )
  update public.users u
  set used_chars = current_account.used_chars + p_chars,
      last_active_at = now(),
      updated_at = now()
  from current_account
  where u.id = current_account.id
  returning u.id, u.used_chars, u.quota_chars;
$$;

-- After the updated app has run successfully for a while, you may remove
-- monthly_quota_chars, monthly_used_chars, extra_quota_chars, extra_used_chars,
-- and billing_period in a separate cleanup migration.
