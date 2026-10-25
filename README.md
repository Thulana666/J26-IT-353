&nbsp;

# PharmaTwin

### AI-Driven Digital Twin for Resilient Pharmaceutical Supply Chain Optimization

**J26-IT-353 · SLIIT Final Year Research Project**

[**Repository**](https://github.com/Thulana666/J26-IT-353) · [**Component Docs**](docs/)

&nbsp;

---

## What is PharmaTwin?

PharmaTwin is a full-stack digital twin of Sri Lanka's pharmaceutical supply chain. It follows medicines from **global events** that may disrupt supply, through the **warehouse** and **refrigerated transport**, to the **pharmacy shelf**. Along the way it uses **NLP**, **IoT sensor data**, **machine learning** and **explainable optimisation rules** to help the supply chain anticipate disruptions, protect cold-chain stock, dispatch by earliest expiry and reorder the right quantities.

All four components share one Supabase database, so a pharmacy's purchase order, the warehouse dispatch, the monitored truck trip and the pharmacy's receipt are one connected record.

---

## Features

### Component 1 — Global Event Analysis & Demand Forecasting

| Feature | Description |
| :---- | :---- |
| **Multi-source Ingestion** | Collects articles from WHO DON, ReliefWeb, GDACS, NewsAPI, Ministry of Health and Sri Lankan news RSS feeds |
| **Event Classification** | Frozen rules + fine-tuned DistilRoBERTa + hybrid classify articles into 6 event categories |
| **Sri Lanka Relevance** | Labels each article as direct / indirect / none / uncertain, with a reason |
| **Event Grouping** | Groups related articles into de-duplicated events with locations |
| **Automated Pipeline** | One-click or scheduled collect → analyse runs, with a shared lock and retries |
| **Labelled Dataset** | Label guide, grouped train/val/test split, frozen test set for evaluation |

&nbsp;

### Component 2 — IoT Cold-Chain Tracking & Logistics Risk

| Feature | Description |
| :---- | :---- |
| **Trip Workflow** | Dispatch → driver/truck allocation → in transit → delivery → history |
| **Live Sensor Data** | ESP32 loggers (SHT31 · NEO-6M · MPU6050) send temperature, humidity, GPS and speed |
| **Observed Alerts** | Temperature/humidity limit alerts that escalate and resolve automatically |
| **Risk Prediction** | Temperature-excursion, delay and route risk, refreshed every few minutes |
| **Driver Portal** | Drivers view and update their own trips |
| **Simulator** | Simulated sensor scenarios (normal, rising, excursion, humidity, GPS jump) for testing |

&nbsp;

### Component 3 — Intelligent Warehouse FEFO & QR Management

| Feature | Description |
| :---- | :---- |
| **FEFO Dispatch** | First-Expiry-First-Out picking, with override reasons and a compliance rate |
| **QR Batch Labels** | Check-digit QR codes for batches and storage locations; camera or scanner |
| **Spatial Allocation** | Ranked storage-location recommendations (expiry, capacity, consolidation, zone) |
| **Order Fulfilment** | Reserve, pick, verify and dispatch pharmacy orders; hand-off to Component 2 |
| **Movement History** | Transactional stock ledger, scan history, discrepancies and returns |

&nbsp;

### Component 4 — Intelligent Pharmacy Analytics & Stock Optimization

| Feature | Description |
| :---- | :---- |
| **Batch Inventory** | Batch-level stock with holds on disputed items |
| **Receiving** | Confirm receipt, or scan only disputed items to report discrepancies |
| **POS Billing** | Barcode point of sale that sells from the earliest-expiring batch (FEFO) |
| **Demand Forecasting** | Ridge regression forecast, used per product only where it beats the moving average |
| **Reorder Recommendations** | Rule-based Q\* with safety stock and a step-by-step explanation |
| **Stock Analytics** | Burn rate, days of cover, expiry risk, actual vs estimated, alerts |

&nbsp;

---

## Architecture

```
  WHO · ReliefWeb · GDACS · NewsAPI            ESP32 cold-chain loggers
  MoH · Daily Mirror · Daily News · Observer   (temp · humidity · GPS · speed)
                  │                                        │ HTTPS + device key
                  │                                        │
┌──────────────────┼────────────────────────────────────────┼────────────────┐
│                  │      Next.js 16 frontend (App Router)  │                │
│                  │  Server Components · Server Actions    │                │
│                  │  Medicine Impact · Cold Chain ·        │                │
│                  │  Warehouse · Pharmacy dashboards       │                │
└──────────────────┼───────────────────┬────────────────────┼────────────────┘
                   │                   │  user's Supabase   │
                   │                   │  access token      │
┌──────────────────▼───────────────────▼────────────────────▼────────────────┐
│                    Express 5 backend API  (:5000)                          │
│    Auth & role checks · Zod validation · schedulers · ingestion            │
│  /api/ingestion · /api/event-intel · /api/cold-chain · /api/warehouse ·    │
│  /api/medicines · /api/pharmacy                                            │
└──────┬─────────────────────────────────────────────────────┬───────────────┘
       │ service role                                        │ HTTP (data sent
       │                                                     │ with each request)
┌──────▼───────────────────────┐         ┌───────────────────▼───────────────┐
│          Supabase            │         │   FastAPI AI service  (:8000)     │
│  PostgreSQL · Auth · RLS     │         │   stateless, no DB access         │
│  Realtime · SQL functions    │         │  /event-intel/classify            │
│  (transactional stock ops)   │         │  /cold-chain/predict              │
└──────────────┬───────────────┘         │  /warehouse/spatial/recommend     │
               │ Realtime                │  /pharmacy-demand/train           │
               ▼                         └───────────────────────────────────┘
        live dashboards
```

The browser never sees the Supabase secret key. Every write goes Next.js server action → backend → database function.

&nbsp;

---

## Tech Stack

**Frontend**

- Next.js 16 (App Router, Server Components, Server Actions) · React 19
- JavaScript · Tailwind CSS 4 · shadcn/ui · Base UI
- Recharts · Motion · lucide-react
- jsQR / `BarcodeDetector` for camera QR and barcode scanning
- Supabase SSR auth with role-based navigation

**Backend API**

- Node.js · Express 5
- Supabase JS (service role, server-side only) · Zod validation
- `qrcode` label generation
- In-process schedulers for the event pipeline, cold-chain risk and pharmacy forecasts

**AI Service (Python)**

- FastAPI · Uvicorn
- PyTorch · Hugging Face Transformers (DistilRoBERTa event classifier, CNN-LSTM)
- scikit-learn (Ridge regression, logistic regression, random forest, gradient boosting)
- NumPy · Matplotlib (evaluation plots)

**Database**

- Supabase PostgreSQL with Row-Level Security on every table
- Transactional SQL functions for all stock changes
- Supabase Realtime for shipments, alerts, discrepancies and stock
- Supabase Auth with `profiles` roles (admin, warehouse_staff, pharmacy_staff, user)

**IoT**

- ESP32 with SHT31 (temperature/humidity), NEO-6M (GPS), MPU6050 (motion)
- Per-device keys stored as SHA-256 hashes

**Testing**

- `node --test` with PGlite and embedded-PostgreSQL database and concurrency tests
- Python `unittest` for the AI service, dataset tools and frozen rules

---

## Repository Layout

```
J26-IT-353/
├── frontend/                     # Next.js 16 web app
│   └── src/app/dashboard/        # Medicine Impact · cold-chain · warehouse · pharmacy
├── backend/                      # Express 5 API
│   ├── src/
│   │   ├── ingestion/            # C1: article collectors (WHO, ReliefWeb, GDACS, RSS...)
│   │   ├── event-intel/          # C1: NLP processing pipeline & events
│   │   ├── cold-chain/           # C2: trips, readings, alerts, risk/
│   │   ├── warehouse/            # C3: FEFO, QR, fulfilment, integrations
│   │   └── pharmacy/             # C4: inventory, POS, orders, analytics/
│   ├── scripts/                  # collectors, exporters, simulator, model training
│   └── test/                     # unit, HTTP, PGlite & concurrency tests
├── ai-service/                   # FastAPI AI / optimisation service
│   ├── event_intel/              # C1: classifier, dataset tools, experiments
│   ├── cold_chain/               # C2: preprocessing, CNN-LSTM, training, inference
│   ├── warehouse/                # C3: spatial allocation
│   ├── pharmacy_demand/          # C4: Ridge demand model
│   ├── data/                     # label guide, manifests, splits (allow-listed)
│   └── tests/
├── supabase/
│   ├── migrations/               # schema, RLS, functions (apply in filename order)
│   └── seed/                     # SAMPLE data & synthetic-history cleanup
└── docs/                         # per-component technical documentation
```

&nbsp;

---

## ML Models

| Model | Task | Status |
| :---- | :---- | :---- |
| Rules baseline v0.1.0 | Event category & Sri Lanka relevance (baseline) | Frozen for comparison |
| DistilRoBERTa (fine-tuned) | 6-class event classification | Deployed in AI service |
| Hybrid (rules + DistilRoBERTa) | Final article classification | Deployed in AI service |
| CNN-LSTM | Temperature-excursion risk | Pipeline ready, awaiting real trip data |
| LR · Random Forest · GBM | Temperature-risk baselines | Pipeline ready, awaiting real trip data |
| Gradient Boosting (tuned) | Late-delivery risk | Pipeline ready, awaiting real trip data |
| Rule-based prototype | Cold-chain risk (temporary) | In use, labelled as prototype |
| Ridge regression | Pharmacy daily demand forecast | In use where it beats the 28-day moving average |
| Multi-criteria heuristic | Warehouse storage-location ranking | In use (not a trained model) |
| Q\* reorder rule | Reorder quantity with safety stock | In use (rule-based, explainable) |

Evaluation rules: the event test split is used once for the final comparison, rules predictions are never used as labels, and models trained on test or simulated cold-chain data are refused at install time. See [ai-service/data/README.md](ai-service/data/README.md).

&nbsp;

---

## Team

| Member | Component | Responsibility |
| :---- | :---- | :---- |
| **Thulana De Silva** | Component 1 — Global Event Analysis | Ingestion · Event Classification · Relevance · Demand Signals |
| **_Name_** | Component 2 — Cold-Chain Tracking | IoT Tracking · Alerts · Risk Prediction |
| **_Name_** | Component 3 — Warehouse | FEFO · QR · Spatial Allocation · Fulfilment |
| **_Name_** | Component 4 — Pharmacy Analytics | Inventory · POS · Demand Forecast · Q\* |

&nbsp;

---

## Getting Started (Local)

**Prerequisites:** Node.js ≥ 20.9, npm, Python ≥ 3.10, a Supabase project

```sh
# 1. Clone
git clone https://github.com/Thulana666/J26-IT-353.git
cd J26-IT-353

# 2. Database: apply supabase/migrations/ in filename order
#    (Supabase SQL editor, or `supabase db push`), then:
#    notify pgrst, 'reload schema';
#    Optional sample data: supabase/seed/*.sql

# 3. Backend API
cd backend
cp .env.example .env
# Fill in: SUPABASE_URL, SUPABASE_SECRET_KEY, INGESTION_API_KEY
#          (+ optional NEWS_API_KEY, RELIEFWEB_APPNAME, AI_SERVICE_URL ...)
npm install
npm run dev
# → http://localhost:5000

# 4. AI service (new terminal)
cd ai-service
python -m venv .venv
.venv\Scripts\pip install -r requirements-event-model.txt   # macOS/Linux: .venv/bin/pip
cp .env.example .env                                          # EVENT_INTEL_MODEL_DIR
.venv\Scripts\uvicorn main:app --port 8000
# → http://localhost:8000/health

# 5. Frontend (new terminal)
cd frontend
cp .env.example .env.local
# Fill in: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
#          INGESTION_API_KEY (same as backend), BACKEND_URL=http://localhost:5000
npm install
npm run dev
# → http://localhost:3000
```

Sign up at `/signup`, then set the user's `role` in the `profiles` table (`admin`, `warehouse_staff`, `pharmacy_staff` or `user`).

**Run the tests**

```sh
cd backend && npm test
cd ai-service && .venv\Scripts\python -m unittest discover tests
cd frontend && npm run lint && npm run build
```

**Useful scripts** (from `backend/`)

```sh
npm run collect:articles                 # collect articles from all sources
npm run process:articles -- 200          # classify up to 200 pending articles
npm run train:pharmacy-model             # print the demand-model report
node --env-file=.env scripts/simulate-cold-chain.js --shipment SH-xxxxxx --scenario rising
```

&nbsp;

---

## Component Documentation

| Component | Document |
| :---- | :---- |
| Component 1 — Global Event Analysis & Demand Forecasting | [docs/component-1-event-intelligence.md](docs/component-1-event-intelligence.md) |
| Component 2 — IoT Cold-Chain Tracking & Logistics Risk | [docs/component-2-cold-chain.md](docs/component-2-cold-chain.md) |
| Component 3 — Intelligent Warehouse FEFO & QR | [docs/component-3-warehouse.md](docs/component-3-warehouse.md) |
| Component 4 — Pharmacy Analytics & Stock Optimization | [docs/component-4-pharmacy.md](docs/component-4-pharmacy.md) |
| Event dataset & labelling | [ai-service/data/README.md](ai-service/data/README.md) |
| Cold-chain model training | [ai-service/cold_chain/models/README.md](ai-service/cold_chain/models/README.md) |

&nbsp;

| Service | Default URL |
| :---- | :---- |
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:5000 (`/api/health`) |
| AI service | http://localhost:8000 (`/health`, `/docs`) |

&nbsp;

---

## License

Academic use only — SLIIT J26-IT-353 Research Project · 2026
