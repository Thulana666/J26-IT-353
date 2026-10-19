"""Overall cold-chain / logistics risk: a transparent, configurable
combination of the model outputs (Component 2).

The combination is a design choice, not a trained or validated model; it is
documented so it can be justified, changed and compared. Inputs are the
components that could be estimated (temperature excursion, delivery delay);
a component that could not be estimated is left out and named.

Methods (COLD_CHAIN_RISK_COMBINATION):
  max            overall = the highest component risk (default). It makes no
                 assumption about how the risks interact and is never lower
                 than any single risk.
  noisy_or       1 - (1 - p_temperature)(1 - p_delay): the chance that at
                 least one event happens IF the events were independent and
                 the scores calibrated probabilities (neither is established).
  weighted_mean  sum(w * p) / sum(w) over the available components
                 (COLD_CHAIN_RISK_WEIGHTS, e.g. "temperature=0.7,delay=0.3").

Levels (same defaults as the backend): LOW below COLD_CHAIN_RISK_MEDIUM
(0.3), HIGH from COLD_CHAIN_RISK_HIGH (0.7), MEDIUM in between. The risk type
is the component at or above the MEDIUM level, or "combined" when both are.

Caveats: the components have different horizons (temperature: the next
`horizon` minutes; delay: the rest of the trip), and models trained with class
weights give risk scores, not calibrated probabilities. Calibrate on real
validation data before reading the numbers as frequencies.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field

METHODS = ("max", "noisy_or", "weighted_mean")
RISK_TYPES = {"temperature": "temperature_excursion", "delay": "delivery_delay"}


@dataclass(frozen=True)
class RiskConfig:
    method: str = "max"
    weights: dict = field(default_factory=lambda: {"temperature": 0.5, "delay": 0.5})
    medium: float = 0.3
    high: float = 0.7

    def __post_init__(self):
        if self.method not in METHODS:
            raise ValueError(f"Unknown combination method {self.method!r}: use one of {', '.join(METHODS)}")
        if not 0 < self.medium < self.high <= 1:
            raise ValueError("Risk levels need 0 < medium < high <= 1")
        if any(w < 0 for w in self.weights.values()) or not any(self.weights.values()):
            raise ValueError("Weights must be non-negative and not all zero")

    @classmethod
    def from_env(cls, env=os.environ) -> RiskConfig:
        weights = {"temperature": 0.5, "delay": 0.5}
        for part in filter(None, env.get("COLD_CHAIN_RISK_WEIGHTS", "").split(",")):
            name, _, value = part.partition("=")
            if name.strip() not in weights:
                raise ValueError(f"Unknown risk component {name.strip()!r} in COLD_CHAIN_RISK_WEIGHTS")
            weights[name.strip()] = float(value)
        return cls(
            method=env.get("COLD_CHAIN_RISK_COMBINATION", "max"),
            weights=weights,
            medium=float(env.get("COLD_CHAIN_RISK_MEDIUM", 0.3)),
            high=float(env.get("COLD_CHAIN_RISK_HIGH", 0.7)),
        )

    def level(self, probability: float) -> str:
        return "high" if probability >= self.high else "medium" if probability >= self.medium else "low"

    def to_dict(self) -> dict:
        return asdict(self)


def combine(components: dict[str, float | None], config: RiskConfig = RiskConfig()) -> dict:
    """components: {"temperature": p | None, "delay": p | None} -> overall
    {riskLevel, riskProbability, riskType, combination}."""
    available = {name: p for name, p in components.items() if p is not None}
    if not available:
        raise ValueError("No risk component could be estimated")
    if config.method == "max":
        probability = max(available.values())
    elif config.method == "noisy_or":
        remaining = 1.0
        for p in available.values():
            remaining *= 1 - p
        probability = 1 - remaining
    else:
        total = sum(config.weights[name] for name in available)
        if not total:
            raise ValueError("The available components all have weight 0")
        probability = sum(config.weights[name] * p for name, p in available.items()) / total
    elevated = [name for name, p in sorted(available.items(), key=lambda item: -item[1]) if p >= config.medium]
    return {
        "riskLevel": config.level(probability),
        "riskProbability": round(probability, 4),
        "riskType": None if not elevated else "combined" if len(elevated) > 1 else RISK_TYPES[elevated[0]],
        "combination": {
            "method": config.method,
            "levels": {"medium": config.medium, "high": config.high},
            **({"weights": config.weights} if config.method == "weighted_mean" else {}),
            "used": sorted(available),
            "missing": sorted(name for name, p in components.items() if p is None),
        },
    }
