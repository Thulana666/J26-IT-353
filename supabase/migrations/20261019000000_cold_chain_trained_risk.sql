-- Component 2 update: predictions of the trained models (AI service).
--
-- Additive only; existing rows and the prototype predictor are unchanged:
--   * temperature_risk / delay_risk: the trained models' outputs (temperature
--     excursion within horizon_minutes; late delivery). Null for the rule-based
--     prototype and when a risk could not be estimated.
--   * details: how the overall risk was formed (components with their models,
--     thresholds and skip reasons, the combination method, data cleaning), and
--     for a prototype result produced because the AI service could not answer,
--     the reason (details.fallback).
--   * horizon_minutes may be null: a delay-only prediction looks ahead to the
--     end of the trip, not a fixed number of minutes.
--   * cold_chain_latest_predictions is recreated so it includes the new columns.

alter table public.cold_chain_risk_predictions
  add column if not exists temperature_risk numeric(5, 4) check (temperature_risk between 0 and 1),
  add column if not exists delay_risk       numeric(5, 4) check (delay_risk between 0 and 1),
  add column if not exists details          jsonb not null default '{}'::jsonb;

alter table public.cold_chain_risk_predictions alter column horizon_minutes drop not null;

comment on column public.cold_chain_risk_predictions.temperature_risk is
  'Trained temperature-excursion model output (risk score within horizon_minutes); null for the prototype.';
comment on column public.cold_chain_risk_predictions.delay_risk is
  'Trained delivery-delay model output (risk score of arriving after the planned time); null for the prototype.';
comment on column public.cold_chain_risk_predictions.details is
  'Components, combination method and data cleaning of a trained prediction; details.fallback when the prototype answered instead.';

create or replace view public.cold_chain_latest_predictions
with (security_invoker = true) as
select distinct on (p.shipment_id) p.*
from public.cold_chain_risk_predictions p
order by p.shipment_id, p.predicted_at desc;
