"""Request/response models for POST /cold-chain/predict (camelCase JSON).

The request is what backend/src/cold-chain/risk/provider.js sends; the
response must match what the backend stores (cold_chain_risk_predictions).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

RiskType = Literal["temperature_excursion", "humidity_deviation", "delivery_delay", "route_anomaly", "combined"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ReadingIn(CamelModel):
    recorded_at: datetime
    temperature_c: float | None = Field(None, ge=-60, le=85)
    humidity_pct: float | None = Field(None, ge=0, le=100)
    latitude: float | None = Field(None, ge=-90, le=90)
    longitude: float | None = Field(None, ge=-180, le=180)
    speed_kmh: float | None = Field(None, ge=0, le=250)
    quality_flags: list[str] = []


class LimitsIn(CamelModel):
    temp_min_c: float
    temp_max_c: float
    humidity_min_pct: float | None = None
    humidity_max_pct: float | None = None


class TripIn(CamelModel):
    expected_delivery_at: datetime | None = None
    started_at: datetime | None = None
    interval_seconds: int = 60


class PointIn(CamelModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)


DestinationIn = PointIn


class PredictRequest(CamelModel):
    # All readings since the trip started: distance travelled, elapsed time and
    # stop totals are computed from them, as in training.
    readings: list[ReadingIn]
    limits: LimitsIn
    trip: TripIn
    destination: PointIn | None = None
    origin: PointIn | None = None
    now: datetime


class PredictResponse(CamelModel):
    """riskProbability is the combined risk (risk.py); temperatureRisk and
    delayRisk are the model outputs (None when not estimated, see components)."""

    risk_level: Literal["low", "medium", "high"]
    risk_probability: float = Field(ge=0, le=1)
    risk_type: RiskType | None
    temperature_risk: float | None = Field(None, ge=0, le=1)
    delay_risk: float | None = Field(None, ge=0, le=1)
    explanation: str
    factors: dict = {}
    components: dict = {}
    combination: dict = {}
    horizon_minutes: int | None
    readings_used: int
    data_until: datetime | None
    cleaning: dict = {}
    model_name: str
    model_version: str
