create extension if not exists pgcrypto;

create table if not exists public.glossary_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.glossary_terms (
  id uuid primary key default gen_random_uuid(),
  concept_id uuid not null default gen_random_uuid(),
  terms jsonb not null default '{}'::jsonb,
  aliases jsonb not null default '{}'::jsonb,
  domain text not null default 'general',
  definitions jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'active', 'deprecated')),
  source text not null default 'manual' check (source in ('manual', 'ai', 'import', 'suggestion')),
  reviewed boolean not null default false,
  reviewed_by text,
  risk_level text not null default 'low' check (risk_level in ('low', 'medium', 'high')),
  requires_disclaimer boolean not null default false,
  review_after timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.message_terms (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  normalized_text text not null,
  language text not null default 'und',
  count bigint not null default 1 check (count >= 0),
  domains text[] not null default '{}',
  examples jsonb not null default '[]'::jsonb,
  status text not null default 'candidate' check (status in ('candidate', 'ignored', 'promoted')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_text, language)
);

create table if not exists public.term_suggestions (
  id uuid primary key default gen_random_uuid(),
  source_text text not null,
  normalized_text text not null,
  language text not null default 'und',
  count bigint not null default 1 check (count >= 0),
  suggested_domain text not null default 'general',
  ai_suggestion jsonb not null default '{}'::jsonb,
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'ignored', 'merged')),
  message_term_id uuid references public.message_terms(id) on delete set null,
  glossary_term_id uuid references public.glossary_terms(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_text, language, status)
);

create table if not exists public.sentence_candidates (
  id uuid primary key default gen_random_uuid(),
  source_text text not null,
  normalized_source_text text not null,
  source_lang text not null default 'und',
  count bigint not null default 1 check (count >= 0),
  examples jsonb not null default '[]'::jsonb,
  status text not null default 'candidate' check (status in ('candidate', 'ignored', 'promoted')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_source_text, source_lang)
);

create table if not exists public.frequent_translations (
  id uuid primary key default gen_random_uuid(),
  source_text text not null,
  normalized_source_text text not null,
  source_lang text not null,
  target_lang text not null,
  translated_text text not null,
  status text not null default 'draft' check (status in ('draft', 'active', 'disabled')),
  hit_count bigint not null default 0 check (hit_count >= 0),
  last_hit_at timestamptz,
  sentence_candidate_id uuid references public.sentence_candidates(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (normalized_source_text, source_lang, target_lang)
);

create index if not exists glossary_terms_status_domain_idx
  on public.glossary_terms (status, domain);

create index if not exists glossary_terms_review_after_idx
  on public.glossary_terms (review_after)
  where review_after is not null;

create index if not exists glossary_terms_terms_gin_idx
  on public.glossary_terms using gin (terms);

create index if not exists glossary_terms_aliases_gin_idx
  on public.glossary_terms using gin (aliases);

create index if not exists message_terms_status_count_idx
  on public.message_terms (status, count desc, last_seen_at desc);

create index if not exists message_terms_domains_gin_idx
  on public.message_terms using gin (domains);

create index if not exists term_suggestions_status_count_idx
  on public.term_suggestions (status, count desc, updated_at desc);

create index if not exists sentence_candidates_status_count_idx
  on public.sentence_candidates (status, count desc, last_seen_at desc);

create index if not exists frequent_translations_lookup_idx
  on public.frequent_translations (status, source_lang, target_lang, normalized_source_text);

create index if not exists frequent_translations_hit_count_idx
  on public.frequent_translations (status, hit_count desc, updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists glossary_categories_set_updated_at on public.glossary_categories;
create trigger glossary_categories_set_updated_at
before update on public.glossary_categories
for each row execute function public.set_updated_at();

drop trigger if exists glossary_terms_set_updated_at on public.glossary_terms;
create trigger glossary_terms_set_updated_at
before update on public.glossary_terms
for each row execute function public.set_updated_at();

drop trigger if exists message_terms_set_updated_at on public.message_terms;
create trigger message_terms_set_updated_at
before update on public.message_terms
for each row execute function public.set_updated_at();

drop trigger if exists term_suggestions_set_updated_at on public.term_suggestions;
create trigger term_suggestions_set_updated_at
before update on public.term_suggestions
for each row execute function public.set_updated_at();

drop trigger if exists sentence_candidates_set_updated_at on public.sentence_candidates;
create trigger sentence_candidates_set_updated_at
before update on public.sentence_candidates
for each row execute function public.set_updated_at();

drop trigger if exists frequent_translations_set_updated_at on public.frequent_translations;
create trigger frequent_translations_set_updated_at
before update on public.frequent_translations
for each row execute function public.set_updated_at();

create or replace function public.record_message_term(
  p_text text,
  p_normalized_text text,
  p_language text,
  p_domains text[] default '{}',
  p_example text default null,
  p_example_limit integer default 5
)
returns table (
  id uuid,
  count bigint,
  status text
)
language plpgsql
security definer
as $$
begin
  return query
  insert into public.message_terms (
    text,
    normalized_text,
    language,
    count,
    domains,
    examples,
    first_seen_at,
    last_seen_at
  )
  values (
    p_text,
    p_normalized_text,
    coalesce(nullif(p_language, ''), 'und'),
    1,
    coalesce(p_domains, '{}'),
    case
      when nullif(p_example, '') is null then '[]'::jsonb
      else jsonb_build_array(left(p_example, 500))
    end,
    now(),
    now()
  )
  on conflict (normalized_text, language) do update
  set
    count = public.message_terms.count + 1,
    domains = (
      select coalesce(array_agg(distinct domain), '{}'::text[])
      from unnest(coalesce(public.message_terms.domains, '{}'::text[]) || coalesce(excluded.domains, '{}'::text[])) as domain_values(domain)
    ),
    examples = (
      select coalesce(jsonb_agg(example), '[]'::jsonb)
      from (
        select distinct example
        from jsonb_array_elements_text(coalesce(public.message_terms.examples, '[]'::jsonb) || coalesce(excluded.examples, '[]'::jsonb)) as examples(example)
        limit greatest(coalesce(p_example_limit, 5), 0)
      ) kept_examples
    ),
    last_seen_at = now(),
    updated_at = now()
  returning public.message_terms.id, public.message_terms.count, public.message_terms.status;
end;
$$;

create or replace function public.create_term_suggestion_if_needed(
  p_message_term_id uuid,
  p_min_count bigint default 20
)
returns uuid
language plpgsql
security definer
as $$
declare
  v_term public.message_terms%rowtype;
  v_suggestion_id uuid;
begin
  select *
  into v_term
  from public.message_terms
  where id = p_message_term_id;

  if v_term.id is null or v_term.status <> 'candidate' or v_term.count < p_min_count then
    return null;
  end if;

  insert into public.term_suggestions (
    source_text,
    normalized_text,
    language,
    count,
    suggested_domain,
    message_term_id
  )
  values (
    v_term.text,
    v_term.normalized_text,
    v_term.language,
    v_term.count,
    coalesce(v_term.domains[1], 'general'),
    v_term.id
  )
  on conflict (normalized_text, language, status) do update
  set
    count = greatest(public.term_suggestions.count, excluded.count),
    message_term_id = excluded.message_term_id,
    updated_at = now()
  returning id into v_suggestion_id;

  return v_suggestion_id;
end;
$$;

create or replace function public.record_sentence_candidate(
  p_source_text text,
  p_normalized_source_text text,
  p_source_lang text,
  p_example text default null,
  p_example_limit integer default 5
)
returns table (
  id uuid,
  count bigint,
  status text
)
language plpgsql
security definer
as $$
begin
  return query
  insert into public.sentence_candidates (
    source_text,
    normalized_source_text,
    source_lang,
    count,
    examples,
    first_seen_at,
    last_seen_at
  )
  values (
    p_source_text,
    p_normalized_source_text,
    coalesce(nullif(p_source_lang, ''), 'und'),
    1,
    case
      when nullif(p_example, '') is null then '[]'::jsonb
      else jsonb_build_array(left(p_example, 500))
    end,
    now(),
    now()
  )
  on conflict (normalized_source_text, source_lang) do update
  set
    count = public.sentence_candidates.count + 1,
    examples = (
      select coalesce(jsonb_agg(example), '[]'::jsonb)
      from (
        select distinct example
        from jsonb_array_elements_text(coalesce(public.sentence_candidates.examples, '[]'::jsonb) || coalesce(excluded.examples, '[]'::jsonb)) as examples(example)
        limit greatest(coalesce(p_example_limit, 5), 0)
      ) kept_examples
    ),
    last_seen_at = now(),
    updated_at = now()
  returning public.sentence_candidates.id, public.sentence_candidates.count, public.sentence_candidates.status;
end;
$$;

create or replace function public.record_frequent_translation_hit(
  p_translation_id uuid
)
returns void
language plpgsql
security definer
as $$
begin
  update public.frequent_translations
  set
    hit_count = hit_count + 1,
    last_hit_at = now(),
    updated_at = now()
  where id = p_translation_id;
end;
$$;

insert into public.glossary_categories (code, name, description)
values
  ('general', '通用', '未明确分类的常用术语'),
  ('tax', '税务', '税务、扣缴、发票、申报相关术语'),
  ('boi', 'BOI', '泰国 BOI 投资促进相关术语'),
  ('import', '进口', '进口、关税、设备清关相关术语'),
  ('accounting', '财务会计', '财务、会计、审计相关术语'),
  ('legal', '法律合规', '合同、法规、合规相关术语'),
  ('production', '生产制造', '工厂、生产、设备、品质相关术语')
on conflict (code) do nothing;
