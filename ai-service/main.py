"""PharmaTwin AI/optimisation service.

Serves Component 3 (warehouse spatial allocation) and Component 2 (cold-chain
risk prediction with the installed trained models; /cold-chain/predict
answers 501 while none is installed, see cold_chain/models/README.md) and
Component 1 (article classification, /event-intel/classify: rules + fine-tuned
DistilRoBERTa when EVENT_INTEL_MODEL_DIR is set, see event_intel/service) and
Component 4 (pharmacy demand model, /pharmacy-demand/train: scikit-learn ridge
regression evaluated against a moving average, see pharmacy_demand). It is
stateless and has no database access: the Node.js backend sends the data with
each request.

Run (from ai-service/):  uvicorn main:app --port 8000
"""

from fastapi import FastAPI

from cold_chain.router import router as cold_chain_router
from event_intel.service.router import router as event_intel_router
from pharmacy_demand.router import router as pharmacy_demand_router
from warehouse.router import router as warehouse_router

app = FastAPI(title="PharmaTwin AI service", version="0.1.0")
app.include_router(warehouse_router)
app.include_router(cold_chain_router)
app.include_router(event_intel_router)
app.include_router(pharmacy_demand_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "pharmatwin-ai-service",
            "modules": ["warehouse.spatial", "cold_chain.predict", "event_intel.classify", "pharmacy_demand.train"]}
