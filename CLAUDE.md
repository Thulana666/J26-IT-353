# PharmaTwin - Claude Code Project Context

## 1. PROJECT

Project:
AI-Driven Digital Twin for Resilient Pharmaceutical Supply Chain Optimization

This is a final-year undergraduate IT research project.

The overall system combines four research components to improve
pharmaceutical supply-chain resilience and decision-making.

IMPORTANT:
This repository is ONLY for developing Component 1:
Global Event Analysis and Demand Forecasting.

Do NOT implement the other research components unless explicitly
requested.

---

## 2. FOUR RESEARCH COMPONENTS

### Component 1 - Global Event Analysis and Demand Forecasting
THIS IS THE COMPONENT BEING DEVELOPED IN THIS REPOSITORY.

Purpose:
Identify pharmaceutical-relevant external events, analyze their
potential impact on medicine demand, and use event-derived information
with historical demand data for demand forecasting.

Primary implementation focus:
Sri Lanka.

---

### Component 2 - IoT Cold-Chain Tracking and Logistics Risk Prediction

Purpose:
Monitor pharmaceutical transportation using IoT/environmental data,
GPS and temperature/humidity information, and predict logistics and
cold-chain risks.

This component is NOT implemented in this repository.

---

### Component 3 - Intelligent Pharmacy Analytics and Dynamic Price Prediction

Purpose:
Analyze pharmacy stock, medicine demand/burn-rate, supplier prices
and economic information to support demand and price prediction and
purchasing decisions.

This component is NOT implemented in this repository.

---

### Component 4 - Intelligent Warehouse FEFO and QR Spatial Management

Purpose:
Manage pharmaceutical warehouse inventory using QR identification,
FEFO, warehouse/rack management and intelligent spatial allocation.

This component is NOT implemented in this repository.

---

## 3. OVERALL SYSTEM

The four components form one integrated pharmaceutical supply-chain
digital twin.

High-level flow:

Global Events
    ↓
Component 1: Event Analysis + Demand Forecasting
    ↓
Pharmacy / Demand Intelligence
    ↓
Warehouse / Procurement
    ↓
Component 2: Cold-Chain + Logistics Risk
    ↓
Pharmacy
    ↓
Component 3: Pharmacy Analytics + Price Prediction

Component 4 provides intelligent warehouse management.

Component 1 is an EARLY DEMAND-SIGNAL provider for the wider system.

Do not make Component 1 responsible for warehouse, logistics,
procurement, pharmacy operations or pricing.

---

# 4. COMPONENT 1

## Objective

Develop an AI-based Global Event Analysis and Demand Forecasting
component that:

1. Identifies pharmaceutical-relevant events.
2. Extracts important event information.
3. Maps events to potentially affected medicine categories.
4. Generates event-derived demand indicators/features.
5. Combines these features with historical pharmaceutical demand.
6. Forecasts future demand.
7. Evaluates the event-aware model against a historical-demand-only
   baseline.

---

## 5. PRIMARY FOCUS: SRI LANKA

Although the research concept is Global Event Analysis, the prototype
focuses mainly on Sri Lanka because of the limited development period
and available data.

Prioritize:

- Sri Lankan events
- Sri Lankan provinces
- Sri Lankan districts
- Sri Lankan health situations
- pharmaceutical demand relevant to Sri Lanka

International events may be included when they can affect Sri Lankan
pharmaceutical demand.

Do not build an unnecessarily complex global system.

---

# 6. COMPONENT 1 PIPELINE

The intended pipeline is:

External Sources
    ↓
News / WHO / Health / Crisis Information
    ↓
Article Storage
    ↓
NLP Event Analysis
    ↓
Event Identification
    ↓
Disease / Location / Severity Extraction
    ↓
Event → Medicine Mapping
    ↓
Event-Derived Features
    +
Historical Pharmaceutical Demand
    ↓
Demand Forecasting
    ↓
Forecast Results
    ↓
Dashboard

The system should eventually automate this pipeline as much as
practical.

---

# 7. EXTERNAL DATA

Potential sources include:

- Sri Lankan news
- News relevant to Sri Lanka
- WHO alerts
- Public health reports
- Crisis/disaster information
- Other reliable public sources

Store source information and article information before performing
advanced AI processing.

Do not assume every article is a relevant event.

---

# 8. ARTICLE DATA

Articles should contain information such as:

- Title
- Content or relevant text
- Source
- URL
- Published date
- Country
- Language
- Collection date
- Processing status

The existing `Articles / Sources` page should eventually display real
database data instead of mock data.

---

# 9. EVENT ANALYSIS

The NLP/event-analysis stage should identify whether an article contains
a pharmaceutical-relevant event.

Important event attributes include:

- Event name
- Event type
- Disease
- Location
- Date
- Severity
- Description
- Confidence

Possible event types include:

- Disease outbreak
- Epidemic/pandemic
- Flood
- Extreme weather
- Natural disaster
- Public health emergency
- Import/supply disruption
- Other pharmaceutical-relevant events

Keep classifications practical. Do not create unnecessary categories.

---

# 10. EVENTS ARE AI-GENERATED

Events should NOT primarily depend on manual event creation.

Intended workflow:

Article
  ↓
NLP analysis
  ↓
Relevant event detected
  ↓
Event created/updated
  ↓
Medicine impact generated
  ↓
Dashboard updated

The existing Events page should eventually display events generated
from analyzed external data.

Administrative review/edit/override can be added later if necessary,
but manual CRUD is NOT the primary workflow.

---

# 11. EVENT → MEDICINE IMPACT

A major part of Component 1 is connecting events to potentially
affected medicine categories.

Example:

Dengue outbreak
    ↓
Dengue
    ↓
Relevant medicine categories
    ↓
Potential demand increase

Another example:

Flooding
    ↓
Increased risk of water-borne diseases
    ↓
Relevant medicine categories
    ↓
Potential demand impact

Store information such as:

- Event
- Medicine category
- Impact type
- Impact score
- Confidence
- Mapping method
- Notes

Impact types can include:

- INCREASE
- DECREASE
- UNKNOWN

During early development, simple rule-based or manually defined
mapping is acceptable.

AI/ML-based mapping can be introduced later.

Do not present estimated medicine impact as guaranteed demand.

---

# 12. DEMAND FORECASTING

Component 1 compares two approaches.

### Baseline

Historical-demand-only forecasting.

Uses historical pharmaceutical demand without external event features.

A suitable statistical baseline such as ARIMA may be used after
exploratory analysis.

### Proposed Model

Event-aware demand forecasting.

Uses:

Historical demand
+
Event-derived features

Possible event-derived features:

- Event count
- Event severity
- Event impact score
- Event type
- Disease indicators
- Location indicators

Do not assume the proposed model will perform better.

Performance must be demonstrated through evaluation.

---

# 13. EVALUATION

### Event/NLP analysis

Use appropriate metrics such as:

- Precision
- Recall
- F1-score

### Forecasting

Use appropriate metrics such as:

- MAE
- RMSE
- MAPE where appropriate
- MASE

Compare the historical-demand-only baseline with the event-aware model
using the same evaluation period/horizon.

Respect chronological ordering in time-series data.

Avoid data leakage.

---

# 14. DATABASE

The project uses PostgreSQL/Supabase.

Core Component 1 tables:

- `data_sources`
- `event_articles`
- `events`
- `locations`
- `event_locations`
- `diseases`
- `medicine_categories`
- `event_medicine_impacts`
- `demand_records`

Later/AI-related tables:

- `event_features_daily`
- `forecast_runs`
- `demand_forecasts`

Do not create unnecessary tables.

Always inspect the existing database before creating or changing tables.

---

# 15. EXISTING APPLICATION

Authentication/login is already implemented.

The user can log in and access the dashboard.

Existing dashboard areas include:

- Dashboard
- Medicine Impact / Overview
- Events
- Articles / Sources
- Impact Analysis
- Demand
- Forecasts

These pages already exist and should be reused.

IMPORTANT:

Do not create duplicate pages.

Do not rebuild working authentication.

Do not unnecessarily redesign the existing UI.

Replace mock data progressively with real database/API data.

---

# 16. DEVELOPMENT ORDER

Prioritize development in this order:

1. Existing dashboard
2. Supabase/PostgreSQL connection
3. Articles / Sources
4. External data collection
5. NLP event analysis
6. AI-generated events
7. Event → medicine impact
8. Historical demand data
9. Event-derived features
10. Baseline forecasting
11. Event-aware forecasting
12. Evaluation
13. Final dashboard integration

Do not start with advanced ML before the basic data pipeline works.

---

# 17. THREE-WEEK CONSTRAINT

The Component 1 prototype should be developed within approximately
3 weeks.

Prefer:

- Simple architecture
- Existing project structure
- Reusable components
- Simple APIs
- Practical database design
- Manageable models
- Working end-to-end pipeline

Avoid unnecessary complexity such as:

- Microservices
- Kafka
- Data lakes
- Distributed systems
- Complex real-time streaming
- Complex AI agents
- Enterprise-scale architecture
- Overly complex ontologies

The goal is a working and academically defensible research prototype,
not a production-scale pharmaceutical platform.

---

# 18. TECHNOLOGY

Use the technologies already present in the project.

Expected direction:

Frontend:
- Next.js
- React
- TypeScript
- Tailwind CSS

Database:
- PostgreSQL
- Supabase

AI/ML:
- Python
- Pandas
- Scikit-learn
- TensorFlow/PyTorch where necessary
- Transformers/BERT/RoBERTa where appropriate

Backend/API:
- Follow the existing project architecture.
- Use a Python API/service such as FastAPI only where it is actually
  needed for AI/ML.

Do not introduce a new framework without a clear reason.

---

# 19. UI / DATA PRINCIPLES

The dashboard should help users understand:

- Current relevant events
- Event severity
- Locations
- Diseases
- Medicine impacts
- Historical demand
- Demand trends
- Forecasts
- Confidence
- Sources

Do not display fake precision.

Clearly distinguish:

- Mock/sample data
- Real collected data
- AI-generated results
- Predictions

Do not present placeholder values as real AI predictions.

---

# 20. CODING RULES

Before implementing any feature:

1. Inspect the existing code.
2. Understand the existing architecture.
3. Reuse existing components where possible.
4. Check the existing database before creating tables.
5. Check whether the requested functionality already exists.
6. Avoid duplicate pages/components/services.
7. Do not break authentication.
8. Keep changes focused on Component 1.
9. Keep implementation simple.
10. Test the implementation after making changes.

When modifying existing functionality, make the smallest reasonable
change.

Do not rewrite working code without a clear reason.

---

# 21. SCOPE BOUNDARY

This repository implements ONLY:

## Global Event Analysis and Demand Forecasting

Do NOT implement the internal functionality of:

- IoT cold-chain monitoring
- GPS/logistics risk prediction
- Pharmacy stock management
- Pharmacy price prediction
- Warehouse FEFO
- QR warehouse management
- Warehouse rack/spatial allocation

These belong to the other research components.

Component 1 may expose data/interfaces needed for future integration,
but should not implement those components.

---

# 22. FINAL TARGET

The final Component 1 should provide this working flow:

External Data
    ↓
Article Collection
    ↓
NLP Event Analysis
    ↓
Sri Lankan Pharmaceutical-Relevant Events
    ↓
Disease / Location / Severity
    ↓
Medicine Impact Mapping
    ↓
Historical Demand
    ↓
Event-Derived Features
    ↓
Baseline + Event-Aware Forecasting
    ↓
Evaluation
    ↓
Dashboard

Build this incrementally.

Prioritize a working end-to-end prototype over unnecessary complexity.