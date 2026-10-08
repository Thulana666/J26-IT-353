"""Storage-location recommendation for an incoming or re-slotted batch.

Method: rule-based multi-criteria scoring. It is a transparent heuristic
(no trained model); the weights are explicit and can be tuned, and the
module can later be replaced by a learned or optimisation-based allocator
behind the same interface.

1. Hard constraints remove locations that may not hold the batch. They
   mirror the checks in the database function record_inventory_movement(),
   which stays the final guard:
     - location active
     - zone storage condition equals the medicine's (ambient/cool/refrigerated/frozen)
     - controlled medicines only in secure zones
     - quarantined, recalled or expired batches only in quarantine zones,
       and active batches never in them
     - enough free capacity for the whole quantity
2. Every remaining location gets four factor scores in [0, 1]:
     expiry_accessibility  short-dated stock in easy-to-reach locations near
                           dispatch, long-dated stock deeper in the rack
                           (supports FEFO picking)
     capacity_fit          best fit: prefer locations the batch fills well,
                           keeping large free locations for large batches
     consolidation         keep a medicine together, avoid mixing medicines
                           in one location (picking errors)
     zone_efficiency       don't use scarce secure storage for non-controlled stock
3. score = 100 * sum(weight * factor); ties go to the location nearer dispatch.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

ALGORITHM_NAME = "weighted-multi-criteria"
ALGORITHM_VERSION = "1.0"

DEFAULT_WEIGHTS = {
    "expiry_accessibility": 0.40,
    "capacity_fit": 0.25,
    "consolidation": 0.25,
    "zone_efficiency": 0.10,
}

ACCESSIBILITY_SCORE = {"high": 1.0, "medium": 0.6, "low": 0.2}

# Urgency is 1 at or below the critical threshold and falls linearly to 0
# at this many days to expiry.
URGENCY_HORIZON_DAYS = 365

QUARANTINE_STATUSES = ("quarantined", "recalled")


@dataclass(frozen=True)
class Thresholds:
    near_expiry_days: int = 90
    critical_expiry_days: int = 30


@dataclass(frozen=True)
class BatchInput:
    quantity: int
    expiry_date: date
    storage_condition: str
    is_controlled: bool = False
    status: str = "active"
    batch_id: str | None = None
    medicine_id: str | None = None


@dataclass(frozen=True)
class LocationInput:
    id: str
    code: str
    zone_type: str
    storage_condition: str
    capacity_units: int
    occupied_units: int
    is_secure: bool = False
    is_active: bool = True
    accessibility: str = "medium"
    distance_to_dispatch_m: float = 0.0
    level: int = 1
    zone_code: str | None = None
    rack_code: str | None = None
    same_batch_units: int = 0
    same_medicine_units: int = 0
    other_medicine_units: int = 0
    same_medicine_in_rack: bool = False

    @property
    def available_units(self) -> int:
        return self.capacity_units - self.occupied_units


@dataclass
class Candidate:
    location: LocationInput
    score: float
    factors: dict[str, float]
    reasons: list[str]
    rank: int = 0


@dataclass
class Rejection:
    location: LocationInput
    # (code, message) pairs, e.g. ("capacity", "Only 10 unit(s) free; 40 needed").
    violations: list[tuple[str, str]]


@dataclass
class Recommendation:
    days_to_expiry: int
    expiry_status: str
    urgency: float
    requires_quarantine: bool
    weights: dict[str, float]
    ranked: list[Candidate] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)
    message: str | None = None


def expiry_status(days_to_expiry: int, thresholds: Thresholds) -> str:
    if days_to_expiry < 0:
        return "expired"
    if days_to_expiry <= thresholds.critical_expiry_days:
        return "critical"
    if days_to_expiry <= thresholds.near_expiry_days:
        return "near_expiry"
    return "ok"


def urgency(days_to_expiry: int, thresholds: Thresholds) -> float:
    critical = thresholds.critical_expiry_days
    if days_to_expiry <= critical:
        return 1.0
    horizon = max(URGENCY_HORIZON_DAYS, thresholds.near_expiry_days + 1)
    if days_to_expiry >= horizon:
        return 0.0
    return (horizon - days_to_expiry) / (horizon - critical)


def requires_quarantine(batch: BatchInput, today: date) -> bool:
    return batch.status in QUARANTINE_STATUSES or batch.expiry_date < today


def normalize_weights(weights: dict[str, float] | None) -> dict[str, float]:
    merged = {**DEFAULT_WEIGHTS, **(weights or {})}
    unknown = set(merged) - set(DEFAULT_WEIGHTS)
    if unknown:
        raise ValueError(f"Unknown weight(s): {', '.join(sorted(unknown))}")
    if any(value < 0 for value in merged.values()):
        raise ValueError("Weights must not be negative")
    total = sum(merged.values())
    if total <= 0:
        raise ValueError("At least one weight must be positive")
    return {name: value / total for name, value in merged.items()}


def hard_constraint_violations(
    batch: BatchInput, location: LocationInput, quarantine: bool
) -> list[tuple[str, str]]:
    violations = []
    if not location.is_active:
        violations.append(("inactive", "Location is inactive"))
    if location.storage_condition != batch.storage_condition:
        violations.append((
            "storage_condition",
            f"Needs {batch.storage_condition} storage; zone is {location.storage_condition}",
        ))
    if batch.is_controlled and not location.is_secure:
        violations.append(("security", "Controlled medicine needs a secure zone"))
    if quarantine and location.zone_type != "quarantine":
        violations.append(("zone_type", "Quarantined, recalled or expired stock must go to a quarantine zone"))
    if not quarantine and location.zone_type == "quarantine":
        violations.append(("zone_type", "Quarantine zones only hold quarantined, recalled or expired stock"))
    if location.available_units < batch.quantity:
        violations.append((
            "capacity",
            f"Only {max(location.available_units, 0)} unit(s) free; {batch.quantity} needed",
        ))
    return violations


def accessibility_score(location: LocationInput, max_distance: float) -> float:
    """How easy the location is to reach: shelf accessibility and distance to dispatch."""
    access = ACCESSIBILITY_SCORE.get(location.accessibility, ACCESSIBILITY_SCORE["medium"])
    proximity = 1.0 - location.distance_to_dispatch_m / max_distance if max_distance > 0 else 1.0
    return 0.6 * access + 0.4 * proximity


def consolidation_score(location: LocationInput) -> tuple[float, str]:
    if location.other_medicine_units > 0:
        return 0.1, "Shares the location with other medicines (higher risk of picking errors)"
    if location.same_batch_units > 0:
        return 1.0, "Tops up stock of the same batch"
    if location.same_medicine_units > 0:
        return 0.6, "Holds another batch of the same medicine; keep batch labels distinct"
    if location.same_medicine_in_rack:
        return 0.9, "Empty location in a rack that already holds this medicine"
    return 0.5, "Empty location"


def _score(
    batch: BatchInput,
    location: LocationInput,
    batch_urgency: float,
    days_to_expiry: int,
    max_distance: float,
    weights: dict[str, float],
) -> Candidate:
    access = accessibility_score(location, max_distance)
    consolidation, consolidation_reason = consolidation_score(location)
    factors = {
        "expiry_accessibility": 1.0 - abs(batch_urgency - access),
        "capacity_fit": batch.quantity / location.available_units,
        "consolidation": consolidation,
        # Secure storage is scarce; secure quarantine areas are normal.
        "zone_efficiency": 0.0
        if location.is_secure and location.zone_type == "storage" and not batch.is_controlled
        else 1.0,
    }
    score = 100.0 * sum(weights[name] * value for name, value in factors.items())

    if batch_urgency >= 0.6 and access >= 0.6:
        expiry_reason = (
            f"Expires in {days_to_expiry} days: easy-to-reach location "
            f"{location.distance_to_dispatch_m:g} m from dispatch, so it is picked first"
        )
    elif batch_urgency <= 0.4 and access <= 0.6:
        expiry_reason = f"{days_to_expiry} days of shelf life: a deeper location keeps prime slots for short-dated stock"
    else:
        expiry_reason = (
            f"Expiry urgency {batch_urgency:.2f} vs accessibility {access:.2f} "
            f"({location.accessibility}, {location.distance_to_dispatch_m:g} m from dispatch)"
        )
    left = location.available_units - batch.quantity
    reasons = [
        expiry_reason,
        f"Uses {factors['capacity_fit']:.0%} of the free space ({left} unit(s) left afterwards)",
        consolidation_reason,
    ]
    if factors["zone_efficiency"] == 0.0:
        reasons.append("Uses scarce secure-zone space for a non-controlled medicine")

    return Candidate(
        location=location,
        score=round(score, 1),
        factors={name: round(value, 3) for name, value in factors.items()},
        reasons=reasons,
    )


def recommend(
    batch: BatchInput,
    locations: list[LocationInput],
    today: date,
    thresholds: Thresholds = Thresholds(),
    weights: dict[str, float] | None = None,
) -> Recommendation:
    """Ranks every feasible location (best first) and lists the rejected ones."""
    normalized = normalize_weights(weights)
    days_to_expiry = (batch.expiry_date - today).days
    batch_urgency = urgency(days_to_expiry, thresholds)
    quarantine = requires_quarantine(batch, today)

    feasible: list[LocationInput] = []
    rejected: list[Rejection] = []
    for location in locations:
        violations = hard_constraint_violations(batch, location, quarantine)
        if violations:
            rejected.append(Rejection(location, violations))
        else:
            feasible.append(location)

    max_distance = max((loc.distance_to_dispatch_m for loc in feasible), default=0.0)
    ranked = [
        _score(batch, location, batch_urgency, days_to_expiry, max_distance, normalized)
        for location in feasible
    ]
    ranked.sort(key=lambda c: (-c.score, c.location.distance_to_dispatch_m, c.location.code))
    for index, candidate in enumerate(ranked, start=1):
        candidate.rank = index

    message = None
    if not ranked:
        # Locations that would fit apart from their free space.
        only_capacity = [
            r.location for r in rejected if {code for code, _ in r.violations} == {"capacity"}
        ]
        if only_capacity:
            largest = max(loc.available_units for loc in only_capacity)
            message = (
                f"No single compatible location can hold {batch.quantity} unit(s); the largest has "
                f"{largest} free. Split the batch across locations."
            )
        else:
            message = "No compatible location in this warehouse (see the rejected locations)."

    return Recommendation(
        days_to_expiry=days_to_expiry,
        expiry_status=expiry_status(days_to_expiry, thresholds),
        urgency=round(batch_urgency, 3),
        requires_quarantine=quarantine,
        weights={name: round(value, 4) for name, value in normalized.items()},
        ranked=ranked,
        rejected=rejected,
        message=message,
    )
