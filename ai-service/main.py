"""PharmaTwin AI/optimisation service.

Currently serves Component 3 (warehouse spatial allocation). It is stateless
and has no database access: the Node.js backend sends the current warehouse
state with each request.

Run (from ai-service/):  uvicorn main:app --port 8000
"""

from fastapi import FastAPI

from warehouse.router import router as warehouse_router

app = FastAPI(title="PharmaTwin AI service", version="0.1.0")
app.include_router(warehouse_router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "pharmatwin-ai-service", "modules": ["warehouse.spatial"]}
