"""Sensor history -> fixed-length feature sequence for the CNN-LSTM.

Pure Python (no numpy), so it is shared by inference and training and tested
without the ML stack. A sequence covers the last `steps` x `step_seconds`
before `now`, one row per step:

  temperature_pos   temperature relative to the limits: 0 = min, 1 = max
  humidity          relative humidity / 100
  speed             speed / 100 km/h
  hour_sin/hour_cos time of day (Sri Lanka), cyclic
  minutes_to_eta    minutes to the expected delivery / 120 (clipped to -1..1)
  km_to_destination distance to the pharmacy / 50 km (clipped to 0..1)
  gps_jump          1 if the reading was flagged as a GPS jump
  observed          1 if a reading fell into this step, else 0 (values carried
                    forward from the last reading; missing data is never invented
                    silently: the mask says which steps were measured)
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

FEATURES = (
    "temperature_pos",
    "humidity",
    "speed",
    "hour_sin",
    "hour_cos",
    "minutes_to_eta",
    "km_to_destination",
    "gps_jump",
    "observed",
)
SRI_LANKA = timezone(timedelta(hours=5, minutes=30))


@dataclass(frozen=True)
class Reading:
    recorded_at: datetime
    temperature_c: float | None = None
    humidity_pct: float | None = None
    latitude: float | None = None
    longitude: float | None = None
    speed_kmh: float | None = None
    gps_jump: bool = False


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    h = math.sin(d_lat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    return 2 * 6371 * math.asin(min(1.0, math.sqrt(h)))


def _clip(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def build_sequence(
    readings: list[Reading],
    *,
    temp_min_c: float,
    temp_max_c: float,
    now: datetime,
    expected_delivery_at: datetime | None = None,
    destination: tuple[float, float] | None = None,
    steps: int = 60,
    step_seconds: int = 60,
) -> list[list[float]]:
    """Returns `steps` rows of len(FEATURES) floats, oldest first."""
    if temp_max_c <= temp_min_c:
        raise ValueError("temp_max_c must be above temp_min_c")
    ordered = sorted(readings, key=lambda r: r.recorded_at)
    start = now - timedelta(seconds=steps * step_seconds)
    rows: list[list[float]] = []
    last: dict[str, float | None] = {"temperature": None, "humidity": None, "speed": None, "lat": None, "lon": None}
    index = 0
    # Values from before the window seed the carried-forward state.
    while index < len(ordered) and ordered[index].recorded_at < start:
        _remember(last, ordered[index])
        index += 1

    for step in range(steps):
        step_end = start + timedelta(seconds=(step + 1) * step_seconds)
        observed = 0.0
        jump = 0.0
        while index < len(ordered) and ordered[index].recorded_at < step_end:
            _remember(last, ordered[index])
            observed = 1.0
            jump = max(jump, 1.0 if ordered[index].gps_jump else 0.0)
            index += 1

        temperature = last["temperature"]
        temperature_pos = (temperature - temp_min_c) / (temp_max_c - temp_min_c) if temperature is not None else 0.5
        local = step_end.astimezone(SRI_LANKA)
        hour = local.hour + local.minute / 60
        minutes_to_eta = (
            _clip((expected_delivery_at - step_end).total_seconds() / 60 / 120, -1.0, 1.0) if expected_delivery_at else 0.0
        )
        km = (
            _clip(haversine_km(last["lat"], last["lon"], destination[0], destination[1]) / 50, 0.0, 1.0)
            if destination and last["lat"] is not None
            else 0.0
        )
        rows.append(
            [
                temperature_pos,
                (last["humidity"] if last["humidity"] is not None else 50.0) / 100,
                (last["speed"] if last["speed"] is not None else 0.0) / 100,
                math.sin(2 * math.pi * hour / 24),
                math.cos(2 * math.pi * hour / 24),
                minutes_to_eta,
                km,
                jump,
                observed,
            ]
        )
    return rows


def _remember(last: dict, reading: Reading) -> None:
    if reading.temperature_c is not None:
        last["temperature"] = reading.temperature_c
    if reading.humidity_pct is not None:
        last["humidity"] = reading.humidity_pct
    if reading.speed_kmh is not None:
        last["speed"] = reading.speed_kmh
    if reading.latitude is not None and reading.longitude is not None and not reading.gps_jump:
        last["lat"], last["lon"] = reading.latitude, reading.longitude


def excursion_label(future: list[Reading], *, temp_min_c: float, temp_max_c: float) -> int:
    """Training target: 1 if any reading in the horizon after the window left the range."""
    return int(any(r.temperature_c is not None and not (temp_min_c <= r.temperature_c <= temp_max_c) for r in future))
