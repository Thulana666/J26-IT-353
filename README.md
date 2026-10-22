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
2. Create `frontend/.env.local` with `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (project URL and publishable key
   from Project Settings > API).
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

| Key | Source | Feed | Filtering |
|---|---|---|---|
| `who` | WHO Disease Outbreak News | Official WHO API (latest 100) | none (all items are health events) |
| `reliefweb` | ReliefWeb (UN OCHA) | Official API v2: Sri Lanka reports + declared disasters | none (Sri Lanka only); needs `RELIEFWEB_APPNAME` |
| `gdacs` | GDACS (UN / European Commission) | Official API: Sri Lanka hazard alerts since 2010 | none (Sri Lanka only) |
| `newsapi` | NewsAPI | NewsAPI.org search (`NEWS_API_KEY`) | query: "Sri Lanka" + dengue/outbreak/epidemic/public health/health emergency/medicine, or flood/disaster + health |
| `health-ministry` | Ministry of Health Sri Lanka | Official website feed | none (official notices) |
| `daily-mirror` | Daily Mirror (Sri Lanka) | Official breaking-news RSS | health/disaster keywords in title or summary |
| `daily-news` | Daily News (Lake House) | Official RSS | health/disaster keywords in title or summary |
| `sunday-observer` | Sunday Observer (Lake House) | Official RSS | health/disaster keywords in title or summary |

1. Create `backend/.env` (git-ignored, server-side only) with:

   ```
   PORT=5000
   SUPABASE_URL=https://your-project-ref.supabase.co
   SUPABASE_SECRET_KEY=your-secret-service-role-key
   NEWS_API_KEY=your-newsapi-org-key
   RELIEFWEB_APPNAME=your-approved-reliefweb-appname
   ```

   - `NEWS_API_KEY`: free at https://newsapi.org (developer plan:
     development use, 100 requests/day, articles delayed ~24h).
   - `RELIEFWEB_APPNAME`: free, but must be approved by ReliefWeb; request
     it via the form linked at https://apidoc.reliefweb.int/parameters.
     Without it the ReliefWeb source is skipped.
2. `cd backend && npm install`
3. Run the collector manually:

   ```bash
   npm run collect:articles                 # all sources
   npm run collect:articles -- gdacs who    # selected sources (keys above)
   npm run backfill:countries               # fill missing countries from titles
   ```

**Refresh button:** admins can also run the collector from the Articles /
Sources page. It calls the backend (`POST /api/ingestion/articles`)
server-to-server, so the backend must be running (`cd backend && npm run dev`)
and both env files need the same secret:

- `backend/.env`: `INGESTION_API_KEY=<long random string>`
- `frontend/.env.local`: `INGESTION_API_KEY=<same value>` and
  `BACKEND_URL=http://localhost:5000`

Re-running is safe: articles are matched by URL, so only new ones are added
and existing rows are never changed. One failing source doesn't stop the
others; a source without its key is reported as skipped. Set
`data_sources.is_active = false` to pause a source. Daily Mirror's robots.txt
asks for at most one request per hour, and ReliefWeb's robots.txt disallows
automated RSS access (hence its API is used).

## IoT cold-chain tracking & logistics risk (Component 2)

Trips for dispatched shipments: drivers and refrigerated trucks, allocation,
live sensor readings from ESP32 loggers (temperature, humidity, GPS, speed),
alerts, predicted risk (a temporary, labelled rule-based prototype until the
models in `ai-service/cold_chain/` are trained on real trips and installed),
delivery and history, under **Cold Chain** in the sidebar. Apply
`supabase/migrations/20261017000000_create_cold_chain_schema.sql`,
`20261018000002_cold_chain_logistics.sql`,
`20261018000003_cold_chain_driver_portal.sql` and
`20261019000000_cold_chain_trained_risk.sql` after the pharmacy and warehouse
migrations, and run the backend. Workflow, device API, dashboard API, risk
prediction and testing: [docs/component-2-cold-chain.md](docs/component-2-cold-chain.md).

## Warehouse FEFO & QR (Component 3)

FEFO inventory, QR batch labels/scanning, movement history and storage-location
recommendations, under **Warehouse** in the sidebar. Apply
`supabase/migrations/20261008000000_create_warehouse_schema.sql`, run the
backend and the Python service in `ai-service/`. Architecture, API, database,
FEFO/QR/allocation logic and setup: [docs/component-3-warehouse.md](docs/component-3-warehouse.md).

## Pharmacy analytics & stock optimisation (Component 4)

Batch-level pharmacy inventory, receiving (Confirm Receipt for matching
deliveries; scan only disputed items to report discrepancies), POS billing
(FEFO), purchase orders and returns shared with the warehouse application, and
lightweight analytics: burn rate, stock cover, a linear-regression demand
forecast (trained with scikit-learn in the `ai-service`) compared against a
moving-average baseline, and rule-based reorder
quantities (Q*), under **Pharmacy** in the sidebar. Apply
`supabase/migrations/20261010000000_create_pharmacy_schema.sql`,
`20261010000001_create_pharmacy_functions.sql`,
`20261012000000_update_pharmacy_receiving.sql`,
`20261016000000_pharmacy_inventory_holds.sql` and
`20261020000000_pharmacy_linear_regression_model.sql` in order, optionally run
`supabase/seed/sample_pharmacy.sql` (SAMPLE pharmacies with synthetic history),
and run the backend. Roles, workflows, formulas, the warehouse integration
contract and setup: [docs/component-4-pharmacy.md](docs/component-4-pharmacy.md).
