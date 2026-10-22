-- Component 1: store the NLP analysis of collected articles and the events it
-- generates. Additive only (new nullable/defaulted columns, one relaxed NOT
-- NULL); no data is changed or removed. Safe to re-run.
--
-- Written by the backend article processor (src/event-intel/process-articles.js)
-- with the service-role key; existing RLS policies (signed-in users read,
-- admins write) apply unchanged to the new columns.

alter table public.event_articles
  -- Full /event-intel/classify response (rules, model, hybrid, review), kept
  -- as evidence for the dashboard and for later audit.
  add column if not exists analysis jsonb,
  -- Final category from the hybrid (rules + DistilRoBERTa) decision.
  add column if not exists event_category text,
  -- Connection to Sri Lanka, decided conservatively from rule evidence:
  --   direct    event in Sri Lanka (or explicitly affecting it)
  --   indirect  possible cross-border link found by a rule (a channel to check, not a confirmed impact)
  --   none      no Sri Lankan connection identified
  --   uncertain insufficient or conflicting evidence
  add column if not exists sri_lanka_relevance text
    check (sri_lanka_relevance in ('direct', 'indirect', 'none', 'uncertain')),
  add column if not exists relevance_reason text,
  add column if not exists needs_review boolean not null default false,
  -- e.g. "service 1.0.0 / rules 0.1.0 / model <checkpoint version>".
  add column if not exists analysis_version text,
  -- Bounded retries: the processor stops retrying after a fixed number of attempts.
  add column if not exists processing_attempts integer not null default 0,
  add column if not exists processing_started_at timestamptz;

create index if not exists event_articles_needs_review_idx
  on public.event_articles (needs_review) where needs_review;

alter table public.events
  -- Who created the event: an admin ('manual') or the NLP pipeline.
  add column if not exists generated_by text not null default 'manual'
    check (generated_by in ('manual', 'nlp_pipeline')),
  -- Stable grouping key for pipeline events (category, anchor, ISO week), so
  -- retries and related articles never create duplicate events.
  add column if not exists dedupe_key text unique,
  add column if not exists sri_lanka_relevance text
    check (sri_lanka_relevance in ('direct', 'indirect', 'none', 'uncertain')),
  add column if not exists needs_review boolean not null default false,
  -- Evidence summary (category, diseases, locations, linked-article count basis).
  add column if not exists analysis jsonb;

-- The pipeline does not rate severity; null means "not assessed" rather than a
-- made-up 'medium'. Manual events keep the existing default.
alter table public.events alter column severity drop not null;
