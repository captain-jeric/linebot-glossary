create extension if not exists pgcrypto;

drop function if exists public.increment_user_usage(uuid, bigint);
drop function if exists public.recharge_user_flow(uuid, bigint, timestamptz);

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  mode text not null default 'bilingual' check (mode in ('bilingual', 'trilingual')),
  from_lang text not null default 'zh',
  to_lang text not null default 'th',
  quota_chars bigint not null default 0 check (quota_chars >= 0),
  used_chars bigint not null default 0 check (used_chars >= 0),
  expires_at timestamptz not null,
  last_active_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (used_chars <= quota_chars)
);

create table if not exists public.user_renewals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('purchase', 'recharge', 'adjustment')),
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

create table if not exists public.conversation_users (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('group', 'room')),
  conversation_id text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  translation_enabled boolean not null default true,
  mode text check (mode is null or mode in ('bilingual', 'trilingual')),
  from_lang text,
  to_lang text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, conversation_id)
);

create index if not exists conversation_users_user_id_idx
  on public.conversation_users (user_id);

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

drop trigger if exists conversation_users_set_updated_at on public.conversation_users;
create trigger conversation_users_set_updated_at
before update on public.conversation_users
for each row execute function public.set_updated_at();

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
  update public.users u
  set used_chars = u.used_chars + p_chars,
      last_active_at = now(),
      updated_at = now()
  where u.id = p_user_id
    and p_chars > 0
    and u.status = 'active'
    and u.expires_at > now()
    and u.quota_chars - u.used_chars >= p_chars
  returning u.id, u.used_chars, u.quota_chars;
$$;

create or replace function public.recharge_user_flow(
  p_user_id uuid,
  p_chars bigint,
  p_expires_at timestamptz
)
returns table (
  id uuid,
  quota_chars bigint,
  used_chars bigint,
  expires_at timestamptz,
  expires_at_before timestamptz
)
language sql
security definer
as $$
  with previous_account as (
    select u.id, u.expires_at
    from public.users u
    where u.id = p_user_id
  )
  update public.users u
  set status = 'active',
      quota_chars = u.quota_chars + p_chars,
      expires_at = p_expires_at,
      updated_at = now()
  from previous_account
  where u.id = previous_account.id
    and p_chars > 0
    and p_expires_at is not null
  returning
    u.id,
    u.quota_chars,
    u.used_chars,
    u.expires_at,
    previous_account.expires_at as expires_at_before;
$$;

-- Example manual user creation:
-- insert into public.users (
--   line_user_id,
--   name,
--   quota_chars,
--   expires_at,
--   notes
-- ) values (
--   'Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
--   'Demo User',
--   100000,
--   (current_date + interval '1 year')::date + time '23:59:59',
--   'Manual test user'
-- );
