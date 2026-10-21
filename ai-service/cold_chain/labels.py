"""Training labels, computed only from what actually happened on a trip.

Temperature excursion (per window ending at `now`)
  1  the temperature leaves the shipment's own limits (temp_min_c..temp_max_c)
     within the horizon [now, now + horizon), for at least
     `min_excursion_minutes` (0 = a single reading outside the limits counts)
  0  no excursion starts within the horizon and the sensor covered enough of it
  None (not used) when the label cannot be known:
     ongoing_excursion       already outside the limits at `now` (that is
                             detection, not prediction)
     horizon_after_trip_end  the trip ended before the horizon did
     sparse_future_data      too few readings in the horizon to say "no excursion"

  Threshold source: the limits stored on each shipment (cold_chain_shipments
  temp_min_c / temp_max_c), set from the products' storage condition and
  editable by staff. No safety limit is invented here.

Delivery delay (per trip)
  1  delivered_at > planned delivery time at the trip start + tolerance
  0  delivered on time
  None when the trip is not delivered or had no planned delivery time.
"""

from __future__ import annotations

from bisect import bisect_left
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta

from .preprocessing import Reading


@dataclass(frozen=True)
class ExcursionLabelConfig:
    horizon_minutes: int = 30
    min_excursion_minutes: float = 0.0
    # Share of the horizon's minutes that must contain a temperature reading
    # before "no excursion" (0) is accepted.
    min_future_coverage: float = 0.5
    exclude_ongoing: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class DelayLabelConfig:
    tolerance_minutes: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def _outside(value: float, low: float, high: float) -> bool:
    return value < low or value > high


def temperature_excursion_label(
    readings: list[Reading],
    *,
    now: datetime,
    trip_end: datetime,
    temp_min_c: float,
    temp_max_c: float,
    config: ExcursionLabelConfig = ExcursionLabelConfig(),
) -> tuple[int | None, str]:
    """(label, reason). `readings` are the trip's cleaned readings (sorted).
    Readings before `now` are the past, as in preprocessing.build_grid."""
    horizon_end = now + timedelta(minutes=config.horizon_minutes)
    if horizon_end > trip_end:
        return None, "horizon_after_trip_end"
    measured = [r for r in readings if r.temperature_c is not None]
    times = [r.recorded_at for r in measured]
    split = bisect_left(times, now)
    if config.exclude_ongoing and split > 0 and _outside(measured[split - 1].temperature_c, temp_min_c, temp_max_c):
        return None, "ongoing_excursion"

    future = measured[split:]
    for i, reading in enumerate(future):
        if reading.recorded_at >= horizon_end:
            break
        if not _outside(reading.temperature_c, temp_min_c, temp_max_c):
            continue
        # An excursion starts here; it lasts until the next reading back in range
        # (or the trip end), even if that is after the horizon.
        back = next((r.recorded_at for r in future[i + 1 :] if not _outside(r.temperature_c, temp_min_c, temp_max_c)), trip_end)
        if (back - reading.recorded_at).total_seconds() / 60 >= config.min_excursion_minutes:
            return 1, "excursion"

    covered = {int((r.recorded_at - now).total_seconds() // 60) for r in future if r.recorded_at < horizon_end}
    if len(covered) / config.horizon_minutes < config.min_future_coverage:
        return None, "sparse_future_data"
    return 0, "no_excursion"


def delivery_delay_label(
    *, delivered_at: datetime | None, expected_delivery_at: datetime | None, config: DelayLabelConfig = DelayLabelConfig()
) -> tuple[int | None, str]:
    if delivered_at is None:
        return None, "not_delivered"
    if expected_delivery_at is None:
        return None, "no_planned_delivery_time"
    late = delivered_at > expected_delivery_at + timedelta(minutes=config.tolerance_minutes)
    return int(late), "late" if late else "on_time"
