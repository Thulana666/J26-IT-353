-- Component 4: allow the linear-regression demand model to be recorded.
--
-- The analytics service trains a pooled linear regression during a
-- recalculation (backend/src/pharmacy/analytics/linear-regression.js) and uses
-- it for products where it beat the moving average on held-out days. Runs and
-- forecast rows record which method produced them.
--
-- Only widens two check constraints on Component 4's own tables; existing rows
-- stay valid. Safe to re-run. Until it is applied, recalculations keep using
-- the moving average.

alter table public.pharmacy_forecast_runs
  drop constraint if exists pharmacy_forecast_runs_engine_check,
  add constraint pharmacy_forecast_runs_engine_check
    check (engine in ('moving_average', 'linear_regression', 'ai_service', 'baseline_fallback'));

-- The model_name check was created inline (system-generated name): drop any
-- check constraint on pharmacy_demand_forecasts that tests model_name.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.pharmacy_demand_forecasts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%model_name%'
  loop
    execute format('alter table public.pharmacy_demand_forecasts drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.pharmacy_demand_forecasts
  add constraint pharmacy_demand_forecasts_model_name_check
    check (model_name in ('moving_average', 'linear_regression', 'random_forest', 'xgboost'));
