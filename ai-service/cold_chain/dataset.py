"""Training samples from an export of backend/scripts/export-cold-chain-dataset.js.

  load_export        trips.csv + readings.csv + manifest.json -> TripRecords
  temperature_windows  CNN-LSTM sequences + excursion labels for one trip
  delay_snapshots    delay-model features + the trip's delay label

Every sample skipped is counted with its reason; nothing is filled in.
Personal data is not part of the export, and driver/truck identities are not
features. Pure Python: training/build_dataset.py writes the arrays.
"""

from __future__ import annotations

import csv
import json
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from .labels import DelayLabelConfig, ExcursionLabelConfig, delivery_delay_label, temperature_excursion_label
from .preprocessing import CleaningReport, GridConfig, Reading, TripContext, build_grid, clean_readings, delay_features, parse_time, sequence_at


@dataclass(frozen=True)
class WindowConfig:
    steps: int = 30  # sequence length (grid steps)
    stride_steps: int = 5  # a window every 5 steps
    min_history_steps: int = 10  # first window after 10 steps of the trip
    # Share of the window's in-trip steps that must contain a reading.
    min_input_coverage: float = 0.5

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class SnapshotConfig:
    stride_steps: int = 10
    min_history_steps: int = 10

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TripRecord:
    shipment_id: str
    shipment_number: str
    is_test: bool
    storage_condition: str
    trip_status: str
    context: TripContext
    delivered_at: datetime | None
    eta_source: str
    eta_changed_after_start: bool
    readings: list[Reading] = field(default_factory=list)

    @property
    def end(self) -> datetime | None:
        """Delivery time, or the last reading of a trip still in transit."""
        if self.delivered_at:
            return self.delivered_at
        return max((r.recorded_at for r in self.readings), default=None)


@dataclass
class Sample:
    shipment_id: str
    time: datetime
    features: list
    label: int


def _float(value: str) -> float | None:
    return float(value) if value not in ("", None) else None


def _bool(value: str) -> bool:
    return str(value).lower() in ("true", "t", "1")


def _point(lat: str, lon: str) -> tuple[float, float] | None:
    return (float(lat), float(lon)) if lat not in ("", None) and lon not in ("", None) else None


def load_export(directory: Path) -> tuple[dict, list[TripRecord], int]:
    """(manifest, trips ordered by start, readings of unknown trips)."""
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    trips: dict[str, TripRecord] = {}
    with (directory / "trips.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            trips[row["shipment_id"]] = TripRecord(
                shipment_id=row["shipment_id"],
                shipment_number=row["shipment_number"],
                is_test=_bool(row["is_test"]),
                storage_condition=row["storage_condition"],
                trip_status=row["trip_status"],
                context=TripContext(
                    temp_min_c=float(row["temp_min_c"]),
                    temp_max_c=float(row["temp_max_c"]),
                    started_at=parse_time(row["trip_started_at"]),
                    # The planned time when the trip started: a later edit must not leak the outcome.
                    expected_delivery_at=parse_time(row["expected_delivery_at_start"]),
                    destination=_point(row["destination_latitude"], row["destination_longitude"]),
                    origin=_point(row["origin_latitude"], row["origin_longitude"]),
                ),
                delivered_at=parse_time(row["delivered_at"]),
                eta_source=row["eta_source"],
                eta_changed_after_start=_bool(row["eta_changed_after_start"]),
            )
    unknown = 0
    with (directory / "readings.csv").open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            trip = trips.get(row["shipment_id"])
            if trip is None:
                unknown += 1
                continue
            trip.readings.append(
                Reading(
                    parse_time(row["recorded_at"]),
                    _float(row["temperature_c"]),
                    _float(row["humidity_pct"]),
                    _float(row["latitude"]),
                    _float(row["longitude"]),
                    _float(row["speed_kmh"]),
                    "gps_jump" in row["quality_flags"].split("|"),
                )
            )
    return manifest, sorted(trips.values(), key=lambda t: (t.context.started_at, t.shipment_id)), unknown


def prepare_trip(trip: TripRecord, grid_config: GridConfig) -> tuple[list[Reading], list[dict], CleaningReport]:
    """Cleaned readings of the trip period and its feature grid."""
    end = trip.end
    readings, report = clean_readings(trip.readings, start=trip.context.started_at, end=end)
    grid = build_grid(readings, trip.context, until=end, config=grid_config) if end else []
    return readings, grid, report


def window_skip_reason(grid: list[dict], index: int, window: WindowConfig) -> str | None:
    """Why the CNN-LSTM/baseline input ending at grid step `index` is not
    used, or None. The same rules hold in training and in the AI service, so
    the models are only asked about the kind of input they were trained on."""
    if index < window.min_history_steps - 1:
        return "trip_too_short"
    if grid[index]["temperature_c"] is None:
        return "no_temperature_yet"
    in_window = grid[max(0, index - window.steps + 1) : index + 1]
    if sum(r["observed"] for r in in_window) / len(in_window) < window.min_input_coverage:
        return "sparse_input"
    return None


def snapshot_skip_reason(grid: list[dict], index: int, trip: TripContext, snapshot: SnapshotConfig) -> str | None:
    """Why the delay snapshot at grid step `index` is not used, or None (same
    rules in training and in the AI service)."""
    if index < snapshot.min_history_steps - 1:
        return "trip_too_short"
    if trip.expected_delivery_at is None:
        return "no_planned_delivery_time"
    if trip.expected_delivery_at <= trip.started_at:
        return "planned_delivery_before_start"
    if grid[index]["_time"] >= trip.expected_delivery_at:
        return "past_planned_delivery_time"
    return None


def temperature_windows(
    trip: TripRecord,
    readings: list[Reading],
    grid: list[dict],
    window: WindowConfig,
    labels: ExcursionLabelConfig,
) -> tuple[list[Sample], Counter]:
    samples: list[Sample] = []
    skipped: Counter = Counter()
    if not readings:
        skipped["trip_without_readings"] += 1
        return samples, skipped
    if len(grid) < window.min_history_steps:
        skipped["trip_too_short"] += 1
        return samples, skipped
    for index in range(window.min_history_steps - 1, len(grid), window.stride_steps):
        row = grid[index]
        reason = window_skip_reason(grid, index, window)
        if reason:
            skipped[reason] += 1
            continue
        label, reason = temperature_excursion_label(
            readings,
            now=row["_time"],
            trip_end=trip.end,
            temp_min_c=trip.context.temp_min_c,
            temp_max_c=trip.context.temp_max_c,
            config=labels,
        )
        if label is None:
            skipped[reason] += 1
            continue
        samples.append(Sample(trip.shipment_id, row["_time"], sequence_at(grid, index, window.steps), label))
    return samples, skipped


def delay_snapshots(trip: TripRecord, grid: list[dict], snapshot: SnapshotConfig, labels: DelayLabelConfig) -> tuple[list[Sample], Counter]:
    """Snapshots while the trip is in transit and before its planned delivery
    time (after it, "late" is already known and predicting it is trivial)."""
    skipped: Counter = Counter()
    label, reason = delivery_delay_label(delivered_at=trip.delivered_at, expected_delivery_at=trip.context.expected_delivery_at, config=labels)
    if label is None:
        skipped[reason] += 1
        return [], skipped
    if trip.context.expected_delivery_at <= trip.context.started_at:
        skipped["planned_delivery_before_start"] += 1
        return [], skipped
    if len(grid) < snapshot.min_history_steps:
        skipped["trip_too_short"] += 1
        return [], skipped
    samples = [
        Sample(trip.shipment_id, grid[index]["_time"], delay_features(grid, index, trip.context), label)
        for index in range(snapshot.min_history_steps - 1, len(grid), snapshot.stride_steps)
        if grid[index]["_time"] < trip.delivered_at and snapshot_skip_reason(grid, index, trip.context, snapshot) is None
    ]
    if not samples:
        skipped["no_snapshot_before_planned_delivery"] += 1
    return samples, skipped
