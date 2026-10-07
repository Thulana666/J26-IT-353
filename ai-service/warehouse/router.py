"""HTTP API for warehouse spatial allocation (Component 3)."""

from __future__ import annotations

from collections import Counter
from datetime import date

from fastapi import APIRouter

from . import spatial
from .schemas import (
    AlgorithmOut,
    BatchAssessmentOut,
    CandidateOut,
    RecommendRequest,
    RecommendResponse,
    RejectedOut,
    SummaryOut,
)

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

# Factor names in API responses.
FACTOR_KEYS = {
    "expiry_accessibility": "expiryAccessibility",
    "capacity_fit": "capacityFit",
    "consolidation": "consolidation",
    "zone_efficiency": "zoneEfficiency",
}
# Rejected locations listed in a response (all are counted in the summary).
MAX_REJECTED_LISTED = 50


def _candidate_out(candidate: spatial.Candidate, quantity: int) -> CandidateOut:
    location = candidate.location
    after = location.available_units - quantity
    return CandidateOut(
        rank=candidate.rank,
        location_id=location.id,
        code=location.code,
        zone_code=location.zone_code,
        rack_code=location.rack_code,
        accessibility=location.accessibility,
        distance_to_dispatch_m=location.distance_to_dispatch_m,
        score=candidate.score,
        factors={FACTOR_KEYS[name]: value for name, value in candidate.factors.items()},
        reasons=candidate.reasons,
        available_units=location.available_units,
        available_after_units=after,
        utilization_after_pct=round(100 * (location.capacity_units - after) / location.capacity_units, 1),
    )


@router.post("/spatial/recommend", response_model=RecommendResponse)
def recommend(request: RecommendRequest) -> RecommendResponse:
    batch = spatial.BatchInput(**request.batch.model_dump())
    locations = [spatial.LocationInput(**location.model_dump()) for location in request.locations]
    weights = request.weights.model_dump() if request.weights else None

    result = spatial.recommend(
        batch=batch,
        locations=locations,
        today=request.today or date.today(),
        thresholds=spatial.Thresholds(**request.thresholds.model_dump()),
        weights=weights,
    )

    top = [_candidate_out(c, batch.quantity) for c in result.ranked[: request.limit]]
    reasons = Counter(code for rejection in result.rejected for code, _ in rejection.violations)
    return RecommendResponse(
        algorithm=AlgorithmOut(
            name=spatial.ALGORITHM_NAME,
            version=spatial.ALGORITHM_VERSION,
            description=(
                "Rule-based multi-criteria scoring: hard storage constraints, then a weighted sum "
                "of expiry/accessibility match, capacity fit, consolidation and zone efficiency."
            ),
            weights={FACTOR_KEYS[name]: value for name, value in result.weights.items()},
        ),
        assessment=BatchAssessmentOut(
            days_to_expiry=result.days_to_expiry,
            expiry_status=result.expiry_status,
            urgency=result.urgency,
            requires_quarantine=result.requires_quarantine,
        ),
        recommended=top[0] if top else None,
        alternatives=top[1:],
        rejected=[
            RejectedOut(
                location_id=r.location.id,
                code=r.location.code,
                zone_code=r.location.zone_code,
                reasons=[message for _, message in r.violations],
            )
            for r in result.rejected[:MAX_REJECTED_LISTED]
        ],
        summary=SummaryOut(
            candidates=len(locations),
            feasible=len(result.ranked),
            rejected_by_reason=dict(reasons),
        ),
        message=result.message,
    )
