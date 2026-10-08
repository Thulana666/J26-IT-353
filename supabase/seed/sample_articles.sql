-- SAMPLE DATA FOR TESTING THE ARTICLES / SOURCES PAGE.
--
-- These are NOT real collected articles. Every row is marked as sample:
--   * source name starts with "SAMPLE"
--   * article titles start with "[SAMPLE]"
--   * URLs use example.com (a domain reserved for examples)
-- All articles are 'pending' (no NLP has run) and none is linked to an event.
--
-- Run once in the Supabase SQL editor. Safe to re-run (duplicates are skipped).
-- To remove the sample data again, run the DELETE block at the bottom.

insert into public.data_sources (name, source_type, base_url, country_code, is_active)
values ('SAMPLE - Test data source', 'other', 'https://example.com', 'LK', false)
on conflict (name) do nothing;

insert into public.event_articles
  (data_source_id, title, url, summary, country_code, language, published_at)
select s.id, a.title, a.url, a.summary, a.country_code, a.language, a.published_at::timestamptz
from public.data_sources s
cross join (values
  ('[SAMPLE] Health officials report rise in fever cases in Colombo district',
   'https://example.com/sample/article-1',
   'Sample article for testing the Articles / Sources page.',
   'LK', 'en', '2026-10-05 08:30+05:30'),
  ('[SAMPLE] Heavy rain warning issued for Ratnapura and Kalutara',
   'https://example.com/sample/article-2',
   'Sample article for testing the Articles / Sources page.',
   'LK', 'en', '2026-10-04 17:10+05:30'),
  ('[SAMPLE] කොළඹ දිස්ත්‍රික්කයේ උණ රෝගීන් වැඩිවීම',
   'https://example.com/sample/article-3',
   'Sample Sinhala-language article for testing.',
   'LK', 'si', '2026-10-03 12:00+05:30'),
  ('[SAMPLE] யாழ்ப்பாணத்தில் வறட்சி நிலை தொடர்கிறது',
   'https://example.com/sample/article-4',
   'Sample Tamil-language article for testing.',
   'LK', 'ta', '2026-10-02 09:45+05:30'),
  ('[SAMPLE] Regional report on influenza activity in South Asia',
   'https://example.com/sample/article-5',
   'Sample international article for testing.',
   'IN', 'en', '2026-09-30 06:00+05:30')
) as a (title, url, summary, country_code, language, published_at)
where s.name = 'SAMPLE - Test data source'
on conflict (url) do nothing;

-- Check what was inserted:
-- select title, language, country_code, processing_status
-- from public.event_articles where title like '[SAMPLE]%';

-- Remove the sample data:
-- delete from public.event_articles where url like 'https://example.com/sample/%';
-- delete from public.data_sources where name = 'SAMPLE - Test data source';
