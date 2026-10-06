# J26-IT-353

## Frontend authentication (Supabase)

The Next.js app in `frontend/` uses Supabase Auth (email/password) with a
`public.profiles` table linked to `auth.users`.

1. Run the files in `supabase/migrations/` in order, in the Supabase SQL
   editor (or `supabase db push`):
   - `20261004000000_create_profiles.sql`: `profiles`, a trigger that adds a
     profile for every new auth user, and row level security.
   - `20261005000000_create_demand_forecasting_schema.sql`: the event
     analysis and demand forecasting tables. Signed-in users can read them;
     only admins (`profiles.role = 'admin'`) can write.
2. Copy `frontend/.env.example` to `frontend/.env.local` and fill in the
   project URL and publishable (anon) key from Project Settings > API.
3. Sign up at `/signup` (or add users in Supabase Dashboard > Authentication >
   Users). Set a user's
   `role` (`admin` / `user`) or `status` (`active` / `inactive`) in the
   `profiles` table.
4. `cd frontend && npm run dev`, then open http://localhost:3000.

Unauthenticated requests are redirected to `/login` by `src/proxy.js`;
signed-in users land on `/dashboard`. Email confirmation is turned off in
the Supabase project (Authentication > Sign In / Providers > Email), so new
users are signed in immediately after signing up.

## Article ingestion (Component 1)

`backend/` collects external articles into `event_articles` (status
`pending`, no NLP yet). They appear on **Medicine Impact → Articles / Sources**.

| Source | Feed | Filtering |
|---|---|---|
| WHO Disease Outbreak News | Official WHO API | none (all items are health events) |
| Daily Mirror (Sri Lanka) | Official breaking-news RSS | health/disaster keywords |
| Sri Lanka News API | RapidAPI (`NEWS_API_KEY`) | health/disaster keywords (EN/SI/TA) |

1. Copy `backend/.env.example` to `backend/.env` and fill in the Supabase
   secret key and `NEWS_API_KEY`. Keys stay server-side.
2. `cd backend && npm install`
3. Run the collector manually:

   ```bash
   npm run collect:articles                      # all sources
   npm run collect:articles -- who daily-mirror  # selected sources
   ```

Re-running is safe: articles are matched by URL, so only new ones are added
and existing rows are never changed. One failing source doesn't stop the
others. Set `data_sources.is_active = false` to pause a source. Daily
Mirror's robots.txt asks for at most one request per hour.
