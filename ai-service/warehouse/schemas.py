"""Request/response models for the spatial allocation API (camelCase JSON)."""

from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

StorageCondition = Literal["ambient", "cool", "refrigerated", "frozen"]


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class ThresholdsIn(CamelModel):
    near_expiry_days: int = Field(90, ge=2)
    critical_expiry_days: int = Field(30, ge=1)

    @model_validator(mode="after")
    def near_after_critical(self) -> "ThresholdsIn":
        if self.near_expiry_days <= self.critical_expiry_days:
            raise ValueError("nearExpiryDays must be greater than criticalExpiryDays")
        return self


class BatchIn(CamelModel):
    batch_id: str | None = None
    medicine_id: str | None = None
    quantity: int = Field(gt=0)
    expiry_date: date
    storage_condition: StorageCondition
    is_controlled: bool = False
    status: Literal["active", "quarantined", "recalled", "disposed"] = "active"


class LocationIn(CamelModel):
    id: str
    code: str
    zone_type: Literal["storage", "quarantine"]
    storage_condition: StorageCondition
    capacity_units: int = Field(gt=0)
    occupied_units: int = Field(ge=0)
    is_secure: bool = False
    is_active: bool = True
    accessibility: Literal["high", "medium", "low"] = "medium"
    distance_to_dispatch_m: float = Field(0.0, ge=0)
    level: int = Field(1, ge=1)
    zone_code: str | None = None
    rack_code: str | None = None
    same_batch_units: int = Field(0, ge=0)
    same_medicine_units: int = Field(0, ge=0)
    other_medicine_units: int = Field(0, ge=0)
    same_medicine_in_rack: bool = False


class WeightsIn(CamelModel):
    expiry_accessibility: float = Field(0.40, ge=0)
    capacity_fit: float = Field(0.25, ge=0)
    consolidation: float = Field(0.25, ge=0)
    zone_efficiency: float = Field(0.10, ge=0)


class RecommendRequest(CamelModel):
    # Defaults to the service's date; the backend sends the warehouse's local date.
    today: date | None = None
    thresholds: ThresholdsIn = ThresholdsIn()
    batch: BatchIn
    locations: list[LocationIn] = Field(max_length=10_000)
    weights: WeightsIn | None = None
    limit: int = Field(5, ge=1, le=20)


class CandidateOut(CamelModel):
    rank: int
    location_id: str
    code: str
    zone_code: str | None
    rack_code: str | None
    accessibility: str
    distance_to_dispatch_m: float
    score: float
    factors: dict[str, float]
    reasons: list[str]
    available_units: int
    available_after_units: int
    utilization_after_pct: float


class RejectedOut(CamelModel):
    location_id: str
    code: str
    zone_code: str | None
    reasons: list[str]


class BatchAssessmentOut(CamelModel):
    days_to_expiry: int
    expiry_status: str
    urgency: float
    requires_quarantine: bool


class AlgorithmOut(CamelModel):
    name: str
    version: str
    description: str
    weights: dict[str, float]


class SummaryOut(CamelModel):
    candidates: int
    feasible: int
    rejected_by_reason: dict[str, int]


class RecommendResponse(CamelModel):
    algorithm: AlgorithmOut
    assessment: BatchAssessmentOut
    recommended: CandidateOut | None
    alternatives: list[CandidateOut]
    rejected: list[RejectedOut]
    summary: SummaryOut
    message: str | None
