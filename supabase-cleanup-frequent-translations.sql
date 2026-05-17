-- Cleanup removed frequent direct-translation feature.
-- Run this in Supabase SQL Editor only if you previously created these objects
-- and want to fully remove the unused tables/functions from the database.

drop function if exists public.record_frequent_translation_hit(uuid);
drop function if exists public.record_sentence_candidate(text, text, text, text, integer);

drop trigger if exists frequent_translations_set_updated_at on public.frequent_translations;
drop trigger if exists sentence_candidates_set_updated_at on public.sentence_candidates;

drop index if exists public.frequent_translations_hit_count_idx;
drop index if exists public.frequent_translations_lookup_idx;
drop index if exists public.sentence_candidates_status_count_idx;

drop table if exists public.frequent_translations;
drop table if exists public.sentence_candidates;
