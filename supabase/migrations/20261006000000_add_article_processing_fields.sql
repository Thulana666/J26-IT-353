-- Articles / Sources: fields needed to display articles and to drive the
-- (future) NLP event-analysis pipeline. Additive only; safe to re-run.

alter table public.event_articles
  -- Country the article is about (ISO 3166-1 alpha-2), e.g. 'LK'.
  -- May differ from the source's own country (e.g. a WHO report on India).
  add column if not exists country_code char(2),
  -- Pipeline state: new articles start as 'pending'; the NLP step moves them
  -- to 'processing', then 'processed' (or 'failed' with processing_error).
  add column if not exists processing_status text not null default 'pending'
    check (processing_status in ('pending', 'processing', 'processed', 'failed')),
  add column if not exists processed_at timestamptz,
  add column if not exists processing_error text;

-- Lets the pipeline quickly pick up the oldest unprocessed articles.
create index if not exists event_articles_processing_status_idx
  on public.event_articles (processing_status, fetched_at);
