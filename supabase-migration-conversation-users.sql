create table if not exists public.conversation_users (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('group', 'room')),
  conversation_id text not null,
  user_id uuid not null references public.users(id) on delete cascade,
  translation_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_type, conversation_id)
);

alter table public.conversation_users
  add column if not exists translation_enabled boolean not null default true;

create index if not exists conversation_users_user_id_idx
  on public.conversation_users (user_id);

drop trigger if exists conversation_users_set_updated_at on public.conversation_users;
create trigger conversation_users_set_updated_at
before update on public.conversation_users
for each row execute function public.set_updated_at();
