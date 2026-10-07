-- The backend (service role) reads profiles to check a user's role and status
-- (warehouse API) and to show who recorded a movement. Newer Supabase
-- projects don't auto-grant table access to API roles, and the profiles
-- migration only granted it to `authenticated`. Read-only; safe to re-run.
grant select on public.profiles to service_role;
